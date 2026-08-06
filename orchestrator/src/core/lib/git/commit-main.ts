import { checkSecretPath } from '../dirty-main-salvage'
import { exec, execProbe, resolveGitBin, type TraceCtx } from './internal'

// ---------------------------------------------------------------------------
// Branch-safety guards
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link commitMain} when `taskId` is provided and the current HEAD
 * branch is the integration branch (`main` or `master`). A checkpoint or
 * recovery agent that has no task branch must refuse to commit rather than
 * landing work directly on the integration branch.
 */
export class CommitToMainError extends Error {
  readonly currentBranch: string
  readonly worktreePath: string
  constructor(currentBranch: string, worktreePath: string) {
    super(
      `refusing to commit: HEAD is on the integration branch '${currentBranch}' at ${worktreePath}. ` +
        `Commits from recovery/checkpoint paths must land on the invoking task's own branch (task/<id>), ` +
        `not on the integration branch. Nothing was staged or committed.`,
    )
    this.name = 'CommitToMainError'
    this.currentBranch = currentBranch
    this.worktreePath = worktreePath
  }
}

/**
 * Thrown by {@link commitMain} when `taskId` is provided and the current HEAD
 * branch is not `task/<taskId>`. An agent operating in the wrong worktree
 * context must refuse rather than committing to an unowned branch.
 */
export class CommitToWrongBranchError extends Error {
  readonly currentBranch: string
  readonly expectedBranch: string
  readonly worktreePath: string
  constructor(currentBranch: string, expectedBranch: string, worktreePath: string) {
    super(
      `refusing to commit: HEAD is on '${currentBranch}' at ${worktreePath}, ` +
        `but commits for this task must land on '${expectedBranch}'. ` +
        `Nothing was staged or committed.`,
    )
    this.name = 'CommitToWrongBranchError'
    this.currentBranch = currentBranch
    this.expectedBranch = expectedBranch
    this.worktreePath = worktreePath
  }
}

/**
 * Read the current HEAD branch name. Returns the branch name on success, or
 * `null` when HEAD is detached or the git command fails.
 */
async function readCurrentBranch(
  git: string,
  cwd: string,
  traceCtx?: TraceCtx,
): Promise<string | null> {
  const r = await execProbe(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }, traceCtx)
  if (r.exitCode !== 0) return null
  const branch = r.stdout.trim()
  // git returns 'HEAD' when detached
  return branch === 'HEAD' ? null : branch
}

/**
 * The set of branch names the orchestrator treats as integration branches.
 * A commit to any of these from a recovery or checkpoint path is always wrong.
 */
export const INTEGRATION_BRANCH_NAMES = new Set(['main', 'master'])

export interface CommitMainArgs {
  /** Absolute path to the worktree directory where git commands will run. */
  cwd: string
  /** Commit message. */
  message: string
  /** Optional trace context for tool event emission. */
  traceCtx?: TraceCtx
  /**
   * When provided, enforces that HEAD is on `task/<taskId>` before staging
   * anything.
   *
   * - If HEAD is an integration branch (`main` / `master`) → throws
   *   {@link CommitToMainError} — distinct error, tested separately.
   * - If HEAD is any other non-`task/<taskId>` branch → throws
   *   {@link CommitToWrongBranchError}.
   *
   * When omitted the check is skipped (legacy callers that pre-date this
   * guard and are already on the correct branch by construction).
   */
  taskId?: string
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
 * When `taskId` is supplied the function validates the current HEAD branch
 * before staging: a commit to `main`/`master` throws {@link CommitToMainError};
 * a commit to any other non-task branch throws {@link CommitToWrongBranchError}.
 *
 * Throws if `git add -A` or `git commit` returns a non-zero exit code.
 */
export const commitMain = async (args: CommitMainArgs): Promise<CommitMainResult> => {
  const git = resolveGitBin()
  const { cwd, message, traceCtx, taskId } = args

  if (taskId !== undefined) {
    const currentBranch = await readCurrentBranch(git, cwd, traceCtx)
    if (currentBranch !== null && INTEGRATION_BRANCH_NAMES.has(currentBranch)) {
      throw new CommitToMainError(currentBranch, cwd)
    }
    const expectedBranch = `task/${taskId}`
    if (currentBranch !== expectedBranch) {
      throw new CommitToWrongBranchError(currentBranch ?? '(detached HEAD)', expectedBranch, cwd)
    }
  }

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
   *
   * `main-branch` — HEAD is the integration branch (`main`/`master`). Commits
   * from recovery or auto-commit paths must NEVER land on the integration
   * branch. Tested separately because this is the most dangerous failure mode
   * (the evidence commit `93addc75` was exactly this).
   *
   * `wrong-branch` — HEAD is some other non-`task/<taskId>` branch. The
   * orchestrator only commits to the invoking task's own branch.
   */
  | { committed: false; refusal: 'unsafe-path' | 'git' | 'main-branch' | 'wrong-branch'; reason: string }

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

  // Branch-safety guard: commits from the orchestrator must land ONLY on the
  // invoking task's own branch. A commit to `main`/`master` is rejected with a
  // distinct refusal so callers can emit a more visible alarm; a commit to any
  // other non-task branch is rejected as `wrong-branch`.
  const currentBranch = await readCurrentBranch(git, worktreePath, traceCtx)
  if (currentBranch !== null && INTEGRATION_BRANCH_NAMES.has(currentBranch)) {
    return {
      committed: false,
      refusal: 'main-branch',
      reason:
        `refusing to auto-commit: HEAD is on the integration branch '${currentBranch}' ` +
        `at ${worktreePath}. Auto-commits may only land on task/<id> branches. ` +
        `Dirty paths: ${dirtyFiles.join(', ')}`,
    }
  }
  const expectedBranch = `task/${taskId}`
  if (currentBranch !== expectedBranch) {
    return {
      committed: false,
      refusal: 'wrong-branch',
      reason:
        `refusing to auto-commit: HEAD is on '${currentBranch ?? '(detached HEAD)'}' ` +
        `at ${worktreePath}, expected '${expectedBranch}'. ` +
        `Auto-commits may only land on the invoking task's own branch. ` +
        `Dirty paths: ${dirtyFiles.join(', ')}`,
    }
  }

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
