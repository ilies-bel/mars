import { unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
  /**
   * Return the PIDs of every process currently listening on the given TCP port.
   * Uses `lsof -tiTCP:<port> -sTCP:LISTEN`.  Returns [] when lsof is
   * unavailable or finds no listeners.
   */
  findPortListeners: (port: number) => number[]
  /**
   * Send a signal to the entire process group of `pid` (negative-pid kill).
   * Falls back to a direct pid kill when the group kill is rejected by the OS.
   */
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void
  /**
   * Resolve to true when no process is listening on the port.
   */
  isPortFree: (port: number) => Promise<boolean>
}

/** Grace period before escalating from SIGTERM to SIGKILL (ms). */
export const STOP_GRACE_PERIOD_MS = 2000
/** How often to poll for process exit during the grace period (ms). */
export const STOP_POLL_INTERVAL_MS = 100

/** Build a StopDeps that delegates to the real OS process-control APIs. */
export const makeOsStopDeps = (): StopDeps => {
  const findPortListeners = (port: number): number[] => {
    try {
      const out = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n))
    } catch {
      // lsof exits non-zero when no listeners found, or when lsof is absent
      return []
    }
  }

  return {
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
    findPortListeners,
    killProcessGroup: (pid: number, signal: NodeJS.Signals): void => {
      try {
        // negative pid = signal the entire process group (bun + any children)
        process.kill(-pid, signal)
      } catch {
        // pgid kill rejected (pid is not a group leader) — fall back to direct
        try {
          process.kill(pid, signal)
        } catch {
          /* already gone */
        }
      }
    },
    isPortFree: async (port: number): Promise<boolean> => {
      return findPortListeners(port).length === 0
    },
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stop the UI process described by `entry`.
 *
 * Algorithm:
 *   1. If entry is null, clean up any stale pidfile and return
 *      `{ kind: 'not-running' }`.
 *   2. Resolve actual port listener(s) via lsof.  If neither the recorded pid
 *      nor any port listener is alive, return `{ kind: 'not-running' }`.
 *   3. Send SIGTERM to every port-listener process group, then to the
 *      recorded pid (handles the orphaned-bun scenario where the wrapper was
 *      already killed but bun kept the port open).
 *   4. Poll until both the recorded pid has exited AND the port is free, or
 *      the grace period elapses.
 *   5. Escalate to SIGKILL for any survivors (recorded pid + remaining
 *      port listeners).
 *   6. Remove the pidfile and return `{ kind: 'stopped', pid, port }`.
 */
export const stopProcess = async (
  entry: UiPidEntry | null,
  pidFile: string,
  deps: StopDeps,
): Promise<StopResult> => {
  // Phase 0: discovery — find the real port listener (may differ from the
  // recorded pid when the wrapper was killed but bun kept running).
  const portListeners = entry ? deps.findPortListeners(entry.port) : []
  const recordedAlive = entry ? deps.isAlive(entry.pid) : false

  if (!entry || (!recordedAlive && portListeners.length === 0)) {
    try {
      deps.removePidFile(pidFile)
    } catch {
      // already gone — ignore
    }
    return { kind: 'not-running' }
  }

  // Phase 1: SIGTERM — kill port listeners by process group first, then the
  // recorded pid.  Both may be the same process (happy path) or different
  // (orphaned-bun scenario).
  for (const pid of portListeners) {
    try {
      deps.killProcessGroup(pid, 'SIGTERM')
    } catch {
      // already gone — ignore
    }
  }
  if (recordedAlive) {
    deps.sendSignal(entry.pid, 'SIGTERM')
  }

  // Phase 2: poll until the recorded pid has exited, all port listeners are
  // gone, AND the port is free.  Tracking listeners explicitly ensures we
  // wait for process exit even when the port is freed before the process
  // table entry is reaped (common race on fast-exit paths).
  const deadline = Date.now() + deps.gracePeriodMs
  while (Date.now() < deadline) {
    const recStillAlive = recordedAlive && deps.isAlive(entry.pid)
    const listenersStillAlive = portListeners.some((pid) => deps.isAlive(pid))
    const portStillBusy = !(await deps.isPortFree(entry.port))
    if (!recStillAlive && !listenersStillAlive && !portStillBusy) break
    await sleep(deps.pollIntervalMs)
  }

  // Phase 3: SIGKILL escalation for any survivors.
  if (deps.isAlive(entry.pid)) {
    try {
      deps.sendSignal(entry.pid, 'SIGKILL')
    } catch {
      // already gone — ignore
    }
  }
  const remainingListeners = deps.findPortListeners(entry.port)
  for (const pid of remainingListeners) {
    try {
      deps.killProcessGroup(pid, 'SIGKILL')
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
