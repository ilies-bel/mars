import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { registerSubscriberName } from '../registry.js'

/** Durable subscriber id for Subject closure on declared domain events. */
export const CLOSE_SUBJECT_ON_TERMINAL_EVENT_SUBSCRIBER = 'close-subject-on-terminal-event'
registerSubscriberName(CLOSE_SUBJECT_ON_TERMINAL_EVENT_SUBSCRIBER)

/** Register the cursor before terminal events are published. Idempotent. */
export async function ensureCloseSubjectOnTerminalEventSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, CLOSE_SUBJECT_ON_TERMINAL_EVENT_SUBSCRIBER, { replay: false })
}

/**
 * Evaporate a Subject only when its declared event kind and entity id match an
 * outbox event. Entity ids are named consistently across Mars domain events,
 * so this supports proposal, task, action-queue, and scorer Subjects without
 * coupling the subscriber to one lifecycle.
 */
export async function drainCloseSubjectOnTerminalEvent(
  client: DbClient,
  log?: (message: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: CLOSE_SUBJECT_ON_TERMINAL_EVENT_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      const payload = event.payload as Record<string, unknown>
      const entityId =
        (typeof payload.proposalId === 'string' && payload.proposalId) ||
        (typeof payload.taskId === 'string' && payload.taskId) ||
        (typeof payload.itemId === 'string' && payload.itemId) ||
        (typeof payload.scorerId === 'string' && payload.scorerId)
      if (!entityId) return false

      const result = await client.execute({
        sql: `UPDATE chat_threads
                SET evaporated_at = now(), updated_at = now()
              WHERE terminal_event = ?
                AND terminal_entity_id = ?
                AND evaporated_at IS NULL`,
        args: [event.type, entityId],
      })
      return ((result as unknown as { rowsAffected?: number }).rowsAffected ?? 0) > 0
    },
  })
}
