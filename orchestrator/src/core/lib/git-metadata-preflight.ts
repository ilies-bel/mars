/**
 * Daemon startup pre-flight: is the repo's git metadata directory writable?
 *
 * ## The incident this exists for
 *
 * The daemon was once started from a shell whose sandbox permitted writes to
 * worktree FILES under `.mars/worktrees/<id>/` but DENIED writes to the shared
 * `<repo>/.git/worktrees/<id>/` metadata directory — a completely different
 * filesystem location. Every Codex coder therefore edited files and ran tests
 * successfully and then failed at the commit gate with:
 *
 *   Git cannot create '.git/worktrees/<id>/index.lock': Operation not permitted
 *
 * That happened 79 times. Each run burned a full context and produced nothing,
 * and every failure was bucketed as the generic `code/unclassified`, which then
 * tripped the storm breaker and paused the queue.
 *
 * The probe below is deliberately a REAL write (create + remove a temp file),
 * not an `access(W_OK)` check: sandbox denials are enforced at the syscall that
 * mutates, and `access()` reports the permission bits rather than the sandbox
 * policy, so it returns "writable" in exactly the situation this guards.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export interface GitMetadataProbe {
  writable: boolean
  /** The directory that was probed. */
  probedPath: string
  /** errno code when the probe failed (`EPERM`, `EACCES`, `EROFS`, …). */
  code: string | null
  /** Operator-facing line. Empty when writable. */
  message: string
}

/**
 * Resolve the repo's git metadata directory. `<repo>/.git` is a directory in a
 * normal checkout and a `gitdir: <path>` pointer file inside a linked worktree.
 */
export const resolveGitDir = (repoRoot: string): string | null => {
  const dotGit = join(repoRoot, '.git')
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) return dotGit
  if (!st.isFile()) return null
  try {
    const pointer = readFileSync(dotGit, 'utf8').trim()
    const m = pointer.match(/^gitdir:\s*(.+)$/m)
    if (!m) return null
    const target = m[1].trim()
    return isAbsolute(target) ? target : resolve(repoRoot, target)
  } catch {
    return null
  }
}

/**
 * Attempt a real write into `<gitdir>/worktrees/` (the exact directory git
 * needs for `index.lock` when committing inside a linked worktree), creating it
 * when absent. Returns a structured verdict; never throws.
 */
export const checkGitMetadataWritable = (repoRoot: string): GitMetadataProbe => {
  const gitDir = resolveGitDir(repoRoot)
  if (gitDir === null) {
    const probedPath = join(repoRoot, '.git')
    return {
      writable: false,
      probedPath,
      code: 'ENOENT',
      message:
        `[preflight] cannot resolve the git metadata directory for ${repoRoot} ` +
        `(${probedPath} is missing or unreadable); refusing to start`,
    }
  }

  // `<gitdir>/worktrees/` is where git writes per-worktree admin files,
  // including the index.lock that failed in the incident. Probe it directly.
  const probedPath = join(gitDir, 'worktrees')
  const probeFile = join(
    probedPath,
    `.mars-preflight-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`,
  )
  try {
    mkdirSync(probedPath, { recursive: true })
    writeFileSync(probeFile, 'mars git-metadata preflight\n')
    rmSync(probeFile, { force: true })
    return { writable: true, probedPath, code: null, message: '' }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    try {
      rmSync(probeFile, { force: true })
    } catch {
      // best effort — the probe file may not exist at all
    }
    return {
      writable: false,
      probedPath,
      code: e.code ?? null,
      message:
        `[preflight] git metadata directory is not writable: ${probedPath} ` +
        `(${e.code ?? 'unknown'}: ${e.message}). Every coder would edit files and ` +
        `run tests fine, then fail at the commit gate with ` +
        `"Git cannot create '.git/worktrees/<id>/index.lock': Operation not permitted". ` +
        `Restart the daemon from a shell whose sandbox permits writes to ${probedPath}, ` +
        `or fix the directory's ownership/permissions. Refusing to start.`,
    }
  }
}
