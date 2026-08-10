/**
 * `mars doctor` — preflight checks for runtime prerequisites.
 *
 * Runs two groups of checks and prints PASS/WARN/FAIL lines. Exits non-zero
 * on any FAIL. WARN items are informational (soft dependencies or auto-starting
 * services). All I/O is through CommandDeps sinks.
 *
 * **Tools** — binary/credential checks (provider CLI, git, Node.js, …)
 * **Health** — system-state checks (baseline typecheck, disk, load, config)
 *
 * The check logic lives in `runDoctorChecks(probes, pgDsnPath)` so tests can
 * inject a stubbed `DoctorProbes` without spawning real binaries or touching
 * a real daemon.
 */

import { cpus, loadavg } from 'node:os'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Command } from '../command'
import {
  probeProvider,
  realProviderProbeDeps,
  type ProviderProbeDeps,
} from './provider-probe'
import { loadDaemonConfig } from '../../core/daemon/config'
import { resolveCodexAuthFilePath } from '../../core/daemon/codex-api'
import {
  resolveProviderName,
} from '../../core/workers/providers'
import type { ProviderName } from '../../core/workers/provider-types'
import { loadLeverRegistry } from '../../core/lib/lever-registry'

// ---------------------------------------------------------------------------
// Public types (exported for tests)
// ---------------------------------------------------------------------------

export interface CheckResult {
  label: string
  status: 'PASS' | 'WARN' | 'FAIL'
  message: string
  /**
   * Display section: 'tools' for binary/credential checks, 'health' for
   * system-state checks. Results without a section render at the top level.
   */
  section?: 'tools' | 'health'
}

/** A verify gate spec sufficient for the baseline health check. */
export interface BaselineGateSpec {
  name: string
  cmd: string
  args: string[]
  /** Repo-relative directory to run in. '.' means the repo root. */
  dir: string
}

/**
 * Injectable probes for doctor checks. Production code passes `realProbes`;
 * tests pass a stub that controls every external observable.
 */
export interface DoctorProbes {
  /**
   * Attempt to run `cmd args`. Returns the exit code on success, or `null`
   * when the binary is not found (ENOENT).
   */
  tryRun(cmd: string, args: readonly string[]): number | null
  /**
   * The Node.js version string (e.g. 'v22.13.0'). Injected so tests can
   * simulate old runtimes without spinning up a new process.
   */
  nodeVersion: string
  /**
   * Daemon liveness — wraps `isDaemonAlive()` and, when the daemon is up,
   * fetches `{ op: 'status' }` to surface the stale-dev-install warning.
   */
  daemonLiveness(): Promise<{
    alive: boolean
    pid?: number
    reason?: string
    isStale?: boolean
    sourceSha?: string | null
    currentSha?: string | null
  }>
  /** Whether `path` exists and is readable. */
  fileReadable(path: string): boolean
  /** Read a UTF-8 text file, or return null when it cannot be read. */
  readTextFile(path: string): string | null
  /**
   * Load the task-tier required verify gate specs for the baseline health
   * check. Returns null when the DB is unavailable (daemon not started).
   * Returns [] when the DB is accessible but no task-tier gates are
   * configured.
   */
  baselineGates(): Promise<BaselineGateSpec[] | null>
  /**
   * Run a verify gate command synchronously. Returns pass/fail and the first
   * 500 characters of combined stdout+stderr.
   */
  runGate(cmd: string, args: readonly string[], cwd: string): { passed: boolean; output: string }
  /**
   * Free bytes available on the filesystem at `path`. Returns null when the
   * measurement is unavailable (e.g., an unsupported platform or missing
   * path).
   */
  freeDiskBytes(path: string): number | null
  /**
   * System load average (1-minute window) and logical CPU count.
   * Returns null when the measurement is unavailable.
   */
  systemLoad(): { loadAvg1: number; cpuCount: number } | null
}

// ---------------------------------------------------------------------------
// Real probes — wired at runtime by the `doctor` command
// ---------------------------------------------------------------------------

export const realProbes: DoctorProbes = {
  tryRun(cmd, args) {
    const result = spawnSync(cmd, [...args], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
    }
    // spawnSync returns status=null when the process was killed by a signal
    // or couldn't be started; treat that as "not found" (null) too.
    return result.status ?? null
  },
  nodeVersion: process.version,
  async daemonLiveness() {
    const { isDaemonAlive } = await import('../../core/daemon/paths')
    const liveness = await isDaemonAlive()
    if (!liveness.alive) {
      return { alive: false, reason: liveness.reason }
    }
    try {
      const { sendRequest } = await import('../../core/daemon/client')
      const data = (await sendRequest({ op: 'status' })) as {
        pid?: number
        isStale?: boolean
        sourceSha?: string | null
        currentSha?: string | null
      }
      return {
        alive: true,
        pid: data.pid ?? liveness.pid,
        isStale: data.isStale,
        sourceSha: data.sourceSha ?? null,
        currentSha: data.currentSha ?? null,
      }
    } catch {
      // Daemon is alive but status RPC failed — report alive without stale info.
      return { alive: true, pid: liveness.pid }
    }
  },
  fileReadable(path) {
    return existsSync(path)
  },
  readTextFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  async baselineGates() {
    // Race the DB query against a 3-second timeout.  In production the DB is
    // already warm and this resolves in milliseconds.  In test environments a
    // fresh module reset can trigger a PGlite cold-start (5-25 s); returning
    // null in that case degrades gracefully to a WARN rather than blocking the
    // entire doctor command for tens of seconds.
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 3_000),
    )
    try {
      return await Promise.race([
        (async () => {
          const { listVerifyGates } = await import('../../core/verify-gates')
          const gates = await listVerifyGates()
          return gates
            .filter((g) => g.state === 'active' && g.tier === 'task' && g.required)
            .map((g) => ({ name: g.name, cmd: g.cmd, args: g.args, dir: g.scope }))
        })(),
        timeout,
      ])
    } catch {
      return null
    }
  },
  runGate(cmd, args, cwd) {
    const result = spawnSync(cmd, [...args], {
      cwd,
      stdio: 'pipe',
      timeout: 120_000,
    })
    const raw = [
      result.stdout?.toString() ?? '',
      result.stderr?.toString() ?? '',
    ]
      .join('')
      .slice(0, 500)
    const passed = result.status === 0 && result.error === undefined
    return { passed, output: raw }
  },
  freeDiskBytes(path) {
    try {
      const stats = statfsSync(path)
      return stats.bavail * stats.bsize
    } catch {
      return null
    }
  },
  systemLoad() {
    try {
      const [avg1 = 0] = loadavg()
      const cpuCount = cpus().length
      if (cpuCount === 0) return null
      return { loadAvg1: avg1, cpuCount }
    } catch {
      return null
    }
  },
}

// ---------------------------------------------------------------------------
// Known top-level keys in daemon.json — anything outside this set is an orphan.
// ---------------------------------------------------------------------------

const KNOWN_DAEMON_CONFIG_KEYS = new Set([
  'caps',
  'selfEvolve',
  'scoring',
  'defaultProvider',
  'controlLevers',
  'lastReflectRanAt',
  'levers',
  'workerPrompts',
  'paused',
])

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

/**
 * Run all doctor checks and return the results. Pass `pgDsnPath = null` to
 * skip the database check (e.g. when called from `mars init` before the
 * daemon has ever provisioned the embedded PostgreSQL server).
 *
 * `providerProbeDeps` is optional and defaults to real system calls; tests
 * pass a stub to control binary/auth detection without spawning real CLIs.
 *
 * `repoRoot` is optional; when provided, the health checks (baseline typecheck,
 * disk, config coherence) use it. When null, those checks are either skipped
 * or degrade gracefully.
 */
export const runDoctorChecks = async (
  probes: DoctorProbes,
  pgDsnPath: string | null,
  providerProbeDeps: ProviderProbeDeps = realProviderProbeDeps,
  selectedProvider: ProviderName = 'claude',
  repoRoot: string | null = null,
): Promise<CheckResult[]> => {
  const results: CheckResult[] = []

  // ── Tools ──────────────────────────────────────────────────────────────

  // 1. Selected provider CLI — hard dependency; must be installed, runnable,
  // and (for Codex, whose status command is authoritative) authenticated for
  // worker runs.
  const binEnvKey = `MARS_${selectedProvider.toUpperCase()}_BIN`
  const providerBin = providerProbeDeps.env[binEnvKey] ?? selectedProvider
  const providerCode = probes.tryRun(providerBin, ['--version'])
  if (providerCode === null) {
    results.push({
      label: `${selectedProvider} worker CLI`,
      status: 'FAIL',
      section: 'tools',
      message: `selected provider not found on PATH (install: ${probeProvider(selectedProvider, providerProbeDeps).installHint})`,
    })
  } else if (providerCode !== 0) {
    results.push({
      label: `${selectedProvider} worker CLI`,
      status: 'FAIL',
      section: 'tools',
      message: `found but '${providerBin} --version' exited ${providerCode} — check the selected provider installation`,
    })
  } else if (
    selectedProvider === 'codex' &&
    probes.tryRun(providerBin, ['login', 'status']) !== 0
  ) {
    results.push({
      label: 'codex worker CLI',
      status: 'FAIL',
      section: 'tools',
      message: "not authenticated for worker runs — run 'codex login'",
    })
  } else {
    results.push({
      label: `${selectedProvider} worker CLI`,
      status: 'PASS',
      section: 'tools',
      message:
        selectedProvider === 'codex'
          ? 'found and authenticated for worker runs'
          : 'found and runnable',
    })
  }

  // 2. Chat credentials are independent of the selected worker provider.
  const authPath = resolveCodexAuthFilePath(
    providerProbeDeps.env,
    providerProbeDeps.homeDir,
  )
  const authText = probes.readTextFile(authPath)
  let hasChatCredentials = false
  if (authText !== null) {
    try {
      const parsed = JSON.parse(authText) as { tokens?: { access_token?: unknown } }
      hasChatCredentials =
        typeof parsed.tokens?.access_token === 'string' &&
        parsed.tokens.access_token.length > 0
    } catch {
      // The result below deliberately reports no credential contents.
    }
  }
  results.push(
    hasChatCredentials
      ? {
          label: 'chat credentials',
          status: 'PASS',
          section: 'tools',
          message: 'Codex auth.json contains an access token',
        }
      : {
          label: 'chat credentials',
          status: 'FAIL',
          section: 'tools',
          message: 'Codex auth.json is missing or invalid — run codex login',
        },
  )

  // 3. git — hard dependency.
  const gitCode = probes.tryRun('git', ['--version'])
  if (gitCode === null) {
    results.push({ label: 'git', status: 'FAIL', section: 'tools', message: 'not found on PATH' })
  } else {
    results.push({ label: 'git', status: 'PASS', section: 'tools', message: 'found' })
  }

  // 4. Node.js version — must be >= 22.13.0.
  const rawVer = probes.nodeVersion.replace(/^v/, '')
  const [majStr, minStr = '0', patStr = '0'] = rawVer.split('.')
  const maj = Number.parseInt(majStr ?? '0', 10)
  const min = Number.parseInt(minStr, 10)
  const pat = Number.parseInt(patStr, 10)
  const nodeOk =
    maj > 22 ||
    (maj === 22 && min > 13) ||
    (maj === 22 && min === 13 && pat >= 0)
  if (!nodeOk) {
    results.push({
      label: 'Node.js',
      status: 'FAIL',
      section: 'tools',
      message: `${probes.nodeVersion} — requires >=22.13.0`,
    })
  } else {
    results.push({ label: 'Node.js', status: 'PASS', section: 'tools', message: probes.nodeVersion })
  }

  // 5. codegraph — soft dependency (ADR-0062); WARN-only if absent.
  const codegraphCode = probes.tryRun('codegraph', ['--version'])
  if (codegraphCode === null) {
    results.push({
      label: 'codegraph',
      status: 'WARN',
      section: 'tools',
      message: 'not found — optional code-intelligence features unavailable (ADR-0062)',
    })
  } else {
    results.push({ label: 'codegraph', status: 'PASS', section: 'tools', message: 'found' })
  }

  // 6. Daemon status — WARN if not running (auto-starts on first task add);
  //    WARN if running but stale (dev install drifted from HEAD).
  const dl = await probes.daemonLiveness()
  if (!dl.alive) {
    results.push({
      label: 'daemon',
      status: 'WARN',
      section: 'tools',
      message: `not running (${dl.reason ?? 'no-pid'}) — will auto-start on first use`,
    })
  } else if (dl.isStale && dl.sourceSha && dl.currentSha) {
    const src = dl.sourceSha.slice(0, 7)
    const cur = dl.currentSha.slice(0, 7)
    results.push({
      label: 'daemon',
      status: 'WARN',
      section: 'tools',
      message: `stale: running ${src}, HEAD is ${cur} — run 'mars daemon restart'`,
    })
  } else {
    results.push({
      label: 'daemon',
      status: 'PASS',
      section: 'tools',
      message: `running (pid ${dl.pid ?? '?'})`,
    })
  }

  // 7. database — the daemon provisions the embedded PostgreSQL server and
  //    publishes its DSN to `.mars/pg.dsn`; WARN when the DSN is not
  //    published (daemon down / repo never started). Skip entirely when
  //    pgDsnPath is null (called from init).
  if (pgDsnPath !== null) {
    if (!probes.fileReadable(pgDsnPath)) {
      results.push({
        label: 'database',
        status: 'WARN',
        section: 'tools',
        message: `no DSN published at ${pgDsnPath} — the daemon provisions the embedded PostgreSQL server; run 'mars daemon start'`,
      })
    } else {
      results.push({
        label: 'database',
        status: 'PASS',
        section: 'tools',
        message: `embedded PostgreSQL DSN published at ${pgDsnPath}`,
      })
    }
  }

  // 8–9. Non-selected agent CLIs are WARN-only alternatives.
  for (const name of ['claude', 'gemini', 'codex'] as const) {
    if (name === selectedProvider) continue
    const probe = probeProvider(name, providerProbeDeps)
    if (!probe.installed) {
      results.push({
        label: `${name} worker CLI`,
        status: 'WARN',
        section: 'tools',
        message: `not installed — optional alternative worker provider (install: ${probe.installHint})`,
      })
    } else if (probe.authed === 'yes') {
      results.push({
        label: `${name} worker CLI`,
        status: 'PASS',
        section: 'tools',
        message: `found and logged in (${probe.authDetail})`,
      })
    } else {
      results.push({
        label: `${name} worker CLI`,
        status: 'WARN',
        section: 'tools',
        message: 'installed but auth status unknown — run the CLI once to authenticate',
      })
    }
  }

  // ── Health ─────────────────────────────────────────────────────────────

  // H1. Baseline verify: run task-tier required gates against the integration branch.
  const gates = await probes.baselineGates()
  if (gates === null) {
    results.push({
      label: 'baseline',
      status: 'WARN',
      section: 'health',
      message: "verify gates unavailable (DB not running) — run 'mars daemon start' to enable baseline health check",
    })
  } else if (gates.length === 0) {
    results.push({
      label: 'baseline',
      status: 'WARN',
      section: 'health',
      message: "no task-tier verify gates configured — run 'mars verify-gate detect' to add gates",
    })
  } else if (repoRoot === null) {
    results.push({
      label: 'baseline',
      status: 'WARN',
      section: 'health',
      message: 'baseline health check skipped (no repo root available)',
    })
  } else {
    for (const gate of gates) {
      const cwd = gate.dir === '.' ? repoRoot : resolve(repoRoot, gate.dir)
      // Include the scope in the label when it is not the repo root so that
      // same-named gates at different scopes (e.g. typecheck in orchestrator/
      // vs ui/) produce distinct, readable output lines.
      const gateLabel = gate.dir === '.' ? gate.name : `${gate.name} (${gate.dir})`
      const result = probes.runGate(gate.cmd, gate.args, cwd)
      if (!result.passed) {
        results.push({
          label: `baseline: ${gateLabel}`,
          status: 'FAIL',
          section: 'health',
          message: `integration branch fails ${gateLabel} — run '${gate.cmd}${gate.args.length > 0 ? ' ' + gate.args.join(' ') : ''}' in '${gate.dir}' to reproduce`,
        })
      } else {
        results.push({
          label: `baseline: ${gateLabel}`,
          status: 'PASS',
          section: 'health',
          message: `${gateLabel} passes on integration branch`,
        })
      }
    }
  }

  // H2. Disk capacity — check the worktree volume.
  const diskPath = repoRoot ?? (pgDsnPath !== null ? dirname(pgDsnPath) : null)
  if (diskPath !== null) {
    const diskBytes = probes.freeDiskBytes(diskPath)
    if (diskBytes !== null) {
      const gib = diskBytes / 1073741824 // 1024^3
      if (gib < 1) {
        results.push({
          label: 'disk',
          status: 'FAIL',
          section: 'health',
          message: `${gib.toFixed(1)} GiB free on worktree volume — remove stale worktrees: run 'mars worktree reclaim' to identify, then 'mars purge <id>'`,
        })
      } else if (gib < 5) {
        results.push({
          label: 'disk',
          status: 'WARN',
          section: 'health',
          message: `${gib.toFixed(1)} GiB free on worktree volume — low, consider running 'mars worktree reclaim'`,
        })
      } else {
        results.push({
          label: 'disk',
          status: 'PASS',
          section: 'health',
          message: `${gib.toFixed(1)} GiB free`,
        })
      }
    }
  }

  // H3. System load — warn when load-per-core is elevated.
  const load = probes.systemLoad()
  if (load !== null) {
    const perCore = load.loadAvg1 / load.cpuCount
    if (perCore > 8) {
      results.push({
        label: 'load',
        status: 'FAIL',
        section: 'health',
        message: `load average ${load.loadAvg1.toFixed(1)} on ${load.cpuCount} cores (${perCore.toFixed(1)}× per core) — high load causes verify timeouts`,
      })
    } else if (perCore > 4) {
      results.push({
        label: 'load',
        status: 'WARN',
        section: 'health',
        message: `load average ${load.loadAvg1.toFixed(1)} on ${load.cpuCount} cores (${perCore.toFixed(1)}× per core) — elevated`,
      })
    } else {
      results.push({
        label: 'load',
        status: 'PASS',
        section: 'health',
        message: `load average ${load.loadAvg1.toFixed(1)} on ${load.cpuCount} cores`,
      })
    }
  }

  // H4. Config coherence: defaultProvider vs worker registry.
  // The registry entries that pin an explicit provider should agree with
  // daemon.json's defaultProvider, or operators see inconsistent behaviour.
  if (repoRoot !== null) {
    const dcPath = resolve(repoRoot, '.mars', 'daemon.json')
    const registryPath = resolve(repoRoot, '.mars', 'worker-registry.json')
    const dcText = probes.readTextFile(dcPath)
    const regText = probes.readTextFile(registryPath)
    if (dcText !== null && regText !== null) {
      try {
        const dc = JSON.parse(dcText) as Record<string, unknown>
        const defaultProvider = typeof dc.defaultProvider === 'string'
          ? dc.defaultProvider
          : 'codex' // default when absent
        const registry = JSON.parse(regText) as Record<string, Record<string, unknown>>
        const pinned = Object.values(registry)
          .filter((w) => typeof w.provider === 'string' && w.provider !== defaultProvider)
          .map((w) => String(w.provider))
        const uniquePinned = [...new Set(pinned)]
        if (uniquePinned.length > 0) {
          // Read the authoritative gesture from the lever registry rather than
          // hardcoding it here (which drifted before and named a non-existent command).
          const providerLever = loadLeverRegistry().find((e) => e.id === 'provider.default')
          // Build an actionable gesture: substitute the first pinned value into the
          // <claude|codex|gemini> placeholder so the operator can copy-paste it.
          const alignDaemonGesture = providerLever?.gesture
            ? providerLever.gesture.replace('<claude|codex|gemini>', uniquePinned[0]!)
            : '(see: mars lever show provider.default)'
          results.push({
            label: 'config: provider',
            status: 'FAIL',
            section: 'health',
            message:
              `defaultProvider='${defaultProvider}' in daemon.json but ${pinned.length} worker(s) pin provider='${uniquePinned.join("', '")}' in worker-registry.json — ` +
              `to align daemon.json with the registry: ${alignDaemonGesture}; ` +
              `to re-seed the registry to '${defaultProvider}': no command exists, update worker pins manually`,
          })
        } else {
          results.push({
            label: 'config: provider',
            status: 'PASS',
            section: 'health',
            message: `defaultProvider '${defaultProvider}' agrees with worker registry`,
          })
        }
      } catch {
        // Malformed JSON — skip the check silently.
      }
    }
  }

  // H5. Unknown top-level keys in daemon.json — orphans accumulate silently.
  if (repoRoot !== null) {
    const dcPath = resolve(repoRoot, '.mars', 'daemon.json')
    const dcText = probes.readTextFile(dcPath)
    if (dcText !== null) {
      try {
        const dc = JSON.parse(dcText) as Record<string, unknown>
        const orphans = Object.keys(dc).filter((k) => !KNOWN_DAEMON_CONFIG_KEYS.has(k))
        if (orphans.length > 0) {
          results.push({
            label: 'config: daemon.json keys',
            status: 'WARN',
            section: 'health',
            message: `unknown top-level key(s) in daemon.json: ${orphans.map((k) => `'${k}'`).join(', ')} — these are orphaned and can be removed manually`,
          })
        }
      } catch {
        // Malformed daemon.json — skip silently (the 'config: provider' check above
        // would also fail to parse, so this is already surfaced there).
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const doctor: Command = {
  path: 'doctor',
  summary: 'preflight check: verify runtime prerequisites',
  usage: 'usage: mars doctor',
  run: async (_args, deps) => {
    const selectedProvider = resolveProviderName(
      process.env.MARS_WORKER_PROVIDER ?? loadDaemonConfig().defaultProvider,
    )
    const results = await runDoctorChecks(
      realProbes,
      resolve(deps.ctx.stateDir, 'pg.dsn'),
      realProviderProbeDeps,
      selectedProvider,
      deps.ctx.repoRoot,
    )

    let hasFail = false
    let lastSection: string | undefined = undefined
    for (const r of results) {
      // Emit a section header when the section changes.
      if (r.section !== lastSection) {
        if (r.section === 'tools') {
          deps.out('\n── Tools ─────────────────────────────────────────')
        } else if (r.section === 'health') {
          deps.out('\n── Health ────────────────────────────────────────')
        }
        lastSection = r.section
      }
      const line = `${r.status.padEnd(4)} ${r.label}: ${r.message}`
      if (r.status === 'FAIL') {
        hasFail = true
        deps.err(line)
      } else {
        deps.out(line)
      }
    }
    return { code: hasFail ? 1 : 0 }
  },
}

export const doctorCommands: readonly Command[] = [doctor]
