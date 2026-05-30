import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface RepoContext {
  repoRoot: string
  stateDir: string
  queueDbPath: string
  stateDbPath: string
}

const detectRepoRoot = (start: string): string => {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: start,
    encoding: 'utf8',
  }).trim()
}

export const resolveRepo = (override?: string): RepoContext => {
  const explicit = override ?? process.env.MARS_REPO
  const repoRoot = explicit
    ? resolve(explicit)
    : detectRepoRoot(process.cwd())
  const stateDir = resolve(repoRoot, '.mars')
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
  // Tasks (`queueDbPath`) and proposals/actionQueue (`stateDbPath`) now share a
  // single `.mars/mars.db` file (see ADR-0034), matching the orchestrator's
  // `context.ts`. Both names resolve to the same path so the UI's TaskDb /
  // StateDb seams stay distinct while reading one file.
  const dbPath = resolve(stateDir, 'mars.db')
  return {
    repoRoot,
    stateDir,
    queueDbPath: dbPath,
    stateDbPath: dbPath,
  }
}
