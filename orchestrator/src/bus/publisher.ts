import type { Database } from 'better-sqlite3';
import { EventMap, type EventName, type EventPayload } from './events.js';

/**
 * Publish an event to the outbox.
 *
 * Validates `payload` against the registered zod schema for `type` and
 * inserts a row into `events`. Designed to be called inside a
 * `db.transaction(() => { ... })` so the event is committed atomically
 * with the state change it describes.
 *
 * Throws if the payload fails validation; the surrounding transaction
 * will then roll back, leaving no orphan event or partial state.
 */
export function publish<T extends EventName>(
  db: Database,
  type: T,
  payload: EventPayload<T>,
): void {
  const schema = EventMap[type];
  if (!schema) {
    throw new Error(`Unknown event type: ${String(type)}`);
  }
  const validated = schema.parse(payload);
  db.prepare('INSERT INTO events (type, payload) VALUES (?, ?)').run(
    type,
    JSON.stringify(validated),
  );
}
