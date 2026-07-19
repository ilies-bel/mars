/**
 * `mars doctor` — preflight checks for runtime prerequisites.
 *
 * Runs six checks and prints PASS/WARN/FAIL lines. Exits non-zero on any
 * FAIL. WARN items are informational (soft dependencies or auto-starting
 * services). All I/O is through CommandDeps sinks.
 *
 * The check logic lives in `runDoctorChecks(probes, dbPath)` so tests can
 * inject a stubbed `DoctorProbes` without spawning real binaries or touching
 * a real daemon.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Command } from '../command'
import {
  probeProvider,
  realProviderProbeDeps,
  type ProviderProbeDeps,
} from './provider-probe'

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
}

// ---------------------------------------------------------------------------
// Core check logic
// ---------------------------------------------------------------------------

/**
 * Run all doctor checks and return the results. Pass `dbPath = null` to skip
 * the mars.db presence check (e.g. when called from `mars init` before the
 * DB exists).
 *
 * `providerProbeDeps` is optional and defaults to real system calls; tests
 * pass a stub to control binary/auth detection without spawning real CLIs.
 */
export const runDoctorChecks = async (
  probes: DoctorProbes,
  dbPath: string | null,
  providerProbeDeps: ProviderProbeDeps = realProviderProbeDeps,
): Promise<CheckResult[]> => {
  const results: CheckResult[] = []

  // 1. claude CLI — hard dependency; must be on PATH and runnable.
  const claudeCode = probes.tryRun('claude', ['--version'])
  if (claudeCode === null) {
    results.push({
      label: 'claude CLI',
      status: 'FAIL',
      message: 'not found on PATH — install Claude Code from https://claude.ai/code',
    })
  } else if (claudeCode !== 0) {
    results.push({
      label: 'claude CLI',
      status: 'FAIL',
      message: `found but 'claude --version' exited ${claudeCode} — check your Claude Code installation`,
    })
  } else {
    results.push({ label: 'claude CLI', status: 'PASS', message: 'found and runnable' })
  }

  // 2. git — hard dependency.
  const gitCode = probes.tryRun('git', ['--version'])
  if (gitCode === null) {
    results.push({ label: 'git', status: 'FAIL', message: 'not found on PATH' })
  } else {
    results.push({ label: 'git', status: 'PASS', message: 'found' })
  }

  // 3. Node.js version — must be >= 22.13.0.
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

  // 4. codegraph — soft dependency (ADR-0062); WARN-only if absent.
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

  // 5. Daemon status — WARN if not running (auto-starts on first task add);
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

  // 6. mars.db — WARN if absent (run `mars init`); FAIL if present but
  //    unreadable. Skip entirely when dbPath is null (called from init).
  if (dbPath !== null) {
    if (!probes.fileReadable(dbPath)) {
      results.push({
        label: 'mars.db',
        status: 'WARN',
        message: `not found at ${dbPath} — run 'mars init' to create it`,
      })
    } else {
      results.push({ label: 'mars.db', status: 'PASS', message: `found at ${dbPath}` })
    }
  }

  // 7–8. Alternative agent CLIs — WARN-only (optional; gemini and codex
  //      complement Claude Code but are not required for Mars to operate).
  for (const name of ['gemini', 'codex'] as const) {
    const probe = probeProvider(name, providerProbeDeps)
    if (!probe.installed) {
      results.push({
        label: `${name} CLI`,
        status: 'WARN',
        message: `not installed — optional alternative agent provider (install: ${probe.installHint})`,
      })
    } else if (probe.authed === 'yes') {
      results.push({
        label: `${name} CLI`,
        status: 'PASS',
        message: `found and logged in (${probe.authDetail})`,
      })
    } else {
      results.push({
        label: `${name} CLI`,
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
    const results = await runDoctorChecks(realProbes, deps.ctx.queueDbPath)
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
