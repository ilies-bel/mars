import type { Client } from '@libsql/client';
import type { BusEvent, EventName, EventPayload } from './events.js';

/**
 * Durable Subscriber cursor registry.
 *
 * A Subscriber is a named consumer of the Outbox `events` table. Its
 * cursor — the id of the last event it has acknowledged — is persisted
 * in the `subscribers` table so that delivery resumes across daemon
 * restarts without loss or replay.
 *
 * Bootstrap policy: a Subscriber that has never been seen before is
 * initialised to the current Outbox head (the max event id) so it
 * observes only future events. Pass `{ replay: true }` to start the
 * cursor at 0 instead and replay the full history.
 */

export interface RegisterOpts {
  /**
   * If true, the new Subscriber starts at cursor 0 and observes the
   * full event history. If false or omitted, the cursor is initialised
   * to the current Outbox head and the Subscriber observes only
   * future events.
   *
   * Ignored when the Subscriber already exists — re-registering never
   * resets an existing cursor.
   */
  replay?: boolean;
}

/**
 * Create the `subscribers` table if it does not exist. Idempotent.
 *
 * The schema is intentionally tiny: a Subscriber is just a name and a
 * cursor. Filter/replay policy lives in code, not the table.
 */
export async function ensureSubscribersSchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS subscribers (
      name   TEXT    PRIMARY KEY,
      cursor INTEGER NOT NULL
    )
  `);
}

async function currentHead(client: Client): Promise<number> {
  const result = await client.execute(
    'SELECT COALESCE(MAX(id), 0) AS head FROM events',
  );
  if (result.rows.length === 0) return 0;
  return Number(result.rows[0].head);
}

/**
 * Register a Subscriber by name. Idempotent: re-registering an
 * existing Subscriber returns immediately without touching its
 * cursor, regardless of `opts`.
 *
 * On first registration the cursor is initialised to the current
 * Outbox head, so the Subscriber observes only events published
 * after registration. Pass `{ replay: true }` to start at 0 and
 * observe the full history.
 */
export async function registerSubscriber(
  client: Client,
  name: string,
  opts?: RegisterOpts,
): Promise<void> {
  await ensureSubscribersSchema(client);

  const existing = await client.execute({
    sql: 'SELECT cursor FROM subscribers WHERE name = ?',
    args: [name],
  });
  if (existing.rows.length > 0) {
    // Re-registration is a no-op. Cursor is preserved.
    return;
  }

  const initialCursor = opts?.replay ? 0 : await currentHead(client);
  await client.execute({
    sql: 'INSERT INTO subscribers (name, cursor) VALUES (?, ?)',
    args: [name, initialCursor],
  });
}

/**
 * Return the current cursor for a Subscriber. Throws if the
 * Subscriber has not been registered.
 */
export async function getCursor(client: Client, name: string): Promise<number> {
  const result = await client.execute({
    sql: 'SELECT cursor FROM subscribers WHERE name = ?',
    args: [name],
  });
  if (result.rows.length === 0) {
    throw new Error(`Subscriber not registered: ${name}`);
  }
  return Number(result.rows[0].cursor);
}

/**
 * Advance the cursor for a Subscriber to `eventId`. Call this only
 * after the Subscriber has fully processed the event with that id.
 *
 * The cursor only moves forward: an advance to a lower id is a no-op.
 * Throws if the Subscriber has not been registered.
 */
export async function advanceCursor(
  client: Client,
  name: string,
  eventId: number,
): Promise<void> {
  const result = await client.execute({
    sql: 'UPDATE subscribers SET cursor = ? WHERE name = ? AND cursor < ?',
    args: [eventId, name, eventId],
  });
  if (result.rowsAffected === 0) {
    // Either the subscriber doesn't exist or the cursor was already
    // at or beyond eventId. Distinguish the two so callers get a
    // clear error for the former.
    const exists = await client.execute({
      sql: 'SELECT 1 FROM subscribers WHERE name = ?',
      args: [name],
    });
    if (exists.rows.length === 0) {
      throw new Error(`Subscriber not registered: ${name}`);
    }
  }
}

/**
 * Return the events the Subscriber has not yet acknowledged, in
 * ascending id order. The cursor is NOT advanced — call
 * {@link advanceCursor} after the events are processed.
 */
export async function fetchPending(
  client: Client,
  name: string,
): Promise<BusEvent[]> {
  const cursor = await getCursor(client, name);
  const result = await client.execute({
    sql: 'SELECT id, type, payload, ts FROM events WHERE id > ? ORDER BY id ASC',
    args: [cursor],
  });
  return result.rows.map(row => {
    const type = row.type as EventName;
    return {
      id: Number(row.id),
      type,
      payload: JSON.parse(row.payload as string) as EventPayload<typeof type>,
      ts: Number(row.ts),
    };
  });
}
