import { spawnSync } from 'node:child_process'
import { isAbsolute, join, dirname } from 'node:path'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getRepoRoot } from '../../context'
import type { TraceCtx } from '../run-tool'
import { exec, execProbe } from '../subprocess'
import { FALLBACK_CLAUDE_PATH_DIRS, isExecutableFile } from '../executable-resolve'

// Re-export subprocess utilities so all existing lib/git/ consumers continue to
// import from this file without changes.
export { exec, execProbe, TaskBranchAtRootError } from '../subprocess'
export type { TraceCtx } from '../run-tool'
export { FALLBACK_CLAUDE_PATH_DIRS, isExecutableFile } from '../executable-resolve'

// Hard timeout for git worktree list/prune calls. A corrupt .git/worktrees
// directory with many admin entries can make 'git worktree list --porcelain'
// and 'git worktree prune' hang indefinitely, which consumed every implement
// semaphore slot and stalled dispatch for hours (observed 2026-05-17 with
// ~353 corrupt entries). The timeout ensures these calls fail fast so
// createWorktree's .catch handlers can recover and dispatch proceeds.
// Override via MARS_WORKTREE_GIT_TIMEOUT_MS.
export const WORKTREE_GIT_TIMEOUT_MS = Number(
  process.env.MARS_WORKTREE_GIT_TIMEOUT_MS ?? 10_000,
)

export const repoRoot = (): string => getRepoRoot()
export const moduleDir = (): string => dirname(fileURLToPath(import.meta.url))

// Resolve the main checkout root for a worker `cwd`. A dispatched worker runs
// inside a worktree (`.mars/worktrees/<id>/`), but codegraph's index lives in
// the MAIN checkout's `.codegraph/` (built once over the integration branch).
// `git rev-parse --git-common-dir` from a worktree points at the main repo's
// `.git`; its parent is the main checkout root that holds `.codegraph/`.
// Falls back to `cwd` when git resolution fails (non-git dir, missing git) so
// the caller still gets a usable path rather than throwing.
//
// Lives here, in the shared git internals, rather than in one of its two
// callers: it is a plain `git rev-parse` question, and both the CodeIndex
// Port's codegraph implementation (`../../ports/code-index/codegraph.ts`) and
// the Executor Port's agent wrapper (`./claude.ts`) need the answer. Keeping
// it in either one would force the other Port to import across a seam it has
// no business reaching through.
export const resolveCodegraphRoot = (cwd: string): string => {
  try {
    const res = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
    )
    if (res.status === 0) {
      const commonDir = res.stdout.trim()
      // .../<repo>/.git -> .../<repo>; a bare or detached layout that does not
      // end in `.git` is left to its own parent, which is still the repo root.
      if (commonDir.length > 0) return dirname(commonDir)
    }
  } catch {
    // git absent or spawn failed — fall through to cwd.
  }
  return cwd
}

// Portable filesystem-level existence check. Replaces a prior shell-out to
// `test -e <path>`, which is POSIX-only and would break on Windows where
// `/bin/test` does not exist. `fs.access(p, F_OK)` resolves when any
// directory entry (regular file, directory, symlink, fifo, socket, …)
// is present at `p`, and rejects on ENOENT / ENOTDIR, matching the
// semantics callers relied on for the previous `test -e` invocation.
// Exported for unit-testing on every host OS.
export const pathExists = async (p: string): Promise<boolean> => {
  if (typeof p !== 'string' || p.length === 0) return false
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

// Cache for the resolved git binary path. Keyed on process.env.PATH so
// tests can change PATH and get a fresh resolution without restarting the
// process. In production PATH is stable so the cache is effectively permanent.
let cachedGitBin: string | null = null
let cachedGitBinFor: string | undefined = undefined

/**
 * Resolve the absolute path to the `git` binary, caching the result.
 *
 * Searches PATH dirs then the POSIX fallback dirs (same set used for claude).
 * Throws `Error('git binary not found on PATH')` if git cannot be located.
 * Called once at daemon boot so that any PATH problem surfaces immediately
 * rather than as a per-task ENOENT mid-flight.
 */
export const resolveGitBin = (): string => {
  const envFingerprint = process.env.PATH ?? ''
  if (cachedGitBin !== null && cachedGitBinFor === envFingerprint) {
    return cachedGitBin
  }
  cachedGitBinFor = envFingerprint
  cachedGitBin = null

  const isWindows = process.platform === 'win32'
  const pathDelimiter = isWindows ? ';' : ':'
  const binaryNames = isWindows ? ['git.exe'] : ['git']
  // POSIX-only fallback directories — not applicable on Windows.
  const fallbackDirs = isWindows ? [] : FALLBACK_CLAUDE_PATH_DIRS

  const pathDirs = (process.env.PATH ?? '').split(pathDelimiter).filter((p) => p.length > 0)
  const seen = new Set<string>()
  for (const dir of [...pathDirs, ...fallbackDirs]) {
    if (seen.has(dir)) continue
    seen.add(dir)
    if (!isAbsolute(dir)) continue
    for (const name of binaryNames) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) {
        cachedGitBin = candidate
        return candidate
      }
    }
  }

  throw new Error('git binary not found on PATH')
}

interface RegisteredWorktree {
  path: string
  branch: string | null
}

export const listRegisteredWorktrees = async (
  traceCtx?: TraceCtx,
): Promise<RegisteredWorktree[]> => {
  const { stdout } = await exec(
    resolveGitBin(),
    ['worktree', 'list', '--porcelain'],
    {
      cwd: repoRoot(),
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    },
    traceCtx,
  )
  const entries: RegisteredWorktree[] = []
  let current: { path?: string; branch?: string | null } = {}
  const flush = (): void => {
    if (current.path) {
      entries.push({ path: current.path, branch: current.branch ?? null })
    }
    current = {}
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref
    } else if (line.startsWith('detached')) {
      current.branch = null
    } else if (line.length === 0) {
      flush()
    }
  }
  flush()
  return entries
}

export const branchExists = async (
  branch: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  // `git show-ref --verify --quiet` returns non-zero when the ref is missing.
  // That's a probe, not an error, so mark expectsFailure on the trace.
  const r = await execProbe(
    resolveGitBin(),
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: repoRoot() },
    traceCtx,
  )
  return r.exitCode === 0
}

export type { RegisteredWorktree }
