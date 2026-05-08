import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface RepoContext {
  repoRoot: string
  stateDir: string
  queueDbPath: string
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
  return {
    repoRoot,
    stateDir,
    queueDbPath: resolve(stateDir, 'queue.db'),
  }
}
