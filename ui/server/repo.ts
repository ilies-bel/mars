import { execFileSync } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { findProject } from '../../orchestrator/src/registry/projects.ts'

export interface RepoContext {
  repoRoot: string
  stateDir: string
  queueDbPath: string
  stateDbPath: string
}

/** Thrown when a caller passes a projectId that is not in the project registry. */
export class UnknownProjectError extends Error {
  constructor(projectId: string) {
    super(`unknown project: ${projectId}`)
    this.name = 'UnknownProjectError'
  }
}

const detectRepoRoot = (start: string): string => {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: start,
    encoding: 'utf8',
  }).trim()
}

const WORKTREES_SEGMENT = `${sep}.mars${sep}worktrees${sep}`

/**
 * A task worktree (`<repo>/.mars/worktrees/<id>`) is never a valid state dir:
 * the daemon only publishes `http.port` in the main checkout. Walk up past it.
 */
export const stripWorktreePath = (repoRoot: string): string => {
  const idx = repoRoot.indexOf(WORKTREES_SEGMENT)
  return idx === -1 ? repoRoot : repoRoot.slice(0, idx)
}

const makeContext = (rawRoot: string): RepoContext => {
  const repoRoot = stripWorktreePath(rawRoot)
  if (repoRoot !== rawRoot) {
    console.warn(`mars-ui: repo ${rawRoot} is a task worktree; using ${repoRoot}`)
  }
  // Never create `.mars/` here: a missing state dir must be diagnosed, not populated.
  const stateDir = resolve(repoRoot, '.mars')
  // Tasks (`queueDbPath`) and proposals/actionQueue (`stateDbPath`) now share a
  // single `.mars/mars.db` file (see ADR-0034), matching the orchestrator's
  // `context.ts`. Both names resolve to the same path so the UI's TaskDb /
  // StateDb seams stay distinct while reading one file.
  const dbPath = resolve(stateDir, 'mars.db')
  return { repoRoot, stateDir, queueDbPath: dbPath, stateDbPath: dbPath }
}

export function resolveRepo(override?: string): RepoContext
export function resolveRepo(opts: { projectId?: string; override?: string }): RepoContext
export function resolveRepo(
  arg?: string | { projectId?: string; override?: string },
): RepoContext {
  if (arg !== undefined && typeof arg === 'object') {
    if (arg.projectId !== undefined) {
      const entry = findProject(arg.projectId)
      if (!entry) throw new UnknownProjectError(arg.projectId)
      return makeContext(entry.repoRoot)
    }
    return resolveRepo(arg.override)
  }
  const explicit = (arg as string | undefined) ?? process.env.MARS_REPO
  const repoRoot = explicit ? resolve(explicit) : detectRepoRoot(process.cwd())
  return makeContext(repoRoot)
}
