/**
 * Core business logic for the `approve-step` and `abort-release` actions on an
 * `awaiting-human` task (ADR-0094 action-queue verb pair for the merge-gate
 * human checkpoint).
 *
 * These functions implement the pure state-transition logic. The HTTP route
 * layer in `routes.ts` calls them via `HttpServerDeps.approveStep` /
 * `HttpServerDeps.abortRelease`; `server.ts` wires those deps and adds the
 * bus events that the pipeline needs to continue.
 *
 * Both close the `awaiting-human` action-queue row atomically with the task
 * mutation (ADR-0094 rule: a stored operator-decision row is closed in the
 * same transactional beat as the mutation that resolves it — no sweep, no
 * reconcile).
 */

import { Arc } from '../arc.js'
import { getTask, updateTask } from '../queue.js'
import { supersedeActionQueueItemsBySignature } from '../lib/action-queue.js'

// ── approve-step ─────────────────────────────────────────────────────────────

/**
 * Advance a merge-gate (or any manually-parked) task by treating the current
 * step as done.
 *
 * Equivalent to what the CLI's `mars step done <id>` does in the daemon-restart
 * (Path 2 re-queue) fallback: closes the `awaiting-human` action-queue row and
 * re-queues the task so the pipeline dispatcher picks it up and runs the merge
 * step.
 *
 * In the production daemon `server.ts` wires this through `handleStepDone`,
 * which additionally attempts in-process workflow resolution first (Path 1).
 * This standalone function captures the observable state transitions (row
 * closed, task re-queued) that the tests verify.
 *
 * Throws `code='NOT_FOUND'` when the task does not exist.
 * Throws `code='WRONG_STATUS'` when the task is not `awaiting-human` or has
 * no active lease.
 */
export const coreApproveStep = async (id: string): Promise<void> => {
  const task = await getTask(id)
  if (!task) {
    throw Object.assign(new Error(`task ${id} not found`), { code: 'NOT_FOUND' as const })
  }
  if (task.status !== 'awaiting-human') {
    throw Object.assign(
      new Error(
        `task ${id} is ${task.status}; approve-step only applies to awaiting-human tasks`,
      ),
      { code: 'WRONG_STATUS' as const },
    )
  }
  if (task.leaseOwner === null) {
    throw Object.assign(
      new Error(`task ${id} has no active lease`),
      { code: 'WRONG_STATUS' as const },
    )
  }

  // Close the awaiting-human AQ row atomically with the re-queue (ADR-0094).
  await supersedeActionQueueItemsBySignature(
    'awaiting-human',
    id,
    'step-done',
    'daemon:approve-step',
  )

  // Re-queue the task for pipeline continuation. keepLease=true mirrors
  // handleStepDone's Path 2 so that if the workflow parks at the next manual
  // step, the same session identity is already attached and no re-attach is
  // needed. The task transitions awaiting-human → queued.
  await Arc.load(id).releaseLease(id, { keepLease: true })
}

// ── abort-release ─────────────────────────────────────────────────────────────

/**
 * Abort a merge-gate (or any manually-parked) task without merging it.
 *
 * Closes the `awaiting-human` action-queue row and marks the task `failed`
 * with `failureReason='operator aborted human work'`. Equivalent to
 * `mars release --abort <id>`.
 *
 * The production daemon adds a `bus.emit('task.failed')` after this call so
 * the recovery-spawn subscriber can react. The standalone function here only
 * performs the database mutations so it is testable without a running event
 * bus.
 *
 * Throws `code='NOT_FOUND'` when the task does not exist.
 * Throws `code='WRONG_STATUS'` when the task is not `awaiting-human` or has
 * no active lease.
 */
export const coreAbortRelease = async (id: string): Promise<void> => {
  const task = await getTask(id)
  if (!task) {
    throw Object.assign(new Error(`task ${id} not found`), { code: 'NOT_FOUND' as const })
  }
  if (task.status !== 'awaiting-human') {
    throw Object.assign(
      new Error(
        `task ${id} is ${task.status}; abort-release only applies to awaiting-human tasks`,
      ),
      { code: 'WRONG_STATUS' as const },
    )
  }
  if (task.leaseOwner === null) {
    throw Object.assign(
      new Error(`task ${id} has no active lease`),
      { code: 'WRONG_STATUS' as const },
    )
  }

  // Close the awaiting-human row before mutating task status (ADR-0094).
  await supersedeActionQueueItemsBySignature(
    'awaiting-human',
    id,
    'status-changed',
    'daemon:abort-release',
  )

  // Mark the task failed — worktree and branch are preserved for inspection,
  // same as how `mars release --abort` leaves things.
  await updateTask(id, {
    status: 'failed',
    leaseOwner: null,
    leasedAt: null,
    leaseNote: null,
    error: 'aborted by operator',
    failureReason: 'operator aborted human work',
  })
}
