import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbClient } from '../core/lib/db.js';
import { getTestDb } from '../../test/db-fixture.js';
import { publishWithRetry } from '../bus/publisher.js';
import { registerSubscriber, getCursor } from '../bus/subscribers.js';
import { startDispatcher, type Dispatcher } from './dispatcher.js';

describe('Dispatcher', () => {
  let client: DbClient;
  const dispatchers: Dispatcher[] = [];

  beforeEach(async () => {
    client = await getTestDb();
    dispatchers.length = 0;
  });

  afterEach(async () => {
    await Promise.all(dispatchers.map(d => d.stop()));
  });

  /** Register the dispatcher for cleanup even if the test fails partway. */
  function track(d: Dispatcher): Dispatcher {
    dispatchers.push(d);
    return d;
  }

  it('same-process publish triggers handler in under 50 ms', async () => {
    await registerSubscriber(client, 'fast', { replay: true });

    let resolveHandler!: () => void;
    const handlerCalled = new Promise<void>(r => {
      resolveHandler = r;
    });

    const dispatcher = track(
      startDispatcher(
        client,
        [{ name: 'fast', handler: async () => resolveHandler() }],
        { pollMs: 60_000 }, // Long poll — only the wake-hint should fire.
      ),
    );

    const before = Date.now();
    await publishWithRetry(client, 'task.queued', { taskId: 'wh1' });
    dispatcher.notify();

    await handlerCalled;
    expect(Date.now() - before).toBeLessThan(50);
  });

  it('cross-process write is picked up within the poll interval when wake-hints are suppressed', async () => {
    const pollMs = 80;
    await registerSubscriber(client, 'poller', { replay: true });

    let resolveHandler!: () => void;
    const handlerCalled = new Promise<void>(r => {
      resolveHandler = r;
    });

    track(
      startDispatcher(
        client,
        [{ name: 'poller', handler: async () => resolveHandler() }],
        { pollMs },
      ),
    );

    // Write directly to the DB — no notify() call, simulating a cross-process write.
    await client.execute({
      sql: 'INSERT INTO events (type, payload) VALUES (?, ?)',
      args: ['task.queued', JSON.stringify({ taskId: 'xp1' })],
    });

    // Must be picked up within two full poll intervals plus processing headroom.
    await Promise.race([
      handlerCalled,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`event not picked up within ${pollMs * 3} ms`)),
          pollMs * 3,
        ),
      ),
    ]);
  });

  it('handler throw does not advance the cursor', async () => {
    await registerSubscriber(client, 'failer', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'x1' });

    let resolveFirst!: () => void;
    const firstAttempt = new Promise<void>(r => {
      resolveFirst = r;
    });

    const dispatcher = track(
      startDispatcher(
        client,
        [
          {
            name: 'failer',
            handler: async () => {
              resolveFirst();
              throw new Error('deliberate failure');
            },
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    dispatcher.notify();
    await firstAttempt;

    // Cursor must remain at 0 — advanceCursor is never reached after a throw.
    const cursor = await getCursor(client, 'failer');
    expect(cursor).toBe(0);
  });

  it('one slow subscriber does not delay another subscriber\'s cursor advancement', async () => {
    await registerSubscriber(client, 'slow', { replay: true });
    await registerSubscriber(client, 'quick', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'shared' });

    let resolveQuick!: () => void;
    const quickDone = new Promise<void>(r => {
      resolveQuick = r;
    });

    const dispatcher = track(
      startDispatcher(
        client,
        [
          {
            name: 'slow',
            handler: async () => {
              await new Promise<void>(r => setTimeout(r, 1_000));
            },
          },
          {
            name: 'quick',
            handler: async () => resolveQuick(),
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    const before = Date.now();
    dispatcher.notify();

    await quickDone;
    // The quick subscriber must finish long before the slow subscriber's 1 s delay.
    expect(Date.now() - before).toBeLessThan(200);
  });

  it('replays the same event after a restart when the handler did not complete', async () => {
    await registerSubscriber(client, 'restarter', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'r1' });

    const deliveredIds: number[] = [];

    // First run: handler throws so the cursor is never advanced.
    const d1 = track(
      startDispatcher(
        client,
        [
          {
            name: 'restarter',
            handler: async event => {
              deliveredIds.push(event.id);
              throw new Error('crash');
            },
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    d1.notify();
    await vi.waitFor(() => expect(deliveredIds).toHaveLength(1), { timeout: 500 });

    await d1.stop();
    dispatchers.splice(dispatchers.indexOf(d1), 1); // Avoid double-stop in afterEach.

    // Second run: fresh dispatcher instance, same subscriber name and DB.
    const d2 = track(
      startDispatcher(
        client,
        [
          {
            name: 'restarter',
            handler: async event => {
              deliveredIds.push(event.id);
            },
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    d2.notify();
    await vi.waitFor(() => expect(deliveredIds).toHaveLength(2), { timeout: 500 });

    // Both deliveries must carry the same event id — the cursor was never advanced.
    expect(deliveredIds[0]).toBe(deliveredIds[1]);
  });
});
