import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

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

/**
 * Resolve the repo root from a cwd inside any git working tree.
 *
 * Plain `git rev-parse --show-toplevel` returns the *worktree* root,
 * which for a linked worktree under `.mars/worktrees/<id>` is the
 * worktree itself — not the real repo. That is exactly the situation
 * dispatched coders run in: cwd = `<repo>/.mars/worktrees/<id>` (the
 * worker keeps spawn cwd at the worktree root so Mars CLI commands
 * resolve `repoRoot()` correctly, per `lib/resolve-task-cwd.ts`).
 *
 * To recover the real repo root from inside a linked worktree, we ask
 * git for `--git-common-dir`. For the primary worktree this is the same
 * `.git` directory as `--show-toplevel` implies, so `dirname` of it
 * matches the toplevel — no-op. For a linked worktree it points at
 * `<real-repo>/.git`, so `dirname` is the real repo root.
 *
 * A path-shape sanity check ("does the toplevel sit inside
 * `.../.mars/worktrees/<id>`?") is layered on as a defensive fallback
 * for environments where `--git-common-dir` is unavailable or returns
 * something unexpected.
 */
const detectRepoRoot = (start: string): string => {
  let topLevel: string
  try {
    topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      encoding: 'utf8',
    }).trim()
  } catch {
    throw new Error(
      `Not inside a git repository: ${start}\nUse --repo <path> or run from inside a git repo.`,
    )
  }

  // Primary path: ask git for the shared git dir. For a linked worktree
  // this resolves to the real repo's `.git`, regardless of layout.
  try {
    const gitCommonDir = execFileSync(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: start, encoding: 'utf8' },
    ).trim()
    if (gitCommonDir) {
      const absCommonDir = isAbsolute(gitCommonDir)
        ? gitCommonDir
        : resolve(start, gitCommonDir)
      const realRoot = dirname(absCommonDir)
      if (realRoot && realRoot !== topLevel) {
        return realRoot
      }
    }
  } catch {
    // fall through to path-shape fallback
  }

  // Defensive fallback: if the toplevel sits inside the Mars layout
  // `.../.mars/worktrees/<id>`, strip back to the path before
  // `.mars/worktrees`. Only used if --git-common-dir didn't already
  // identify a different real root.
  const marsSegment = `${sep}.mars${sep}worktrees${sep}`
  const idx = topLevel.indexOf(marsSegment)
  if (idx !== -1) {
    return topLevel.slice(0, idx)
  }

  return topLevel
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

/**
 * Test-only: clear the memoized context so a subsequent
 * `resolveContext()` re-detects the repo root from the current cwd.
 * Production code never needs this — the cache is process-wide on
 * purpose.
 */
export const __resetContextCacheForTests = (): void => {
  cached = null
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
