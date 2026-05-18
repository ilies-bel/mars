import type { Transaction } from '@libsql/client';
import { EventMap, type EventName, type EventPayload } from './events.js';

/**
 * Publish an event to the outbox.
 *
 * Validates `payload` against the registered zod schema for `type` and
 * inserts a row into `events`. Call inside an active libsql write
 * transaction so the event commits atomically with the state row it
 * describes.
 *
 * Throws if the payload fails validation; the surrounding transaction
 * will then roll back, leaving no orphan event or partial state.
 */
export async function publish<T extends EventName>(
  tx: Transaction,
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  const schema = EventMap[type];
  if (!schema) {
    throw new Error(`Unknown event type: ${String(type)}`);
  }
  const validated = schema.parse(payload);
  await tx.execute({
    sql: 'INSERT INTO events (type, payload) VALUES (?, ?)',
    args: [type, JSON.stringify(validated)],
  });
}
