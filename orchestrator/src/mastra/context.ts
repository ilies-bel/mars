import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface OrchestratorContext {
  repoRoot: string
  stateDir: string
  queueDbPath: string
  mastraDbPath: string
  observabilityDbPath: string
  stateDbPath: string
  supervisorsDir: string
  supervisorsManifest: string
  verifyConfigPath: string
  cacheDir: string
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

  const explicit = override ?? process.env.MARS_REPO
  const repoRoot = explicit ? resolve(explicit) : detectRepoRoot(process.cwd())
  const stateDir = resolve(repoRoot, '.mars')
  mkdirSync(stateDir, { recursive: true })

  const supervisorsDir = resolve(stateDir, 'supervisors')
  const cacheDir = resolve(stateDir, 'cache', 'sub-agents')

  cached = {
    repoRoot,
    stateDir,
    queueDbPath: resolve(stateDir, 'queue.db'),
    mastraDbPath: resolve(stateDir, 'mastra.db'),
    observabilityDbPath: resolve(stateDir, 'observability.duckdb'),
    stateDbPath: resolve(stateDir, 'state.db'),
    supervisorsDir,
    supervisorsManifest: resolve(supervisorsDir, 'manifest.json'),
    verifyConfigPath: resolve(stateDir, 'verify.json'),
    cacheDir,
  }
  return cached
}

export const getRepoRoot = (): string => resolveContext().repoRoot
export const getStateDir = (): string => resolveContext().stateDir

/**
 * Resolve the repo root using the same precedence as the rest of the
 * orchestrator (`override` > `MARS_REPO` > git toplevel from cwd).
 *
 * Thin alias over `resolveContext(override).repoRoot` that mirrors the
 * `resolveRepo` helper exposed by the UI server in `ui/server/repo.ts`.
 * Use this when you only need the repo root path (e.g. to derive a
 * `.mars/<file>` location) and don't want to pull the full context
 * struct.
 */
export const resolveRepo = (override?: string): string =>
  resolveContext(override).repoRoot
