import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { isProcessAlive, resolveLaunchCommand } from '../daemon/paths'
import { resolveContext } from '../context'
import { sweeperPaths } from './paths'

const readPid = (pidFile: string): number | null => {
  if (!existsSync(pidFile)) return null
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const reclaimStale = (): void => {
  const { pidFile } = sweeperPaths()
  const pid = readPid(pidFile)
  if (pid !== null && isProcessAlive(pid)) return
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile)
    } catch {
      // best-effort
    }
  }
}

/**
 * Idempotent: returns immediately if a live sweeper PID is recorded.
 * Otherwise spawns a detached `mars sweeper` child and returns. Does not
 * wait for the child to finish booting — the sweep loop is best-effort and
 * will heal again on the next CLI write op.
 */
export const ensureSweeperRunning = (): void => {
  reclaimStale()
  const { pidFile } = sweeperPaths()
  if (readPid(pidFile) !== null) return

  const ctx = resolveContext()
  const { command, baseArgs } = resolveLaunchCommand()
  const child = spawn(command, [...baseArgs, '--repo', ctx.repoRoot, 'sweeper'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MARS_REPO: ctx.repoRoot },
  })
  child.unref()
}
