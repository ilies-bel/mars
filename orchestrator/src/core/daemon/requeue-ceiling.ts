/**
 * requeue-ceiling — hard ceiling on per-step dispatch re-attempts.
 *
 * Root cause of the 2026-07-02 overnight loop (mars-c11be862 post-mortem):
 * when a worktree path is nulled but the setup-worktree checkpoint survives,
 * every re-dispatch skips setup, throws "no worktree available", and the
 * poll-fallback re-seeds the task 30 s later — indefinitely. Eight tasks
 * reached 1,014 step attempts overnight.
 *
 * Fix 2 of 2: the poll-fallback calls {@link checkAndEscalateRequeueCeiling}
 * before re-seeding each queued task. If any step's `attempt` field has
 * reached {@link REQUEUE_STEP_CEILING} without the run completing, the task
 * is moved to `failed` and an operator action-queue item is raised.
 *
 * Fix 1 (preserve worktree pointers on restart) lives in phase-recovery.ts;
 * this ceiling is a defence-in-depth backstop for any path that still re-queues
 * without making step progress.
 */

import type { WorkflowStore } from '@mars/workflow'
import { raiseActionQueueItem } from '../lib/action-queue'
import { updateTask, type Task } from '../queue'

/**
 * How many times any single step in a workflow run may be attempted before the
 * poll-fallback escalates the task to `failed` instead of re-seeding it.
 * Not configurable: a knob here has historically been left at a bad value and
 * caused the very loops we are fixing.
 */
export const REQUEUE_STEP_CEILING = 5

/**
 * Check whether task `t`'s workflow run has exceeded the step-attempt ceiling.
 * If so, fail the task and raise an operator action-queue item.
 *
 * @returns `true` if the task was escalated (caller must NOT re-seed it);
 *          `false` if step attempts are still within the ceiling (caller may
 *          proceed to `tracker.enqueuePending`).
 */
export const checkAndEscalateRequeueCeiling = async (
  t: Task,
  store: WorkflowStore,
  log: (msg: string) => void,
): Promise<boolean> => {
  const steps = await store.listSteps(t.id).catch(() => [])
  const maxAttempt =
    steps.length > 0 ? Math.max(...steps.map((s) => s.attempt)) : 0

  if (maxAttempt < REQUEUE_STEP_CEILING) return false

  log(
    `[dispatch] poll-fallback: task ${t.id} step-attempt ceiling reached ` +
      `(${maxAttempt}/${REQUEUE_STEP_CEILING}); escalating to failed`,
  )

  await updateTask(t.id, {
    status: 'failed',
    error:
      `Re-queue ceiling: a step was attempted ${maxAttempt} times without ` +
      `completing (ceiling ${REQUEUE_STEP_CEILING}). ` +
      `Run \`mars restart ${t.id}\` to reset.`,
    failureReason:
      `Re-queue ceiling reached: step attempted ${maxAttempt} times ` +
      `(ceiling ${REQUEUE_STEP_CEILING}).`,
    failureReasonCode: 'requeue-ceiling-exceeded',
  }).catch(() => {})

  await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title: `Task ${t.id}: re-queue ceiling exceeded`,
    body:
      `Task was re-dispatched ${maxAttempt} times without a step transition ` +
      `(ceiling ${REQUEUE_STEP_CEILING}). Likely a stale checkpoint / worktree ` +
      `mismatch. Run \`mars restart ${t.id}\` to reset.`,
    payload: { taskId: t.id, maxAttempt, ceiling: REQUEUE_STEP_CEILING },
    context: {},
    raisedBy: 'daemon:poll-fallback',
    signature: `requeue-ceiling:${t.id}`,
    originTaskId: t.id,
  }).catch(() => {})

  return true
}
