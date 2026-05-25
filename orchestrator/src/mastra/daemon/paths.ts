import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContext } from '../context'

export interface DaemonPaths {
  socket: string
  pidFile: string
  logFile: string
  /** File that stores the TCP port of the daemon's local HTTP API (one line). */
  httpPortFile: string
}

export const daemonPaths = (): DaemonPaths => {
  const ctx = resolveContext()
  return {
    socket: resolve(ctx.stateDir, 'watch.sock'),
    pidFile: resolve(ctx.stateDir, 'watch.pid'),
    logFile: resolve(ctx.stateDir, 'watch.log'),
    httpPortFile: resolve(ctx.stateDir, 'http.port'),
  }
}

/**
 * Resolve the command + args needed to re-launch the mars CLI in a child
 * process. Prefers the production wrapper `bin/mars.mjs` (Node entry); falls
 * back to invoking the current entry directly (works when the user is running
 * a precompiled bundle).
 */
export const resolveLaunchCommand = (): { command: string; baseArgs: string[] } => {
  const here = dirname(fileURLToPath(import.meta.url))
  const wrapper = resolve(here, '..', '..', '..', 'bin', 'mars.mjs')
  if (existsSync(wrapper)) {
    return { command: process.execPath, baseArgs: [wrapper] }
  }
  const entry = process.argv[1]
  if (!entry) throw new Error('cannot determine mars CLI entry for child spawn')
  return { command: process.execPath, baseArgs: [entry] }
}

export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const tryConnectSocket = async (socketPath: string): Promise<boolean> => {
  if (!existsSync(socketPath)) return false
  return new Promise((resolveFn) => {
    const sock = createConnection(socketPath)
    sock.once('connect', () => {
      sock.end()
      resolveFn(true)
    })
    sock.once('error', () => resolveFn(false))
  })
}

export const readDaemonPid = (pidFile: string): number | null => {
  if (!existsSync(pidFile)) return null
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export type DaemonLiveness = { alive: true; pid: number } | { alive: false }

/**
 * Shared liveness check for `mars daemon`.
 *
 * Returns `{ alive: true, pid }` when the daemon socket is connectable (the
 * daemon is healthy). The pid comes from the pid file; 0 is used as a
 * sentinel when the pid file is absent.
 *
 * When the socket is not connectable (e.g. after a kill -9), any stale
 * socket and pid files are removed so a fresh spawn won't collide, then
 * `{ alive: false }` is returned.
 */
export const isDaemonAlive = async (): Promise<DaemonLiveness> => {
  const { socket, pidFile } = daemonPaths()
  if (await tryConnectSocket(socket)) {
    const pid = readDaemonPid(pidFile) ?? 0
    return { alive: true, pid }
  }
  // Not connectable — clean up any stale files so a fresh spawn can start cleanly.
  for (const f of [socket, pidFile]) {
    if (existsSync(f)) {
      try {
        unlinkSync(f)
      } catch {
        // best-effort; ignore races with concurrent cleanup
      }
    }
  }
  return { alive: false }
}
