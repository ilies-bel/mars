import type { Client } from '@libsql/client'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { dismissAlertsOnStatusChange, resolveAllRowsForTask } from '../lib/action-queue'
import { drainWithStall } from './subscriber-drain.js'

/**
 * The Invalidator (ADR-0027): the sole closer of Action-queue rows for a task.
 * It is a durable outbox Subscriber (ADR-0030/0031) — every task-status writer
 * emits its lifecycle event into the outbox in the same transaction as the
 * status write, and this Subscriber consumes those events by durable cursor.
 * No status writer clears Action-queue rows inline any more; doing it here,
 * off the durable outbox, is what makes the clear survive a daemon-down window
 * or a writer that never went through updateTask — the staleness class this
 * design removes.
 *
 * Closing policy (ADR-0028, ADR-0048):
 *   - `task.completed` / `task.dropped` → resolve ALL open rows for the task
 *     via `resolveAllRowsForTask`. An operator never sees a stale failure alert
 *     for work that finished cleanly. A restarted-then-re-failed task re-raises
 *     a fresh row because the action queue is a pure projection of entity state.
 *   - `task.failed` → NO-OP. A failed task keeps its single actionable row;
 *     the operator resolves it explicitly (ADR-0028).
 *   - `task.terminal` with reason ∈ {done, dropped, purged} → legacy path:
 *     close open rows via `dismissAlertsOnStatusChange`. `purged` is emitted by
 *     dropTask before the row is deleted, so a removed task still closes its
 *     rows (ADR-0030).
 *   - `task.terminal` with reason 'failed' → NO-OP (same as the discrete event).
 *   - `task.queued` / `task.unblocked` → evict any stale failure row for a
 *     task that is live again.
 */
export const ALERT_DISMISSER_SUBSCRIBER = 'alert-dismisser'

/** Terminal reasons on which the Invalidator closes a task's rows. */
const CLOSE_ON_TERMINAL = new Set(['done', 'dropped', 'purged'])

/**
 * Decide whether an event should close the implicated task's rows, and under
 * what status label. Returns null for events the Invalidator ignores (which
 * still advance the cursor — they are not failures).
 */
function evictionFor(
  event: BusEvent<EventName>,
): { taskId: string; status: string } | null {
  if (event.type === 'task.terminal') {
    const { taskId, reason } = event.payload as {
      taskId: string
      reason: string
    }
    if (!CLOSE_ON_TERMINAL.has(reason)) return null // 'failed' stays open
    return { taskId, status: reason === 'done' ? 'done' : 'dropped' }
  }
  if (event.type === 'task.queued' || event.type === 'task.unblocked') {
    const taskId = (event.payload as { taskId: string }).taskId
    return { taskId, status: 'queued' }
  }
  return null
}

/**
 * Register the Invalidator subscriber. `replay: false` (ADR-0031 tail
 * default) so a fresh cursor sees only future events. Idempotent.
 */
export async function ensureAlertDismisser(client: Client): Promise<void> {
  await registerSubscriber(client, ALERT_DISMISSER_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Process every event the Invalidator has not yet acknowledged, in order.
 *
 * Each closing event resolves the implicated task's open Action-queue rows;
 * ignored events advance the cursor without side effect. Per-event side
 * effects are wrapped in `processedOnce` so a crash between the cursor
 * advance and the actionQueue write cannot double-apply, and a handler that
 * throws blocks the cursor on the failing event and raises a
 * subscriber-stalled actionQueue item after K consecutive failures (ADR-0032)
 * — all handled by the shared {@link drainWithStall} helper.
 *
 * @param client The libsql client carrying the outbox + actionQueue tables.
 * @param log    Optional logger callback for per-event failures.
 * @returns      The count of events whose side effect ran (closed rows).
 */
export async function drainAlertDismissals(
  client: Client,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: ALERT_DISMISSER_SUBSCRIBER,
    log,
    handle: async (event) => {
      // Discrete done/dropped: resolve ALL open rows.
      // An operator must never see a stale failure alert for finished work.
      if (event.type === 'task.completed' || event.type === 'task.dropped') {
        const { taskId } = event.payload as { taskId: string }
        await resolveAllRowsForTask(taskId)
        return true
      }

      // Legacy terminal / queued / unblocked path.
      const eviction = evictionFor(event)
      if (!eviction) return false // ignored event — advance cursor, no work
      await dismissAlertsOnStatusChange(eviction.taskId, eviction.status)
      return true
    },
  })
}
