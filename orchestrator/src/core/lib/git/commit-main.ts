import { checkSecretPath } from '../dirty-main-salvage'
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
// Auto-commit helper for deterministic worktree salvage
// ---------------------------------------------------------------------------

export interface AutoCommitArgs {
  /** Task whose dirty worktree is being committed — named in the commit. */
  taskId: string
  /**
   * Where the dirty content came from. Drives the commit message; callers must
   * state what they know rather than inheriting a possibly false default.
   */
  provenance: 'coder-left-dirty' | 'committer-salvage'
  /** Integration branch where the content originated when it was salvaged. */
  integrationBranch: string
  worktreePath: string
  dirtyFiles: string[]
  traceCtx?: TraceCtx
}

export type AutoCommitResult =
  | { committed: true; sha: string }
  /**
   * `unsafe-path` — the guard refused before touching the index (nothing was
   * staged, nothing committed). `git` — `git add`/`git commit` itself failed.
   * The caller stamps the same failure signature either way but reports the
   * distinction, because an operator resolves them differently.
   */
  | { committed: false; refusal: 'unsafe-path' | 'git'; reason: string }

/**
 * Attempt a deterministic `git add -A && git commit` inside the worktree, on
 * behalf of the orchestrator when a worktree has deterministic dirty content.
 *
 * Guarded: every dirty path is checked against {@link checkSecretPath} FIRST,
 * and a single match aborts the whole commit (all-or-nothing) before anything
 * is staged. `git add -A` honours `.gitignore`, so build output and
 * dependencies listed there are already excluded; the guard covers the shapes
 * that must never land even if a repo forgot to ignore them.
 *
 * Returns `{committed: true, sha}` on success so the pipeline can continue
 * to verify as if the coder had committed. Returns
 * `{committed: false, refusal, reason}` when the guard trips or the commit
 * fails (pre-commit hook rejection, empty staged set, etc.) — the caller
 * decides what to do next.
 */
export const autoCommitWorktreeIfDeterministic = async (
  args: AutoCommitArgs,
): Promise<AutoCommitResult> => {
  const git = resolveGitBin()
  const { taskId, provenance, integrationBranch, worktreePath, dirtyFiles, traceCtx } = args
  const count = dirtyFiles.length

  for (const filePath of dirtyFiles) {
    const hit = checkSecretPath(filePath)
    if (hit) {
      return {
        committed: false,
        refusal: 'unsafe-path',
        reason: `refusing to auto-commit: ${hit.filePath} is a ${hit.reason} and must never be committed`,
      }
    }
  }

  const [subject, body] = provenance === 'coder-left-dirty'
    ? [
        `chore(auto-commit): task ${taskId} — coder finished but did not commit — ${count} path(s)`,
        [
          `The coder for task ${taskId} ended the code step with ${count} path(s) still`,
          'uncommitted. The orchestrator committed them on the agent\'s behalf so the',
          'work reaches verify and the merge rebase. The agent did NOT author this',
          'commit and did not choose its contents.',
          '',
          ...dirtyFiles.map((f) => `  ${f}`),
        ].join('\n'),
      ]
    : [
        `chore(auto-commit): task ${taskId} — salvaged uncommitted ${integrationBranch} state — ${count} path(s)`,
        [
          `These ${count} path(s) were found uncommitted on ${integrationBranch}.`,
          'The committer agent could not commit them itself, so the orchestrator',
          `landed them to unblock ${integrationBranch}. Authorship is unknown and may`,
          'belong to a human operator.',
          '',
          ...dirtyFiles.map((f) => `  ${f}`),
        ].join('\n'),
      ]

  const addResult = await execProbe(
    git,
    ['add', '-A'],
    { cwd: worktreePath },
    traceCtx,
  )
  if (addResult.exitCode !== 0) {
    return {
      committed: false,
      refusal: 'git',
      reason: `git add -A failed: ${addResult.stderr.trim()}`,
    }
  }

  const commitResult = await execProbe(
    git,
    ['commit', '-m', subject, '-m', body],
    { cwd: worktreePath },
    traceCtx,
  )
  if (commitResult.exitCode !== 0) {
    return {
      committed: false,
      refusal: 'git',
      reason: `git commit failed: ${commitResult.stderr.trim()}`,
    }
  }

  const { stdout } = await exec(
    git,
    ['rev-parse', 'HEAD'],
    { cwd: worktreePath },
    traceCtx,
  )
  return { committed: true, sha: stdout.trim() }
}
