import { execSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import type { UiPidEntry } from './ui'

export type StopResult =
  | { kind: 'not-running' }
  | { kind: 'stopped'; pid: number; port: number }

export interface StopDeps {
  isAlive: (pid: number) => boolean
  sendSignal: (pid: number, signal: NodeJS.Signals) => void
  /** Signal the entire process group of `pid` (i.e. kill(-pid, signal)). */
  sendSignalToGroup: (pid: number, signal: NodeJS.Signals) => void
  removePidFile: (path: string) => void
  gracePeriodMs: number
  pollIntervalMs: number
  /** HTTP-probe the mars-ui /healthz endpoint; returns true iff it responds with ok:true. */
  probeHealthz: (host: string, port: number) => Promise<boolean>
  /** Return the PIDs of processes listening on `port` (via lsof). */
  pidsOnPort: (port: number) => number[]
}

/** Grace period before escalating from SIGTERM to SIGKILL (ms). */
export const STOP_GRACE_PERIOD_MS = 2000
/** How often to poll for process exit during the grace period (ms). */
export const STOP_POLL_INTERVAL_MS = 100

/** Build a StopDeps that delegates to the real OS process-control APIs. */
export const makeOsStopDeps = (): StopDeps => ({
  isAlive: (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  sendSignal: (pid: number, signal: NodeJS.Signals): void => {
    process.kill(pid, signal)
  },
  sendSignalToGroup: (pid: number, signal: NodeJS.Signals): void => {
    process.kill(-pid, signal)
  },
  removePidFile: (path: string): void => {
    unlinkSync(path)
  },
  gracePeriodMs: STOP_GRACE_PERIOD_MS,
  pollIntervalMs: STOP_POLL_INTERVAL_MS,
  probeHealthz: async (host: string, port: number): Promise<boolean> => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 500)
      const res = await fetch(`http://${host}:${port}/healthz`, {
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return false
      const body = (await res.json()) as Record<string, unknown>
      return body?.ok === true
    } catch {
      return false
    }
  },
  pidsOnPort: (port: number): number[] => {
    try {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
        encoding: 'utf8',
      }).trim()
      if (!out) return []
      return out.split('\n').map(Number).filter((n) => !isNaN(n) && n > 0)
    } catch {
      return []
    }
  },
})

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Send `signal` to the process group of `pid`; fall back to single-PID
 * signal when the group no longer exists (ESRCH = no such process group).
 * Used at four call sites: SIGTERM+SIGKILL for the live-PID path and for
 * the port-reclaim loop.
 */
const signalWithGroupFallback = (
  pid: number,
  signal: NodeJS.Signals,
  deps: StopDeps,
): void => {
  try {
    deps.sendSignalToGroup(pid, signal)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    try {
      deps.sendSignal(pid, signal)
    } catch {
      // already gone — ignore
    }
  }
}

/**
 * Stop the UI process described by `entry`.
 *
 * Algorithm:
 *   1. If entry is null or the PID is no longer alive, probe the recorded
 *      port for a live mars-ui server (port-based reclaim fallback).
 *      - If a mars-ui server answers /healthz, resolve the listening PIDs via
 *        lsof, SIGTERM → grace → SIGKILL the whole process group, remove the
 *        stale pidfile, and return `{ kind: 'stopped' }`.
 *      - Otherwise, clean up any stale pidfile and return `{ kind: 'not-running' }`.
 *   2. Send SIGTERM to the process group (negative pid).
 *   3. Poll until the process exits or the grace period elapses.
 *   4. If the process is still alive after the grace period, send SIGKILL to
 *      the group.
 *   5. Remove the pidfile and return `{ kind: 'stopped', pid, port }`.
 */
export const stopProcess = async (
  entry: UiPidEntry | null,
  pidFile: string,
  deps: StopDeps,
): Promise<StopResult> => {
  if (!entry || !deps.isAlive(entry.pid)) {
    const host = entry?.host ?? '127.0.0.1'
    const port = entry?.port ?? 7777

    if (await deps.probeHealthz(host, port)) {
      const pids = deps.pidsOnPort(port)
      if (pids.length > 0) {
        for (const pid of pids) {
          signalWithGroupFallback(pid, 'SIGTERM', deps)
        }

        const deadline = Date.now() + deps.gracePeriodMs
        while (pids.some((pid) => deps.isAlive(pid)) && Date.now() < deadline) {
          await sleep(deps.pollIntervalMs)
        }

        for (const pid of pids) {
          if (deps.isAlive(pid)) {
            signalWithGroupFallback(pid, 'SIGKILL', deps)
          }
        }

        try {
          deps.removePidFile(pidFile)
        } catch {
          // already gone — ignore
        }
        return { kind: 'stopped', pid: pids[0]!, port }
      }
    }

    try {
      deps.removePidFile(pidFile)
    } catch {
      // already gone — ignore
    }
    return { kind: 'not-running' }
  }

  signalWithGroupFallback(entry.pid, 'SIGTERM', deps)

  const deadline = Date.now() + deps.gracePeriodMs
  while (deps.isAlive(entry.pid) && Date.now() < deadline) {
    await sleep(deps.pollIntervalMs)
  }

  if (deps.isAlive(entry.pid)) {
    signalWithGroupFallback(entry.pid, 'SIGKILL', deps)
  }

  try {
    deps.removePidFile(pidFile)
  } catch {
    // already gone — ignore
  }

  return { kind: 'stopped', pid: entry.pid, port: entry.port }
}
