import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { Arc } from '../../core/arc.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { registerSubscriberName } from '../registry.js'

/**
 * Durable Outbox Subscriber: drives blocked-task unblocking in response to
 * `task.terminal { reason: 'done' }` events (ADR-0030/0031).
 *
 * This replaces the boot-time `recoverBlockedTasks` scan. Because the subscriber
 * holds a persistent cursor, any `task.terminal` events that were committed to
 * the outbox while the daemon was offline are replayed on the next drain — a
 * daemon crash between a blocker reaching `done` and its dependents being
 * unblocked is therefore automatically recovered on restart without a
 * full-table scan.
 *
 * On first registration the cursor is placed at the current outbox head (no
 * replay), so pre-existing events from before the subscriber was wired are not
 * re-processed. Re-registration is idempotent — the cursor is never reset.
 */
export const BLOCKER_RESOLUTION_SUBSCRIBER = 'blocker-resolution'
registerSubscriberName(BLOCKER_RESOLUTION_SUBSCRIBER)

/**
 * Register the blocker-resolution subscriber. Idempotent: re-registering an
 * existing subscriber preserves its cursor.
 */
export async function ensureBlockerResolutionSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, BLOCKER_RESOLUTION_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Drain all pending `task.terminal` events and settle whatever was waiting on
 * the completing task:
 *
 *  - `reason: 'done'`  → unblock any dependent whose every blocker is now
 *    `done` (`Arc.unblockByCompletion`).
 *  - `reason: 'failed'` → when the failing task is a recovery Chore, fail the
 *    ORIGIN it was spawned for (`Arc.failStrandedOriginOnRecoveryFailure`).
 *    A recovery is a leaf that is never re-run (ADR-0040), so its origin's one
 *    blocker edge can never resolve; leaving the origin in `blocked` stranded
 *    it permanently — `blocked` is not terminal, so neither `mars purge` nor
 *    `mars restart` would accept it. Only the origin↔its-own-recovery edge is
 *    settled here: an ordinary failed blocker still leaves its dependents
 *    waiting in `blocked` (unchanged behaviour).
 *
 * Implements the ADR-0032 stall contract via {@link drainWithStall}: a handler
 * failure blocks the cursor on the failing event and raises a
 * `subscriber-stalled` action-queue item after K consecutive failures.
 *
 * @returns The number of events that resulted in at least one state change.
 */
export async function drainBlockerResolution(
  client: DbClient,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: BLOCKER_RESOLUTION_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.terminal') return false
      const payload = event.payload as { taskId: string; reason: string }

      if (payload.reason === 'failed') {
        const dead = await Arc.failStrandedOriginOnRecoveryFailure(payload.taskId)
        const failed = dead.outcomes.filter((o) => o.outcome === 'failed')
        for (const o of failed) {
          log?.(
            `origin ${o.originTaskId} failed: its recovery ${o.recoveryTaskId} failed (ADR-0040 leaf)`,
          )
        }
        return failed.length > 0
      }

      if (payload.reason !== 'done') return false

      const result = await Arc.unblockByCompletion(payload.taskId)
      return result.outcomes.some((o) => o.outcome === 'queued' || o.outcome === 'failed')
    },
  })
}
