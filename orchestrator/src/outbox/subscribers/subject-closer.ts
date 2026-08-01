import type { DbClient } from '../../core/lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { registerSubscriberName } from '../registry.js'

/** Durable cursor that observes domain events which end Subjects. */
export const SUBJECT_CLOSER_SUBSCRIBER = 'subject-closer'
registerSubscriberName(SUBJECT_CLOSER_SUBSCRIBER)

/** Register the durable cursor before terminal events are published. */
export async function ensureSubjectCloser(client: DbClient): Promise<void> {
  await registerSubscriber(client, SUBJECT_CLOSER_SUBSCRIBER, { replay: false })
}

/**
 * Close every open Subject whose declared event type and entity match one
 * durable Outbox event. The UPDATE condition makes re-delivery harmless: a
 * closed Subject retains its original boundary timestamp and no new record is
 * written.
 */
export async function drainSubjectCloser(
  client: DbClient,
  log?: (message: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: SUBJECT_CLOSER_SUBSCRIBER,
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
                SET closed_at = ?
              WHERE terminal_event_type = ?
                AND terminal_entity_id = ?
                AND closed_at IS NULL`,
        args: [Date.now(), event.type, entityId],
      })
      return ((result as unknown as { rowsAffected?: number }).rowsAffected ?? 0) > 0
    },
  })
}
