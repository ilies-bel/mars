import { resolve } from 'node:path'
import { resolveContext } from '../context'

export interface SweeperPaths {
  pidFile: string
  logFile: string
}

export const sweeperPaths = (): SweeperPaths => {
  const ctx = resolveContext()
  return {
    pidFile: resolve(ctx.stateDir, 'sweeper.pid'),
    logFile: resolve(ctx.stateDir, 'sweeper.log'),
  }
}
