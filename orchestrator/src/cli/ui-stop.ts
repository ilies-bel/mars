import { unlinkSync } from 'node:fs'
import type { UiPidEntry } from './ui'

export type StopResult =
  | { kind: 'not-running' }
  | { kind: 'stopped'; pid: number; port: number }

export interface StopDeps {
  isAlive: (pid: number) => boolean
  sendSignal: (pid: number, signal: NodeJS.Signals) => void
  removePidFile: (path: string) => void
  gracePeriodMs: number
  pollIntervalMs: number
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
  removePidFile: (path: string): void => {
    unlinkSync(path)
  },
  gracePeriodMs: STOP_GRACE_PERIOD_MS,
  pollIntervalMs: STOP_POLL_INTERVAL_MS,
})

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stop the UI process described by `entry`.
 *
 * Algorithm:
 *   1. If entry is null or the PID is no longer alive, clean up any stale
 *      pidfile and return `{ kind: 'not-running' }`.
 *   2. Send SIGTERM.
 *   3. Poll until the process exits or the grace period elapses.
 *   4. If the process is still alive after the grace period, send SIGKILL.
 *   5. Remove the pidfile (it may have already been removed by the server
 *      itself) and return `{ kind: 'stopped', pid, port }`.
 */
export const stopProcess = async (
  entry: UiPidEntry | null,
  pidFile: string,
  deps: StopDeps,
): Promise<StopResult> => {
  if (!entry || !deps.isAlive(entry.pid)) {
    try {
      deps.removePidFile(pidFile)
    } catch {
      // already gone — ignore
    }
    return { kind: 'not-running' }
  }

  deps.sendSignal(entry.pid, 'SIGTERM')

  const deadline = Date.now() + deps.gracePeriodMs
  while (deps.isAlive(entry.pid) && Date.now() < deadline) {
    await sleep(deps.pollIntervalMs)
  }

  if (deps.isAlive(entry.pid)) {
    try {
      deps.sendSignal(entry.pid, 'SIGKILL')
    } catch {
      // already gone — ignore
    }
  }

  try {
    deps.removePidFile(pidFile)
  } catch {
    // already gone — ignore
  }

  return { kind: 'stopped', pid: entry.pid, port: entry.port }
}
