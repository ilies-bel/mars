import type { WorkflowStore } from '@mars/workflow'
import {
  getTask,
  reopenTerminalTask,
  TERMINAL_TASK_STATUSES,
  updateTask,
} from '../queue'

export type RemergeErrorCode = 'NOT_FOUND' | 'WRONG_STATUS' | 'NO_BRANCH' | 'NO_COMMITS_AHEAD'

/**
 * Typed error thrown by {@link coreRemergeTask} when pre-conditions are not
 * met. Callers (UDS handler, HTTP handler) map `code` to the appropriate
 * response payload.
 */
export class RemergeTaskError extends Error {
  readonly code: RemergeErrorCode

  constructor(message: string, code: RemergeErrorCode) {
    super(message)
    this.name = 'RemergeTaskError'
    this.code = code
  }
}

/** The result returned by {@link coreRemergeTask}. */
export interface RemergeResult {
  /**
   * The status the task was written to: `'queued'` for the normal path
   * (setup → verify → merge dispatches), or `'done'` when the branch's
   * commits turned out to already be patch-present in the integration
   * branch under different SHAs — settled directly, nothing was dispatched.
   */
  status: 'queued' | 'done'
  /** Present only when `status === 'done'`: explains why nothing was dispatched. */
  message?: string
}

/**
 * Re-enter the pipeline at **verify** on the task's EXISTING `task/<id>`
 * branch, skipping setup + code. Use when the branch already carries a
 * complete, good commit but the task failed at a later phase (e.g. merge) or
 * was stranded by an infra/config issue.
 *
 * Guards:
 * - Task must be in a terminal status (`failed`, `done`, `vega-reconciling`,
 *   `merging`, `verifying`).
 * - The branch `task/<id>` must exist in the repo.
 * - The branch must have at least one commit ahead of the integration branch
 *   (by SHA reachability). A branch with none is genuinely never-committed
 *   work — this throws `NO_COMMITS_AHEAD`.
 * - If every one of those commits is PATCH-equivalent to a commit already
 *   reachable from the integration branch (`git cherry`), the branch's work
 *   already landed under different SHAs — typically a sibling recovery task
 *   committed and merged the identical diff first, then died before this
 *   task settled. Dispatching setup+verify+merge in that case would rebase
 *   those commits away to nothing (git's own "already applied" skip) and the
 *   merge gate would then misreport the branch as `merge:zero-commit-branch`
 *   — a false failure for work that is safely in `main` (see incident
 *   mars-a98bec46). This is detected HERE, before setup's rebase mutates the
 *   branch and destroys the patch-id evidence, and the task is settled
 *   `done` directly without dispatching anything.
 * - If the branch is contaminated in some other way (its tip is already an
 *   ancestor of the integration branch despite a positive commit count, but
 *   NOT because of patch-equivalence), the verify step in
 *   `remerge-workflow.js` will detect and reject it — no additional pre-check
 *   is needed here.
 *
 * What it does:
 * 1. Removes the existing worktree (if any) so `setupWorktree` can create a
 *    fresh one on the existing branch.
 * 2. Discards the prior workflow run journal so the next dispatch starts from
 *    step 0 of `remerge-workflow.js`.
 * 3. Sets `task.workflow = 'remerge'` so the dispatcher loads
 *    `.mars/workflows/remerge-workflow.js` (which omits the code step).
 * 4. Re-queues the task row.
 *
 * @throws {RemergeTaskError} code `'NOT_FOUND'` — task does not exist
 * @throws {RemergeTaskError} code `'WRONG_STATUS'` — task not in a restartable terminal status
 * @throws {RemergeTaskError} code `'NO_BRANCH'` — branch does not exist in the repo
 * @throws {RemergeTaskError} code `'NO_COMMITS_AHEAD'` — branch has no un-integrated commits
 */
export const coreRemergeTask = async (
  id: string,
  allowedStatuses: ReadonlySet<string>,
  workflowStore: WorkflowStore,
): Promise<RemergeResult> => {
  const task = await getTask(id)
  if (!task) {
    throw new RemergeTaskError(`Task '${id}' not found`, 'NOT_FOUND')
  }

  if (!allowedStatuses.has(task.status)) {
    throw new RemergeTaskError(
      `Task '${id}' is in status '${task.status}', which is not eligible for remerge. ` +
        `Eligible statuses: ${[...allowedStatuses].join(', ')}`,
      'WRONG_STATUS',
    )
  }

  const { existsSync: exists } = await import('node:fs')
  const { branchExists } = await import('../lib/git/internal')
  const { listUniqueCommitsAhead } = await import('../lib/sweep')
  const { integrationBranchName } = await import('../lib/blocker-resolution-primitives')
  const { getRepoRoot } = await import('../context')
  const { resolveVcs } = await import('../ports/vcs/registry')
  const removeWorktree = (
    ref: { path: string; branch: string },
    force = true,
    keepBranch = false,
  ) => resolveVcs().removeWorktree({ path: ref.path, branch: ref.branch, force, keepBranch })

  const branch = task.branch ?? `task/${id}`
  const repoRoot = getRepoRoot()
  const integrationBranch = integrationBranchName()

  // Guard 1: the branch must exist. If it doesn't, the user needs a full restart.
  const branchFound = await branchExists(branch)
  if (!branchFound) {
    throw new RemergeTaskError(
      `Branch '${branch}' does not exist — there is no committed work to re-verify. ` +
        `Run \`mars restart ${id}\` to start fresh from setup.`,
      'NO_BRANCH',
    )
  }

  // Guard 2: the branch must carry at least one commit that is not yet
  // integrated. A branch at the integration tip has no work to verify or merge.
  const commitsAhead = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
  if (commitsAhead.length === 0) {
    throw new RemergeTaskError(
      `Branch '${branch}' has no un-integrated commits ahead of '${integrationBranch}'. ` +
        `Run \`mars restart ${id}\` to start fresh from setup.`,
      'NO_COMMITS_AHEAD',
    )
  }

  // Guard 2b: the branch's commits-ahead (by SHA) may already be
  // PATCH-present in the integration branch under different SHAs — e.g. a
  // sibling recovery task committed and merged the identical diff before
  // this remerge ran. Detect this BEFORE setup's rebase mutates the branch:
  // once that rebase drops the already-applied commits, the merge gate can
  // no longer tell "already landed" apart from "never had commits" (see
  // `isBranchPatchLandedInIntegration`'s doc comment). Settle done here
  // instead of dispatching a pipeline that would misreport this branch as a
  // `merge:zero-commit-branch` failure.
  const { isBranchPatchLandedInIntegration } = await import('../lib/git/merge')
  const alreadyLanded = await isBranchPatchLandedInIntegration(branch, integrationBranch, repoRoot)
  if (alreadyLanded) {
    if (task.worktreePath && exists(task.worktreePath)) {
      await removeWorktree({ path: task.worktreePath, branch }, true, false).catch(() => {})
    }
    // Ensure the branch itself is gone before the updateTask(done) call below.
    // updateTask's done-implies-merged invariant (queue.ts) runs
    // `git rev-list --count integration..branch` and would see this branch as
    // AHEAD (it is, by SHA — that is exactly why this guard fired) and
    // redirect the done transition to 'failed' with
    // 'done-with-unmerged-commits' unless the branch ref no longer exists (a
    // missing branch reads as 0-ahead there). removeWorktree above already
    // deletes the branch when a worktree was present; this covers the case
    // where there was none (or its removal silently failed).
    const { resolveVcs } = await import('../ports/vcs/registry')
    await resolveVcs().deleteBranch({ cwd: repoRoot, branch }).catch(() => {})
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      await reopenTerminalTask(id, 'mars remerge: branch already landed')
    }
    const message =
      `branch '${branch}' is empty after accounting for already-applied patches — ` +
      `its ${commitsAhead.length} commit(s) are already present in '${integrationBranch}' ` +
      `under different SHAs. Nothing to merge; settling done.`
    await updateTask(id, {
      status: 'done',
      workflow: null,
      worktreePath: null,
      branch: null,
      claudeSessionId: null,
      error: null,
      failedPhase: null,
      failureReason: null,
      failureSignature: null,
      failureReasonCode: null,
    })
    return { status: 'done', message }
  }

  // Remove the existing worktree directory (if present) so setupWorktree can
  // create a fresh one on the EXISTING branch. `keepBranch: true` ensures the
  // committed work is preserved.
  if (task.worktreePath && exists(task.worktreePath)) {
    await removeWorktree({ path: task.worktreePath, branch }, true, true).catch(() => {})
  }

  // Discard the prior workflow run journal. The remerge dispatch uses a
  // different workflow file (remerge-workflow.js) and must start from step 0
  // of that file — not resume stale step records from the old implement run.
  await workflowStore.deleteRun(id)

  // Route the next dispatch to the remerge pipeline (setup → verify → merge,
  // no code step). coreRestartTask clears this back to null if the operator
  // later calls `mars restart` to do a full re-code.
  // A terminal task is allowed to re-enter only through this audited seam;
  // ordinary status writes remain terminal-immutable. The branch/ahead guards
  // above establish that this is a recovery of preserved work, not a generic
  // reopening of a failed task.
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    await reopenTerminalTask(id, 'mars remerge existing branch')
  }
  await updateTask(id, {
    status: 'queued',
    workflow: 'remerge',
    worktreePath: null,
    claudeSessionId: null,
    error: null,
    failedPhase: null,
    failureSignature: null,
    failureReasonCode: null,
  })

  return { status: 'queued' }
}
