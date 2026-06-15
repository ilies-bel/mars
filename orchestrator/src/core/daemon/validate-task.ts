/**
 * Core mechanics for the preview-gate verdicts — the human-in-the-loop half of
 * the awaiting-validation flow. Both verbs reach here from the daemon HTTP
 * routes `POST /actions/validate/:id` and `POST /actions/reject/:id` (wired in
 * server.ts), and both are idempotent-friendly so a double-click is safe.
 *
 *   - Validate: kill the dev server, mark the task validated, and re-queue it.
 *     The daemon dispatcher re-dispatches with runId=task.id; the engine
 *     short-circuits setup/code/verify (already completed) and re-enters the
 *     merge step, which now finds previewValidated=true and merges for real.
 *
 *   - Reject: kill the dev server and fail the task. The worktree/branch are
 *     preserved (per the operator's chosen policy) so the work shows up in
 *     alerts with the normal Restart / Investigate / Drop actions. The
 *     awaiting-validation action-queue row is superseded explicitly because the
 *     Invalidator treats task.failed as a no-op (failure rows stay for triage).
 *
 * Intentionally has no dependency on the daemon's event bus — the caller emits
 * `task.queued` after a successful validate so the dispatcher picks the task up.
 */

import { getTask, updateTask } from '../queue'
import { killDevServer } from '../lib/dev-server'
import { supersedeActionQueueItemsForOrigin } from '../lib/action-queue'

const WRONG_STATUS = 'WRONG_STATUS' as const

const wrongStatus = (id: string, status: string): Error =>
  Object.assign(
    new Error(
      `task ${id} is ${status}; only tasks awaiting validation can be validated or rejected`,
    ),
    { code: WRONG_STATUS },
  )

const notFound = (id: string): Error =>
  Object.assign(new Error(`task ${id} not found`), { code: 'NOT_FOUND' as const })

/**
 * Approve a preview-gated task: tear down its dev server, mark it validated,
 * and re-queue so the merge continuation runs. The caller emits `task.queued`.
 *
 * @throws when the task does not exist or is not in 'awaiting-validation'.
 */
export const coreValidateTask = async (id: string): Promise<void> => {
  const task = await getTask(id)
  if (!task) throw notFound(id)
  if (task.status !== 'awaiting-validation') {
    throw wrongStatus(id, task.status)
  }

  await killDevServer(task.devServerPid)

  // previewValidated=true is the durable signal the merge step reads to skip the
  // gate on re-entry. Clear the live dev-server coordinates now that it's dead.
  await updateTask(id, {
    status: 'queued',
    previewValidated: true,
    devServerUrl: null,
    devServerPid: null,
    error: null,
  })
}

/**
 * Reject a preview-gated task: tear down its dev server, fail the task (worktree
 * preserved), and close the awaiting-validation action-queue row. Nothing
 * merges.
 *
 * @throws when the task does not exist or is not in 'awaiting-validation'.
 */
export const coreRejectTask = async (id: string): Promise<void> => {
  const task = await getTask(id)
  if (!task) throw notFound(id)
  if (task.status !== 'awaiting-validation') {
    throw wrongStatus(id, task.status)
  }

  await killDevServer(task.devServerPid)

  const reason = 'merge:preview-rejected'
  await updateTask(id, {
    status: 'failed',
    failedPhase: 'merge',
    error: 'rejected by operator at preview gate; merge skipped (worktree preserved)',
    failureReason: reason,
    failureReasonCode: reason,
    failureSignature: reason,
    devServerUrl: null,
    devServerPid: null,
  })

  // task.failed is a no-op for the Invalidator (failure rows stay for triage),
  // so close the awaiting-validation row explicitly. The task then surfaces as a
  // normal failed-task alert with Restart / Investigate / Drop.
  await supersedeActionQueueItemsForOrigin(id, 'status-changed', 'operator:reject').catch(
    () => {
      // Best-effort: the row will also age out via the projection if this fails.
    },
  )
}
