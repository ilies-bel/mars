import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContext } from '../context'

export interface DaemonPaths {
  socket: string
  pidFile: string
  logFile: string
}

export const daemonPaths = (): DaemonPaths => {
  const ctx = resolveContext()
  return {
    socket: resolve(ctx.stateDir, 'watch.sock'),
    pidFile: resolve(ctx.stateDir, 'watch.pid'),
    logFile: resolve(ctx.stateDir, 'watch.log'),
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
