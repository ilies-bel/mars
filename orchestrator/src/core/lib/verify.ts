import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { exec, resolveGitBin, type TraceCtx } from './git/internal'

/**
 * Validates the health of a task worktree before the verify step runs its
 * diff / typecheck / test sub-checks.
 *
 * Throws with a first-line sentinel (matched by failure-signature.ts rules)
 * for any of three failure modes:
 *
 *   1. Worktree directory is gone       → "worktree path … no longer exists"
 *      (matched by existing `worktree-missing` rule)
 *   2. Wrong branch is checked out      → "verify hygiene: worktree on wrong branch …"
 *      (matched by new `branch-drift` rule)
 *   3. Stale git rebase state present   → "verify hygiene: stale rebase state present at …"
 *      (matched by new `stale-rebase-state` rule)
 *
 * Every thrown message also carries a `drift:` line so operators can see the
 * divergence between the task record and the on-disk state without opening
 * the transcript.
 */
export const assertWorktreeHygieneForVerify = async (
  worktreePath: string,
  branch: string,
  traceCtx?: TraceCtx,
): Promise<void> => {
  // 1. Worktree directory still exists?
  try {
    await stat(worktreePath)
  } catch (err: unknown) {
    if (isEnoent(err)) {
      throw new Error(
        [
          `worktree path ${worktreePath} no longer exists`,
          `drift: recorded=${worktreePath} observed=missing`,
        ].join('\n'),
      )
    }
    throw err
  }

  const git = resolveGitBin()

  // 2. Expected branch is checked out?
  const { stdout: headRaw } = await exec(
    git,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: worktreePath },
    traceCtx,
  )
  const observed = headRaw.trim()
  if (observed !== branch) {
    throw new Error(
      [
        `verify hygiene: worktree on wrong branch, expected ${branch} got ${observed}`,
        `drift: recorded=${worktreePath} observed=wrong-branch:${observed}`,
      ].join('\n'),
    )
  }

  // 3. No stale git rebase state?  (mirrors the isRebaseInProgress check in
  //    merge.ts, which uses `git rev-parse --git-path` to resolve the correct
  //    rebase-state path even inside a linked worktree.)
  //
  // `--git-path` output is only ABSOLUTE inside a linked worktree
  // (`/repo/.git/worktrees/<id>/rebase-merge`). In a plain repo it is
  // RELATIVE — literally `.git/rebase-merge` — and `stat()` would then resolve
  // it against the daemon's process cwd instead of `worktreePath`. That is not
  // hypothetical: the main-committer path verifies with `cwd = repoRoot`, and
  // when the daemon's own cwd holds a `.git` FILE (any linked worktree) the
  // stat raises ENOTDIR rather than ENOENT, which escaped the catch below and
  // failed verify. `verifyChanges` reports a hygiene throw under the step name
  // `has-diff`, so this surfaced as the thoroughly misleading
  // `verify:has-diff failed` on a branch whose diff was never even examined.
  //
  // Resolve against `worktreePath` (a no-op for an already-absolute path), and
  // treat ENOTDIR exactly like ENOENT: both mean "no rebase state here".
  const { stdout: mergePathRaw } = await exec(
    git,
    ['rev-parse', '--git-path', 'rebase-merge'],
    { cwd: worktreePath },
    traceCtx,
  )
  const { stdout: applyPathRaw } = await exec(
    git,
    ['rev-parse', '--git-path', 'rebase-apply'],
    { cwd: worktreePath },
    traceCtx,
  )

  for (const rawPath of [mergePathRaw.trim(), applyPathRaw.trim()]) {
    const rebasePath = resolve(worktreePath, rawPath)
    let isDir = false
    try {
      const s = await stat(rebasePath)
      isDir = s.isDirectory()
    } catch (err: unknown) {
      if (!isMissingPath(err)) throw err
      // ENOENT/ENOTDIR → the state dir is absent, which is the healthy case.
    }
    if (isDir) {
      throw new Error(
        [
          `verify hygiene: stale rebase state present at ${rebasePath}`,
          `drift: recorded=${worktreePath} observed=stale-rebase-state`,
        ].join('\n'),
      )
    }
  }
}

const isEnoent = (err: unknown): boolean =>
  err instanceof Error &&
  'code' in err &&
  (err as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * True when a `stat` failure means "nothing is at this path".
 *
 * ENOENT is the ordinary form. ENOTDIR is the same fact reported differently:
 * a path component that exists but is a FILE rather than a directory — e.g.
 * `<something>/.git/rebase-merge` where `.git` is a linked worktree's gitfile.
 * Treating ENOTDIR as an error made a healthy tree look like it had stale
 * rebase state.
 */
const isMissingPath = (err: unknown): boolean =>
  isEnoent(err) ||
  (err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOTDIR')
