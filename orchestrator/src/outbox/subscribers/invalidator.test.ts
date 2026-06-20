import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { publishWithRetry } from '../../bus/publisher.js';
import { registerSubscriber, getCursor } from '../../bus/subscribers.js';
import { ensureStallSchema } from '../stall.js';
import {
  INVALIDATOR_SUBSCRIBER,
  ensureInvalidator,
  drainInvalidations,
} from './invalidator.js';

/**
 * File-backed libsql client with the production `events` + subscriber_stalls schemas.
 * File-backed (not :memory:) so a second connection to the same path sees
 * the same data, which lets us simulate a daemon restart mid-test.
 */
async function makeClient(dir: string): Promise<Client> {
  const client = createClient({ url: `file:${join(dir, 'test.db')}` });
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      type    TEXT    NOT NULL,
      payload TEXT    NOT NULL,
      ts      INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  await ensureStallSchema(client);
  return client;
}

async function insertStallRow(
  client: Client,
  subscriberId: string,
  eventId: number,
): Promise<void> {
  await client.execute({
    sql: `INSERT OR IGNORE INTO subscriber_stalls (subscriber_id, event_id, last_error)
          VALUES (?, ?, ?)`,
    args: [subscriberId, eventId, 'test-error'],
  });
}

async function stallRowExists(
  client: Client,
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
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-invalidator-test-'));
    client = await makeClient(tmpDir);
  });

  afterEach(async () => {
    client.close();
    rmSync(tmpDir, { recursive: true, force: true });
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

    // Simulate a daemon crash: close the client without draining.
    client.close();

    // Restart: open a new connection to the same on-disk database.
    const clientAfterRestart = createClient({
      url: `file:${join(tmpDir, 'test.db')}`,
    });

    try {
      // The cursor is still in the DB pointing before the subscriber.unstalled
      // event. drainInvalidations replays from the cursor and closes the row.
      const { processed } = await drainInvalidations(clientAfterRestart);

      expect(processed).toBe(1);
      expect(await stallRowExists(clientAfterRestart, 'sub-b', 3)).toBe(false);
    } finally {
      clientAfterRestart.close();
      // Prevent afterEach from trying to close the already-closed original client.
      client = clientAfterRestart; // afterEach will close this one; it's already closed — that's fine because close() is idempotent
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
