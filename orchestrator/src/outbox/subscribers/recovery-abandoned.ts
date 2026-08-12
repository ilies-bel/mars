import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { getTask } from '../../core/queue.js'
import { raiseActionQueueItem } from '../../core/lib/action-queue.js'
import { registerSubscriberName } from '../registry.js'

/**
 * Durable outbox subscriber that raises an action-queue row when a fix
 * (recovery) task is manually dropped rather than reaching a terminal verdict
 * through the normal exhaustion path.
 *
 * When a fix task (fix_for_task_id IS NOT NULL) reaches `dropped`, the
 * operator cancelled it before the automated recovery ran to completion.
 * The origin's single recovery slot is effectively forfeited and no
 * action-queue item would otherwise appear — without this subscriber the origin
 * sits silently with no context on how to proceed.
 *
 * This subscriber fires on `task.terminal { reason: 'dropped' }` events,
 * filters for rows where fixForTaskId is non-null, and raises a
 * `recovery-abandoned` action-queue item against the origin so the operator
 * sees a clear call to action with the correct resolution verbs.
 *
 * The `task.failed` route (recovery exhausted) is handled separately by
 * `recovery-spawn.ts` and `queue-fix-tasks.ts`; those paths are left untouched
 * so the two subscribers do not race.
 */
export const RECOVERY_ABANDONED_SUBSCRIBER = 'recovery-abandoned'
registerSubscriberName(RECOVERY_ABANDONED_SUBSCRIBER)

/**
 * Register the recovery-abandoned subscriber. `replay: false` so the cursor
 * starts at the current outbox head on first registration, observing only
 * future events. Idempotent.
 */
export async function ensureRecoveryAbandonedSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, RECOVERY_ABANDONED_SUBSCRIBER, { replay: false })
}

/**
 * Process every pending `task.terminal { reason: 'dropped' }` event for a fix
 * task. For each such event:
 *  - Load the dropped task row.
 *  - Early-return if `fixForTaskId` is null (a non-fix task being dropped is not
 *    a recovery-abandonment; no action needed).
 *  - Otherwise raise a `recovery-abandoned` action-queue item against the origin
 *    task so the operator knows the recovery was manually cancelled and sees the
 *    two resolution verbs (`mars continue` / `mars restart`).
 *
 * Per-event side effects are wrapped in `drainWithStall`'s at-most-once
 * machinery, so a crash between the handler running and the cursor advancing
 * leaves the dedup row in place — the next drain reads `alreadyProcessed` and
 * skips without re-raising.
 *
 * @param client  The DB client carrying the outbox + subscriber tables.
 * @param log     Optional logger for per-event progress messages.
 * @returns       The count of `task.terminal` events whose side effect ran.
 */
export async function drainRecoveryAbandoned(
  client: DbClient,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: RECOVERY_ABANDONED_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.terminal') return false
      const payload = event.payload as { taskId: string; reason: string }
      if (payload.reason !== 'dropped') return false

      const fixTask = await getTask(payload.taskId)
      if (!fixTask) return false
      if (fixTask.fixForTaskId === null) return false

      const originId = fixTask.fixForTaskId

      await raiseActionQueueItem({
        kind: 'recovery-abandoned',
        category: 'orchestrator',
        priority: 'high',
        title: 'Recovery task dropped',
        body:
          `Recovery task ${fixTask.id} was manually dropped, not exhausted. ` +
          `Run \`mars continue ${originId}\` to resume on the existing worktree, ` +
          `or \`mars restart ${originId}\` to wipe and re-run.`,
        payload: { fixTaskId: fixTask.id, originTaskId: originId },
        context: {},
        raisedBy: `outbox:${RECOVERY_ABANDONED_SUBSCRIBER}`,
        signature: `recovery-abandoned:${originId}`,
        originTaskId: originId,
      })

      log?.(
        `[recovery-abandoned] raised action-queue row for origin ${originId} ` +
          `(fix task ${fixTask.id} was manually dropped)`,
      )
      return true
    },
  })
}
