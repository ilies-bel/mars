/**
 * `mars doctor` — preflight checks for runtime prerequisites.
 *
 * Runs six checks and prints PASS/WARN/FAIL lines. Exits non-zero on any
 * FAIL. WARN items are informational (soft dependencies or auto-starting
 * services). All I/O is through CommandDeps sinks.
 *
 * The check logic lives in `runDoctorChecks(probes, pgDsnPath)` so tests can
 * inject a stubbed `DoctorProbes` without spawning real binaries or touching
 * a real daemon.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

// ---------------------------------------------------------------------------
// Public types (exported for tests)
// ---------------------------------------------------------------------------

export interface CheckResult {
  label: string
  status: 'PASS' | 'WARN' | 'FAIL'
  message: string
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
}

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
 */
export const runDoctorChecks = async (
  probes: DoctorProbes,
  pgDsnPath: string | null,
  providerProbeDeps: ProviderProbeDeps = realProviderProbeDeps,
  selectedProvider: ProviderName = 'claude',
): Promise<CheckResult[]> => {
  const results: CheckResult[] = []

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
      message: `selected provider not found on PATH (install: ${probeProvider(selectedProvider, providerProbeDeps).installHint})`,
    })
  } else if (providerCode !== 0) {
    results.push({
      label: `${selectedProvider} worker CLI`,
      status: 'FAIL',
      message: `found but '${providerBin} --version' exited ${providerCode} — check the selected provider installation`,
    })
  } else if (
    selectedProvider === 'codex' &&
    probes.tryRun(providerBin, ['login', 'status']) !== 0
  ) {
    results.push({
      label: 'codex worker CLI',
      status: 'FAIL',
      message: "not authenticated for worker runs — run 'codex login'",
    })
  } else {
    results.push({
      label: `${selectedProvider} worker CLI`,
      status: 'PASS',
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
          message: 'Codex auth.json contains an access token',
        }
      : {
          label: 'chat credentials',
          status: 'FAIL',
          message: 'Codex auth.json is missing or invalid — run codex login',
        },
  )

  // 3. git — hard dependency.
  const gitCode = probes.tryRun('git', ['--version'])
  if (gitCode === null) {
    results.push({ label: 'git', status: 'FAIL', message: 'not found on PATH' })
  } else {
    results.push({ label: 'git', status: 'PASS', message: 'found' })
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
      message: `${probes.nodeVersion} — requires >=22.13.0`,
    })
  } else {
    results.push({ label: 'Node.js', status: 'PASS', message: probes.nodeVersion })
  }

  // 5. codegraph — soft dependency (ADR-0062); WARN-only if absent.
  const codegraphCode = probes.tryRun('codegraph', ['--version'])
  if (codegraphCode === null) {
    results.push({
      label: 'codegraph',
      status: 'WARN',
      message: 'not found — optional code-intelligence features unavailable (ADR-0062)',
    })
  } else {
    results.push({ label: 'codegraph', status: 'PASS', message: 'found' })
  }

  // 6. Daemon status — WARN if not running (auto-starts on first task add);
  //    WARN if running but stale (dev install drifted from HEAD).
  const dl = await probes.daemonLiveness()
  if (!dl.alive) {
    results.push({
      label: 'daemon',
      status: 'WARN',
      message: `not running (${dl.reason ?? 'no-pid'}) — will auto-start on first use`,
    })
  } else if (dl.isStale && dl.sourceSha && dl.currentSha) {
    const src = dl.sourceSha.slice(0, 7)
    const cur = dl.currentSha.slice(0, 7)
    results.push({
      label: 'daemon',
      status: 'WARN',
      message: `stale: running ${src}, HEAD is ${cur} — run 'mars daemon restart'`,
    })
  } else {
    results.push({
      label: 'daemon',
      status: 'PASS',
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
        message: `no DSN published at ${pgDsnPath} — the daemon provisions the embedded PostgreSQL server; run 'mars daemon start'`,
      })
    } else {
      results.push({
        label: 'database',
        status: 'PASS',
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
        message: `not installed — optional alternative worker provider (install: ${probe.installHint})`,
      })
    } else if (probe.authed === 'yes') {
      results.push({
        label: `${name} worker CLI`,
        status: 'PASS',
        message: `found and logged in (${probe.authDetail})`,
      })
    } else {
      results.push({
        label: `${name} worker CLI`,
        status: 'WARN',
        message: 'installed but auth status unknown — run the CLI once to authenticate',
      })
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
    )
    let hasFail = false
    for (const r of results) {
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
