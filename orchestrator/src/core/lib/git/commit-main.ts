import { exec, execProbe, resolveGitBin, type TraceCtx } from './internal'

export interface CommitMainArgs {
  /** Absolute path to the worktree directory where git commands will run. */
  cwd: string
  /** Commit message. */
  message: string
  /** Optional trace context for tool event emission. */
  traceCtx?: TraceCtx
}

export interface CommitMainResult {
  /** The SHA of the resulting commit. */
  sha: string
}

/**
 * Stage ALL changes (tracked modifications, deletions, and NEW untracked
 * files) and create a commit in the given worktree.
 *
 * Uses `git add -A` rather than `git commit -a` or `git add -u` so that
 * new, previously-untracked files are never silently dropped from the
 * commit. Dropping untracked files was the root cause of the 2026-07-20
 * data-loss incident: commit becab92c landed on main importing a module
 * (`reflect-workflow.ts`) that the committer failed to stage because the
 * committer recipe instructed `git commit -am`, which is blind to untracked
 * paths.
 *
 * Throws if `git add -A` or `git commit` returns a non-zero exit code.
 */
export const commitMain = async (args: CommitMainArgs): Promise<CommitMainResult> => {
  const git = resolveGitBin()
  const { cwd, message, traceCtx } = args

  await exec(git, ['add', '-A'], { cwd }, traceCtx)
  await exec(git, ['commit', '-m', message], { cwd }, traceCtx)

  const { stdout } = await exec(git, ['rev-parse', 'HEAD'], { cwd }, traceCtx)
  return { sha: stdout.trim() }
}

// ---------------------------------------------------------------------------
// Auto-commit helper for coder-left-uncommitted worktrees
// ---------------------------------------------------------------------------

export interface AutoCommitArgs {
  worktreePath: string
  dirtyFiles: string[]
  traceCtx?: TraceCtx
}

export type AutoCommitResult =
  | { committed: true; sha: string }
  | { committed: false; reason: string }

/**
 * Attempt a deterministic `git add -A && git commit` inside the worktree.
 *
 * Returns `{committed: true, sha}` on success so the pipeline can continue
 * to verify as if the coder had committed. Returns `{committed: false, reason}`
 * when the commit itself fails (pre-commit hook rejection, empty staged set,
 * etc.) — the caller decides what to do next.
 */
export const autoCommitWorktreeIfDeterministic = async (
  args: AutoCommitArgs,
): Promise<AutoCommitResult> => {
  const git = resolveGitBin()
  const { worktreePath, dirtyFiles, traceCtx } = args
  const count = dirtyFiles.length
  const message = `chore(auto-commit): coder finished but did not commit — ${count} path(s)`

  const addResult = await execProbe(
    git,
    ['add', '-A'],
    { cwd: worktreePath },
    traceCtx,
  )
  if (addResult.exitCode !== 0) {
    return { committed: false, reason: `git add -A failed: ${addResult.stderr.trim()}` }
  }

  const commitResult = await execProbe(
    git,
    ['commit', '-m', message],
    { cwd: worktreePath },
    traceCtx,
  )
  if (commitResult.exitCode !== 0) {
    return { committed: false, reason: `git commit failed: ${commitResult.stderr.trim()}` }
  }

  const { stdout } = await exec(
    git,
    ['rev-parse', 'HEAD'],
    { cwd: worktreePath },
    traceCtx,
  )
  return { committed: true, sha: stdout.trim() }
}
