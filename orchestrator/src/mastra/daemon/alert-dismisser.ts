import type { Client } from '@libsql/client'
import type { EventName } from '../../bus/events.js'
import {
  advanceCursor,
  fetchPending,
  registerSubscriber,
} from '../../bus/subscribers.js'
import { dismissAlertsOnStatusChange } from '../lib/inbox'
import { clearDismissalForEntity } from '../lib/inbox-dismissals'

/**
 * Durable outbox subscriber that keeps the "status change clears the
 * task's action-queue alerts" invariant whole.
 *
 * The chokepoint `updateTask()` calls `dismissAlertsOnStatusChange` +
 * `clearDismissalForEntity` directly, but several raw-SQL status writes
 * bypass it. Rather than patch each writer, this subscriber reacts to the
 * `events` table: every status-transition event clears the open inbox
 * alert(s) and the dismissal row for the implicated task. Because the bus
 * is the single source of truth for transitions, the invariant holds for
 * every path — chokepoint or not.
 */
export const ALERT_DISMISSER_SUBSCRIBER = 'alert-dismisser'

/**
 * Maps a status-transition event to the task status it represents. Only
 * the events listed here clear alerts; every other event is a no-op that
 * still advances the cursor so the subscriber never stalls.
 */
const STATUS_BY_EVENT: Partial<Record<EventName, string>> = {
  'task.failed': 'failed',
  'task.dropped': 'dropped',
  'task.completed': 'done',
  'task.unblocked': 'queued',
  'task.queued': 'queued',
}

/**
 * Register the alert-dismisser subscriber. `replay: false` so it starts
 * at the current outbox head and only reacts to future transitions —
 * historical alerts are already reconciled by the chokepoint. Idempotent.
 */
export async function ensureAlertDismisser(client: Client): Promise<void> {
  await registerSubscriber(client, ALERT_DISMISSER_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Process every event the subscriber has not yet acknowledged, in order.
 *
 * For each mapped status-transition event the implicated task's open
 * alerts are resolved and its dismissal row cleared; unmapped events are
 * skipped (no-op) but still advance the cursor. On a processing error the
 * cursor is NOT advanced and the drain breaks, so the failed event is
 * retried on the next pass rather than being silently dropped.
 *
 * @param client The libsql client carrying the outbox + inbox tables.
 * @param log    Optional logger callback for per-event failures.
 * @returns      The count of mapped events whose alerts were cleared.
 */
export async function drainAlertDismissals(
  client: Client,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  const pending = await fetchPending(client, ALERT_DISMISSER_SUBSCRIBER)
  let processed = 0

  for (const event of pending) {
    try {
      const status = STATUS_BY_EVENT[event.type]
      if (status) {
        // Gated on a mapped event type, so the payload always carries a
        // taskId (see EventMap). Narrow via cast rather than re-parse.
        const taskId = (event.payload as { taskId: string }).taskId
        await dismissAlertsOnStatusChange(taskId, status)
        await clearDismissalForEntity('task', taskId)
        processed++
      }
    } catch (err) {
      log?.(
        `[alert-dismisser] event ${event.id} (${event.type}) failed: ${(err as Error).message}`,
      )
      // Do NOT advance the cursor for this event — break so the next
      // drain retries from here rather than skipping past the failure.
      break
    }
    // Reached only when the event body did not throw (mapped+processed
    // OR unmapped+skipped). A throw breaks above, before the advance, so
    // the failed event is retried next drain.
    await advanceCursor(client, ALERT_DISMISSER_SUBSCRIBER, event.id)
  }

  return { processed }
}
