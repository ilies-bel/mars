import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbClient } from '../../core/lib/db.js';
import { ensureSchema } from '../../core/lib/pg-schema.js';
import { publishWithRetry } from '../../bus/publisher.js';
import { registerSubscriber, getCursor } from '../../bus/subscribers.js';
import {
  INVALIDATOR_SUBSCRIBER,
  ensureInvalidator,
  drainInvalidations,
} from './invalidator.js';

let dbSeq = 0;

/**
 * Fresh in-memory PGlite instance per test carrying the canonical schema
 * (`events` + `subscriber_stalls` + `subscribers`; MARS_DB_BACKEND=pglite is
 * set by test/setup-env.ts, the target string is only an identity key).
 * Returns the key too so a test can model a reconnect: `openDb` with the
 * same key hands back a handle onto the same instance, mirroring a daemon
 * restart against the same durable database.
 */
async function makeClient(): Promise<{ client: DbClient; key: string }> {
  const key = `test:invalidator:${process.pid}:${dbSeq++}`;
  const client = openDb(key);
  await ensureSchema(client);
  return { client, key };
}

async function insertStallRow(
  client: DbClient,
  subscriberId: string,
  eventId: number,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO subscriber_stalls (subscriber_id, event_id, last_error)
          VALUES (?, ?, ?)
          ON CONFLICT (subscriber_id, event_id) DO NOTHING`,
    args: [subscriberId, eventId, 'test-error'],
  });
}

async function stallRowExists(
  client: DbClient,
  subscriberId: string,
  eventId: number,
): Promise<boolean> {
  const r = await client.execute({
    sql: 'SELECT 1 FROM subscriber_stalls WHERE subscriber_id = ? AND event_id = ? LIMIT 1',
    args: [subscriberId, eventId],
  });
  return r.rows.length > 0;
}

describe('Invalidator outbox subscriber', () => {
  let client: DbClient;
  let dbKey: string;

  beforeEach(async () => {
    const made = await makeClient();
    client = made.client;
    dbKey = made.key;
  });

  afterEach(async () => {
    await client.close();
  });

  it('auto-closes a stall row whose justifying condition is resolved', async () => {
    // Register first so the cursor is at the current outbox head.
    await ensureInvalidator(client);

    // Simulate: a subscriber stalled on event 5 → stall row raised.
    await insertStallRow(client, 'sub-a', 5);
    expect(await stallRowExists(client, 'sub-a', 5)).toBe(true);

    // Simulate: the stalled handler eventually succeeds → subscriber.unstalled
    // published to the Outbox (done by startStallAwareDispatcher in production).
    await publishWithRetry(client, 'subscriber.unstalled', {
      subscriberId: 'sub-a',
      eventId: 5,
    });

    const { processed } = await drainInvalidations(client);

    expect(processed).toBe(1);
    expect(await stallRowExists(client, 'sub-a', 5)).toBe(false);
  });

  it('daemon restart between the resolving write and auto-close still closes the row', async () => {
    // Register the Invalidator with a cursor at 0 (no events yet).
    await ensureInvalidator(client);

    await insertStallRow(client, 'sub-b', 3);
    // Publish the resolving event — this is the "resolving state-write".
    await publishWithRetry(client, 'subscriber.unstalled', {
      subscriberId: 'sub-b',
      eventId: 3,
    });

    // Simulate a daemon restart: acquire a fresh handle onto the same
    // database (the process-wide registry hands back the shared instance;
    // cursor and stall row live in the DB, not in any drained state).
    const clientAfterRestart = openDb(dbKey);

    try {
      // The cursor is still in the DB pointing before the subscriber.unstalled
      // event. drainInvalidations replays from the cursor and closes the row.
      const { processed } = await drainInvalidations(clientAfterRestart);

      expect(processed).toBe(1);
      expect(await stallRowExists(clientAfterRestart, 'sub-b', 3)).toBe(false);
    } finally {
      await clientAfterRestart.close();
    }
  });

  it('does not close a stall row whose justifying condition still holds', async () => {
    await ensureInvalidator(client);

    // Insert a stall row but do NOT publish subscriber.unstalled.
    await insertStallRow(client, 'sub-c', 7);

    const { processed } = await drainInvalidations(client);

    expect(processed).toBe(0);
    expect(await stallRowExists(client, 'sub-c', 7)).toBe(true);
  });

  it('advances the cursor past non-invalidation events without closing any row', async () => {
    await ensureInvalidator(client);

    const cursorBefore = await getCursor(client, INVALIDATOR_SUBSCRIBER);

    // Publish an unrelated event.
    await publishWithRetry(client, 'task.queued', { taskId: 'T-1' });

    const { processed } = await drainInvalidations(client);

    expect(processed).toBe(0);
    const cursorAfter = await getCursor(client, INVALIDATOR_SUBSCRIBER);
    expect(cursorAfter).toBeGreaterThan(cursorBefore);
  });

  it('is idempotent — draining the same events twice processes them only once', async () => {
    await ensureInvalidator(client);

    await insertStallRow(client, 'sub-d', 9);
    await publishWithRetry(client, 'subscriber.unstalled', {
      subscriberId: 'sub-d',
      eventId: 9,
    });

    const first = await drainInvalidations(client);
    const second = await drainInvalidations(client);

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(0); // cursor already past; nothing pending
    expect(await stallRowExists(client, 'sub-d', 9)).toBe(false);
  });
});
