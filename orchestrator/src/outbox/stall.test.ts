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

describe('StallAwareDispatcher', () => {
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

  async function openStallCount(): Promise<number> {
    const r = await client.execute(
      `SELECT COUNT(*) AS n FROM subscriber_stalls`,
    );
    return Number((r.rows[0] as unknown as { n: number | bigint }).n);
  }

  it('three consecutive failures raise exactly one stall row that names subscriber, event id, and last error', async () => {
    await registerSubscriber(client, 'sub-a', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'x1' });

    const eventIdRow = await client.execute('SELECT MAX(id) AS id FROM events');
    const eventId = Number((eventIdRow.rows[0] as unknown as { id: number }).id);

    let attempt = 0;
    track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-a',
            handler: async () => {
              attempt++;
              throw new Error('deliberate-error');
            },
          },
        ],
        // Short poll so the three consecutive failures happen without manual
        // notify() calls — robust to the wake-hint race in the catch block.
        { pollMs: 20 },
      ),
    ).notify();

    // Wait for stall declaration (requires STALL_THRESHOLD failures)
    await vi.waitFor(
      async () => expect(await openStallCount()).toBe(1),
      { timeout: 2_000 },
    );

    const rows = await client.execute(
      `SELECT subscriber_id, event_id, last_error FROM subscriber_stalls`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0].subscriber_id)).toBe('sub-a');
    expect(Number(rows.rows[0].event_id)).toBe(eventId);
    expect(String(rows.rows[0].last_error)).toBe('deliberate-error');
    expect(attempt).toBeGreaterThanOrEqual(STALL_THRESHOLD);
  });

  it('a fourth failure on the same event id does not raise an additional stall row', async () => {
    await registerSubscriber(client, 'sub-b', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'x2' });

    track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-b',
            handler: async () => {
              throw new Error('persistent-error');
            },
          },
        ],
        { pollMs: 20 },
      ),
    ).notify();

    // Wait for the stall to be declared (exactly one row)
    await vi.waitFor(
      async () => expect(await openStallCount()).toBe(1),
      { timeout: 2_000 },
    );

    // Let the dispatcher keep retrying past the threshold
    await new Promise<void>(r => setTimeout(r, 150));

    // Must still be exactly one row — further failures must not duplicate
    expect(await openStallCount()).toBe(1);
  });

  it('other subscribers continue advancing their cursors while one is stalled', async () => {
    await registerSubscriber(client, 'staller', { replay: true });
    await registerSubscriber(client, 'advancer', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'shared' });

    const advancerCursorBefore = await getCursor(client, 'advancer');

    let resolveAdvanced!: () => void;
    const advanced = new Promise<void>(r => {
      resolveAdvanced = r;
    });

    const d = track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'staller',
            handler: async () => {
              throw new Error('stall-me');
            },
          },
          {
            name: 'advancer',
            handler: async () => {
              resolveAdvanced();
            },
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    d.notify();

    // Wait for the handler to run; then wait for the cursor to actually
    // advance (advanceCursor is called after the handler returns, so there
    // is a brief async gap between resolveAdvanced() and the DB write).
    await advanced;
    await vi.waitFor(
      async () =>
        expect(await getCursor(client, 'advancer')).toBeGreaterThan(
          advancerCursorBefore,
        ),
      { timeout: 500 },
    );

    // Staller's cursor is still blocked — it has not advanced
    const stallerCursor = await getCursor(client, 'staller');
    expect(stallerCursor).toBe(advancerCursorBefore);
  });

  it('a subscriber.stalled event is written to the Outbox when the stall is declared', async () => {
    await registerSubscriber(client, 'sub-c', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'x3' });

    track(
      startStallAwareDispatcher(
        client,
        [
          {
            name: 'sub-c',
            handler: async () => {
              throw new Error('stall-event-test');
            },
          },
        ],
        { pollMs: 20 },
      ),
    ).notify();

    // Wait for the subscriber.stalled event to appear in the outbox
    await vi.waitFor(
      async () => {
        const rows = await client.execute(
          `SELECT type FROM events WHERE type = 'subscriber.stalled'`,
        );
        expect(rows.rows).toHaveLength(1);
      },
      { timeout: 2_000 },
    );

    // Verify the event payload names the subscriber, event id, and error
    const rows = await client.execute(
      `SELECT payload FROM events WHERE type = 'subscriber.stalled'`,
    );
    const payload = JSON.parse(String(rows.rows[0].payload)) as {
      subscriberId: string;
      eventId: number;
      lastError: string;
    };
    expect(payload.subscriberId).toBe('sub-c');
    expect(typeof payload.eventId).toBe('number');
    expect(payload.lastError).toBe('stall-event-test');
  });
});
