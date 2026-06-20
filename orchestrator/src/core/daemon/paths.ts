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

export const daemonPaths = (repo?: string): DaemonPaths => {
  const ctx = resolveContext(repo)
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

/**
 * Why the daemon is not reachable.
 *
 * - `no-pid`        – neither socket nor pid file found; daemon was never
 *                     started or shut down cleanly.
 * - `dead-pid`      – pid file found but the process is gone and the socket
 *                     is missing; partial cleanup after an unclean exit.
 * - `no-socket`     – pid file found and process is still alive, but the
 *                     socket file has disappeared; rare, indicates the socket
 *                     was externally removed while the process ran.
 * - `connect-failed` – socket file exists but the connection was refused or
 *                     errored; the daemon crashed and left a stale socket.
 */
export type DaemonLivenessReason = 'no-pid' | 'dead-pid' | 'no-socket' | 'connect-failed'
export type DaemonLiveness = { alive: true; pid: number } | { alive: false; reason: DaemonLivenessReason }

/**
 * Shared liveness check for `mars daemon`.
 *
 * Returns `{ alive: true, pid }` when the daemon socket is connectable (the
 * daemon is healthy). The pid comes from the pid file; 0 is used as a
 * sentinel when the pid file is absent.
 *
 * When the socket is not connectable, stale files are cleaned up and
 * `{ alive: false, reason }` is returned with a reason that explains why:
 * - `connect-failed`: socket file present but connection refused/errored.
 * - `dead-pid`:       no socket, but a pid file whose process is gone.
 * - `no-socket`:      no socket, but a pid file whose process is still alive
 *                     (rare; socket externally removed).
 * - `no-pid`:         neither socket nor pid file present (clean state).
 */
export const isDaemonAlive = async (repo?: string): Promise<DaemonLiveness> => {
  const { socket, pidFile } = daemonPaths(repo)

  if (existsSync(socket)) {
    // Socket file present — attempt a connection.
    const connected = await tryConnectSocket(socket)
    if (connected) {
      const pid = readDaemonPid(pidFile) ?? 0
      return { alive: true, pid }
    }
    // Stale socket (exists but dead) — clean up both files.
    for (const f of [socket, pidFile]) {
      if (existsSync(f)) {
        try {
          unlinkSync(f)
        } catch {
          // best-effort; ignore races with concurrent cleanup
        }
      }
    }
    return { alive: false, reason: 'connect-failed' }
  }

  // No socket file — consult the pid file for additional context.
  const pid = readDaemonPid(pidFile)
  if (pid === null) {
    return { alive: false, reason: 'no-pid' }
  }
  if (isProcessAlive(pid)) {
    // Process alive but socket gone — unusual; leave pid file intact.
    return { alive: false, reason: 'no-socket' }
  }
  // Process dead and socket already gone — clean up the stale pid file.
  try {
    unlinkSync(pidFile)
  } catch {
    // best-effort
  }
  return { alive: false, reason: 'dead-pid' }
}

/**
 * Probe whether the daemon's HTTP API is reachable by opening a short-timeout
 * TCP connection to 127.0.0.1:<port> using the port recorded in the http.port
 * state file.
 *
 * Returns false when:
 * - the http.port file is absent (daemon was never started or cleaned up)
 * - the file content is not a valid port number
 * - the TCP connection is refused or times out (stale port file after crash)
 *
 * A stale http.port file — left behind after an unclean daemon exit — is
 * correctly detected as unreachable because we open an actual TCP connection
 * rather than checking file existence alone.
 */
export const isDaemonReachable = async (stateDir: string): Promise<boolean> => {
  const httpPortFile = resolve(stateDir, 'http.port')
  if (!existsSync(httpPortFile)) return false
  let port: number
  try {
    const raw = readFileSync(httpPortFile, 'utf8').trim()
    port = Number.parseInt(raw, 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false
  } catch {
    return false
  }
  return new Promise((resolveFn) => {
    const TIMEOUT_MS = 1000
    const sock = createConnection(port, '127.0.0.1')
    const timer = setTimeout(() => {
      sock.destroy()
      resolveFn(false)
    }, TIMEOUT_MS)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.end()
      resolveFn(true)
    })
    sock.once('error', () => {
      clearTimeout(timer)
      resolveFn(false)
    })
  })
}
