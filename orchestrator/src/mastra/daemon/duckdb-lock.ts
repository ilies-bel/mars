import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isProcessAlive } from './paths'

export interface DuckDBLockProbe {
  status: 'free' | 'stale' | 'held'
  holderPid: number | null
}

const lsofHolders = (path: string): number[] => {
  if (!existsSync(path)) return []
  try {
    const out = execFileSync('lsof', ['-tF', 'p', '--', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('p'))
      .map((line) => Number.parseInt(line.slice(1), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

export const probeDuckDBLock = (
  dbPath: string,
  selfPid: number = process.pid,
): DuckDBLockProbe => {
  const holders = lsofHolders(dbPath).filter((pid) => pid !== selfPid)
  if (holders.length === 0) return { status: 'free', holderPid: null }
  const live = holders.find((pid) => isProcessAlive(pid))
  if (live === undefined) return { status: 'stale', holderPid: holders[0] }
  return { status: 'held', holderPid: live }
}
