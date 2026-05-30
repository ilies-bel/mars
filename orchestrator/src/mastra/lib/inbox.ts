import type { Client } from '@libsql/client';

/**
 * Inbox row management for the `subscriber_stalls` table.
 *
 * A row in `subscriber_stalls` represents an open inbox item: a durable
 * Subscriber whose handler has stalled on a particular event (failed
 * STALL_THRESHOLD consecutive times). The Invalidator subscriber
 * (`outbox/subscribers/invalidator.ts`) reacts to `subscriber.unstalled`
 * Outbox events to close these rows automatically — no operator action
 * required once the underlying failure resolves.
 */

/**
 * Create the `subscriber_stalls` inbox table if it does not exist.
 * Idempotent — safe to call on every startup.
 */
export async function ensureInboxSchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS subscriber_stalls (
      subscriber_id TEXT    NOT NULL,
      event_id      INTEGER NOT NULL,
      last_error    TEXT    NOT NULL,
      raised_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (subscriber_id, event_id)
    )
  `);
}

/**
 * Close (delete) the inbox row for the given (subscriberId, eventId) pair.
 * Idempotent — a no-op if the row does not exist.
 */
export async function closeInboxRow(
  client: Client,
  subscriberId: string,
  eventId: number,
): Promise<void> {
  await client.execute({
    sql: 'DELETE FROM subscriber_stalls WHERE subscriber_id = ? AND event_id = ?',
    args: [subscriberId, eventId],
  });
}
