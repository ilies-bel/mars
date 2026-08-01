/**
 * Daemon-killed alert: on daemon start, raise one actionQueue item per task that was
 * SIGKILL'd along with a previous daemon (`mars daemon kill` or an external
 * kill). Such tasks are stamped `failureSignature: 'daemon-killed'` and left in
 * `failed` by the kill path; the daemon does NOT auto-requeue them — it surfaces
 * an alert-only actionQueue item so the operator decides whether to requeue.
 *
 * Deduplication is origin-keyed (`originTaskId`), so re-running reconcile after
 * a crash bumps the existing open item rather than inserting a sibling. The
 * existing `dismissAlertsOnStatusChange` hook in queue.ts auto-closes the item
 * the moment the task leaves `failed` (e.g. when the operator clicks Requeue and
 * it flips back to `queued`).
 *
 * The body lists the recovery actions from the daemon-killed `FailureKind`
 * record (ADR-0042), so the CLI actionQueue reads the same menu the UI renders as
 * buttons — one source of truth for "what can I do about this?".
 */

import { listTasks } from '../queue'
import { DAEMON_KILLED_SIGNATURE } from '../lib/retry-budget'
import { lookupFailureKind, unknownFailureKind } from '../lib/failure-kinds'
import { raiseActionQueueItem } from '../lib/action-queue'
import type { ActionQueueKind } from '../lib/action-queue-kinds'

export const DAEMON_KILLED_ACTION_QUEUE_KIND: ActionQueueKind = 'daemon-killed'

/**
 * Render the alert body from the daemon-killed `FailureKind` record. Exported
 * so a test can assert the body stays in lockstep with the registry without
 * coupling to the surrounding raise logic.
 */
export const buildDaemonKilledBody = (taskId: string): string => {
  const kind =
    lookupFailureKind(DAEMON_KILLED_SIGNATURE) ??
    unknownFailureKind(DAEMON_KILLED_SIGNATURE, '')
  const actions = kind.actions.map((a) => `  • ${a.label}`).join('\n')
  return (
    `Task ${taskId} was in flight when the daemon was killed.\n` +
    `${kind.verboseReason}\n\n` +
    `Recovery:\n${actions}`
  )
}

/**
 * Scan for `failed` tasks carrying the daemon-killed signature and raise one
 * alert-only actionQueue item per task. Returns the actionQueue item ids raised (or bumped
 * on re-detection). Does NOT change any task status — alert only.
 */
export const detectAndRaiseDaemonKilled = async (): Promise<string[]> => {
  const failed = await listTasks('failed')
  const raised: string[] = []

  for (const task of failed) {
    if (task.failureSignature !== DAEMON_KILLED_SIGNATURE) continue

    // Defensive guard: listTasks('failed') already filters by status, but an
    // explicit check here protects against a requeue-then-restart race where
    // the daemon kill-sweep fires after a task has been requeued (status no
    // longer 'failed') but before the loop exits. A restarted task must never
    // get a new daemon-killed action-queue row.
    if (task.status !== 'failed') continue

    const id = await raiseActionQueueItem({
      kind: DAEMON_KILLED_ACTION_QUEUE_KIND,
      category: 'daemon',
      priority: 'high',
      title: `Daemon-killed: task ${task.id}`,
      body: buildDaemonKilledBody(task.id),
      payload: {
        status: task.status,
        branch: task.branch ?? null,
        prompt: task.prompt,
        error: task.error ?? null,
        errorKind: 'daemon-killed',
      },
      context: { taskId: task.id },
      raisedBy: 'daemon:daemon-killed-sweep',
      signature: task.id,
      originTaskId: task.id,
      occurrence: { detectedAt: new Date().toISOString() },
    })
    raised.push(id)
  }

  return raised
}
