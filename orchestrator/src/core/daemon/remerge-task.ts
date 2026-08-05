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
  /** The status the task was written to: always `'queued'`. */
  status: 'queued'
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
 * - The branch must have at least one commit ahead of the integration branch.
 * - If the branch is contaminated (its tip is already an ancestor of the
 *   integration branch despite a positive commit count), the verify step in
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
  const { integrationBranchName } = await import('../blocker-resolution')
  const { getRepoRoot } = await import('../context')
  const { removeWorktree } = await import('../lib/git/worktree')

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
