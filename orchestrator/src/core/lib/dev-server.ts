/**
 * Preview dev-server manager — the long-running-process half of the
 * human-in-the-loop validation gate (the awaiting-validation status /
 * action-queue kind).
 *
 * This module owns the spawn / kill / liveness primitives for live dev server
 * management. It is used by `behaviourVerify` and the arc-level E2E pass.
 *
 * Design notes
 * ------------
 * - The server is spawned DETACHED in its own process group (`detached: true`)
 *   so it survives the workflow run returning (the gate is a workflow boundary,
 *   not an in-process pause) yet can be reaped as a group via `process.kill(-pid)`.
 *   That matters because `npm run dev` forks a child (vite/astro) — killing only
 *   the `npm` pid would orphan the real server.
 * - We persist only `{ url, pid }` on the task row (see queue.ts columns). This
 *   module is stateless: validate/reject and the startup reconciler kill purely
 *   by pid, so everything works identically before and after a daemon restart.
 * - A free port is allocated by binding `:0` and reading back the OS-assigned
 *   port, then injected as `PORT` (Vite, Astro, Next, CRA all honour it). The
 *   tiny TOCTOU window between releasing the probe socket and the dev server
 *   binding is acceptable for a single-operator local tool.
 * - stdout/stderr are redirected to `.mars/dev-servers/<taskId>.log` so the
 *   detached process never blocks on a full pipe and the operator can tail it.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export interface DevServerHandle {
  /** OS process id of the detached dev-server process group leader. */
  pid: number
  /** Loopback URL the operator opens to preview the change. */
  url: string
  /** Absolute path to the captured stdout/stderr log. */
  logPath: string
  /** Allocated port the command was told to listen on (via PORT env). */
  port: number
}

export interface StartDevServerOptions {
  /** The exact preview command, e.g. `npm run dev`. Run via `sh -c`. */
  command: string
  /** Working directory — the task's worktree (or a resolved subproject). */
  cwd: string
  /** Task id; used to name the log file. */
  taskId: string
  /**
   * Directory for per-task dev-server logs (typically `<stateDir>/dev-servers`).
   * Created if missing.
   */
  logDir: string
  /** Extra env merged over `process.env` (PORT is always injected). */
  env?: Record<string, string>
}

/** Find a free TCP port by binding to :0 on loopback and reading it back. */
export const allocatePort = (): Promise<number> =>
  new Promise<number>((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('failed to allocate a free port')))
        return
      }
      const { port } = addr
      srv.close(() => resolvePort(port))
    })
  })

/**
 * Start the preview command as a detached, process-group-leading dev server.
 * Resolves once the process has been spawned (NOT once it is serving — the gate
 * is human-driven, so "is it up yet?" is the operator's call). Rejects only if
 * the spawn itself fails synchronously.
 */
export const startDevServer = async (
  opts: StartDevServerOptions,
): Promise<DevServerHandle> => {
  const port = await allocatePort()
  const url = `http://127.0.0.1:${port}`

  mkdirSync(opts.logDir, { recursive: true })
  const logPath = resolve(opts.logDir, `${opts.taskId}.log`)
  mkdirSync(dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'a')

  try {
    const child = spawn('sh', ['-c', opts.command], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        ...opts.env,
        // Inject the allocated port; dev servers that read PORT will bind here.
        PORT: String(port),
      },
      // Own process group so we can group-kill the whole tree later.
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })

    // Let the parent exit independently of the child — the dev server must
    // outlive the workflow run that started it.
    child.unref()

    if (child.pid === undefined) {
      throw new Error(`dev server failed to spawn: ${opts.command}`)
    }

    return { pid: child.pid, url, logPath, port }
  } finally {
    // The child has inherited the fd; the parent no longer needs it.
    closeSync(logFd)
  }
}

/** True if a process with `pid` is currently alive (signal-0 probe). */
export const isDevServerAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const SIGKILL_GRACE_MS = 3_000

/**
 * Terminate a dev server (and its whole process group) started by
 * {@link startDevServer}. Sends SIGTERM to the group, then SIGKILL after a
 * grace period if anything survives. Tolerant of an already-dead process
 * (ESRCH) so Validate/Reject and the startup reconciler are idempotent.
 *
 * Returns a promise that resolves once the grace timer has fired (or
 * immediately if the process was already gone), so callers can await a clean
 * teardown before transitioning task state.
 */
export const killDevServer = async (pid: number | null): Promise<void> => {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return
  // Negative pid targets the whole process group (the leader plus its forked
  // children, e.g. npm → vite). Fall back to the bare pid if the group send
  // fails (the child may not have become a group leader on some platforms).
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return
      try {
        process.kill(pid, signal)
      } catch {
        // best-effort
      }
    }
  }

  if (!isDevServerAlive(pid)) return
  signalGroup('SIGTERM')

  await new Promise<void>((resolveKill) => {
    const timer = setTimeout(() => {
      if (isDevServerAlive(pid)) signalGroup('SIGKILL')
      resolveKill()
    }, SIGKILL_GRACE_MS)
    // Don't keep the daemon event loop alive purely for this grace timer.
    timer.unref?.()
  })
}
