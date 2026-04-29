import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface OrchestratorContext {
  repoRoot: string
  stateDir: string
  queueDbPath: string
  mastraDbPath: string
}

const detectRepoRoot = (start: string): string => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf8',
    }).trim()
  } catch {
    throw new Error(
      `Not inside a git repository: ${start}\nUse --repo <path> or run from inside a git repo.`,
    )
  }
}

let cached: OrchestratorContext | null = null

export const resolveContext = (override?: string): OrchestratorContext => {
  if (cached && !override) return cached

  const explicit = override ?? process.env.MARS_ORCH_REPO
  const repoRoot = explicit ? resolve(explicit) : detectRepoRoot(process.cwd())
  const stateDir = resolve(repoRoot, '.mars')
  mkdirSync(stateDir, { recursive: true })

  cached = {
    repoRoot,
    stateDir,
    queueDbPath: resolve(stateDir, 'queue.db'),
    mastraDbPath: resolve(stateDir, 'mastra.db'),
  }
  return cached
}

export const getRepoRoot = (): string => resolveContext().repoRoot
export const getStateDir = (): string => resolveContext().stateDir
