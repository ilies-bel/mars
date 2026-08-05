/**
 * Integration tests for the full subscriber unstall flow.
 *
 * When a stalled Subscriber's handler eventually succeeds:
 *   1. Its cursor advances past the blocking event (no operator action needed).
 *   2. A `subscriber.unstalled` event is published to the Outbox.
 *   3. The Invalidator processes that event and auto-closes the stall row.
 *   4. Re-stalling on the same (subscriber, event) after the row is closed
 *      inserts a fresh row — the previous one is not "reopened".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbClient } from '../core/lib/db.js';
import { getTestDb } from '../../test/db-fixture.js';
import { publishWithRetry } from '../bus/publisher.js';
import { registerSubscriber, getCursor } from '../bus/subscribers.js';
import {
  startStallAwareDispatcher,
  STALL_THRESHOLD,
  type StallAwareDispatcher,
} from './stall.js';
import {
  ensureInvalidator,
  drainInvalidations,
} from './subscribers/invalidator.js';

describe('Subscriber unstall flow', () => {
  let client: DbClient;
  const dispatchers: StallAwareDispatcher[] = [];

  beforeEach(async () => {
    client = await getTestDb();
    dispatchers.length = 0;
  });

  afterEach(async () => {
    await Promise.all(dispatchers.map(d => d.stop()));
  });

  function track(d: StallAwareDispatcher): StallAwareDispatcher {
    dispatchers.push(d);
    return d;
  }

  async function stallRowCount(): Promise<number> {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM subscriber_stalls`);
    return Number((r.rows[0] as unknown as { n: number | bigint }).n);
  }

  it('cursor advances past the blocking event without operator action when the stall clears', async () => {
    await registerSubscriber(client, 'sub-a', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'cursor-test' });

    const cursorBefore = await getCursor(client, 'sub-a');
    let callCount = 0;

    track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-a',
            handler: async () => {
              callCount++;
              if (callCount <= STALL_THRESHOLD) {
                throw new Error('deliberate-fail');
              }
              // Succeeds on call STALL_THRESHOLD + 1 — cursor advances
            },
          },
        ],
        { pollMs: 20 },
      ),
    ).notify();

    await vi.waitFor(
      async () =>
        expect(await getCursor(client, 'sub-a')).toBeGreaterThan(cursorBefore),
      { timeout: 3_000 },
    );
  });

  it('publishes a subscriber.unstalled event when the stall clears', async () => {
    await registerSubscriber(client, 'sub-b', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'unstall-event-test' });

    let callCount = 0;

    track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-b',
            handler: async () => {
              callCount++;
              if (callCount <= STALL_THRESHOLD) {
                throw new Error('deliberate-fail');
              }
            },
          },
        ],
        { pollMs: 20 },
      ),
    ).notify();

    await vi.waitFor(
      async () => {
        const rows = await client.execute(
          `SELECT payload FROM events WHERE type = 'subscriber.unstalled'`,
        );
        expect(rows.rows).toHaveLength(1);
        const payload = JSON.parse(String(rows.rows[0].payload)) as {
          subscriberId: string;
          eventId: number;
        };
        expect(payload.subscriberId).toBe('sub-b');
        expect(typeof payload.eventId).toBe('number');
      },
      { timeout: 3_000 },
    );
  });

  it('stall row is closed automatically via the Invalidator path when the stall clears', async () => {
    // Register Invalidator first (no events yet → cursor = 0) so it sees
    // the subscriber.unstalled event that will be emitted later.
    await ensureInvalidator(client);
    await registerSubscriber(client, 'sub-c', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'stall-close-test' });

    let callCount = 0;

    track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-c',
            handler: async () => {
              callCount++;
              if (callCount <= STALL_THRESHOLD) {
                throw new Error('deliberate-fail');
              }
            },
          },
        ],
        { pollMs: 20 },
      ),
    ).notify();

    // Wait for the stall to be declared — the stall row must exist first.
    await vi.waitFor(
      async () => expect(await stallRowCount()).toBe(1),
      { timeout: 2_000 },
    );

    // Wait for the handler to succeed and subscriber.unstalled to be written.
    await vi.waitFor(
      async () => {
        const rows = await client.execute(
          `SELECT 1 FROM events WHERE type = 'subscriber.unstalled' LIMIT 1`,
        );
        expect(rows.rows).toHaveLength(1);
      },
      { timeout: 3_000 },
    );

    // The Invalidator is a pull-based subscriber; drain it now to auto-close.
    const { processed } = await drainInvalidations(client);

    expect(processed).toBe(1);
    expect(await stallRowCount()).toBe(0);
  });

  it('raises a fresh stall row when the Subscriber re-stalls after the previous row was closed', async () => {
    await registerSubscriber(client, 'sub-d', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 're-stall-test' });

    // First stall: handler always fails → stall row raised.
    const dispatcher1 = track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-d',
            handler: async () => {
              throw new Error('initial-error');
            },
          },
        ],
        { pollMs: 20 },
      ),
    );
    dispatcher1.notify();

    await vi.waitFor(
      async () => expect(await stallRowCount()).toBe(1),
      { timeout: 2_000 },
    );

    // Simulate the Invalidator closing the stall row (as it does in production
    // when subscriber.unstalled is emitted and drained).
    await client.execute({
      sql: 'DELETE FROM subscriber_stalls WHERE subscriber_id = ?',
      args: ['sub-d'],
    });
    expect(await stallRowCount()).toBe(0);

    // Stop the first dispatcher — this clears its in-memory `declared` set
    // (analogous to a daemon restart).
    await dispatcher1.stop();

    // Second stall: new dispatcher (fresh declared/failureCounts maps) with
    // the same failing handler. The cursor is still blocked on the same event
    // because the handler never succeeded.
    track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-d',
            handler: async () => {
              throw new Error('reverted-error');
            },
          },
        ],
        { pollMs: 20 },
      ),
    ).notify();

    // A fresh stall row must be raised — the previously closed row is not reopened.
    await vi.waitFor(
      async () => expect(await stallRowCount()).toBe(1),
      { timeout: 2_000 },
    );

    const rows = await client.execute(
      `SELECT subscriber_id, last_error FROM subscriber_stalls`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0].subscriber_id)).toBe('sub-d');
    // The error text comes from the new dispatcher run, confirming a fresh row.
    expect(String(rows.rows[0].last_error)).toBe('reverted-error');
  });
});
