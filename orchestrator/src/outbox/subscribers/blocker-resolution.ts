import type { Client } from '@libsql/client'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { onBlockerTaskCompleted } from '../../core/blocker-resolution.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'

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

/**
 * Register the blocker-resolution subscriber. Idempotent: re-registering an
 * existing subscriber preserves its cursor.
 */
export async function ensureBlockerResolutionSubscriber(client: Client): Promise<void> {
  await registerSubscriber(client, BLOCKER_RESOLUTION_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Drain all pending `task.terminal { reason: 'done' }` events and unblock any
 * dependents whose every blocker is now `done`. Implements the ADR-0032 stall
 * contract via {@link drainWithStall}: a handler failure blocks the cursor on
 * the failing event and raises a `subscriber-stalled` action-queue item after
 * K consecutive failures.
 *
 * @returns The number of events that resulted in at least one state change.
 */
export async function drainBlockerResolution(
  client: Client,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: BLOCKER_RESOLUTION_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      if (event.type !== 'task.terminal') return false
      const payload = event.payload as { taskId: string; reason: string }
      if (payload.reason !== 'done') return false

      const result = await onBlockerTaskCompleted(payload.taskId)
      return result.outcomes.some((o) => o.outcome === 'queued' || o.outcome === 'failed')
    },
  })
}
