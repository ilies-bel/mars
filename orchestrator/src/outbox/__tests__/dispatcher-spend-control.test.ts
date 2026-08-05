import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbClient } from '../../core/lib/db.js';
import { getTestDb } from '../../../test/db-fixture.js';
import { publishWithRetry } from '../../bus/publisher.js';
import { registerSubscriber } from '../../bus/subscribers.js';
import { upsertSpendControl } from '../../core/daemon/spend-control/store.js';
import { startDispatcher, type Dispatcher } from '../dispatcher.js';

describe('Dispatcher spend-control', () => {
  let client: DbClient;
  const dispatchers: Dispatcher[] = [];

  beforeEach(async () => {
    client = await getTestDb();
    dispatchers.length = 0;
  });

  afterEach(async () => {
    await Promise.all(dispatchers.map(d => d.stop()));
  });

  function track(d: Dispatcher): Dispatcher {
    dispatchers.push(d);
    return d;
  }

  it('paused spend-control decision blocks all dispatch', async () => {
    await registerSubscriber(client, 'any-worker', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'sc-pause-1' });

    let dispatched = false;
    const dispatcher = track(
      startDispatcher(
        client,
        [{ name: 'any-worker', handler: async () => { dispatched = true; } }],
        {
          pollMs: 60_000,
          spendControl: {
            // usedPct 100% >= default pauseThresholdPct 90% → paused
            getSpendWindow: () => ({ usedPct: 100, wasPaused: false }),
          },
        },
      ),
    );

    dispatcher.notify();
    // Give the loop time to attempt dispatch.
    await new Promise<void>(r => setTimeout(r, 100));

    expect(dispatched).toBe(false);
  });

  it('coder ceiling of 1 blocks additional coder dispatch but allows writer', async () => {
    await registerSubscriber(client, 'coder-1', { replay: true });
    await registerSubscriber(client, 'coder-2', { replay: true });
    await registerSubscriber(client, 'writer', { replay: true });

    // Publish one event — all three subscribers will each see it via their own cursor.
    await publishWithRetry(client, 'task.queued', { taskId: 'sc-ceiling-1' });

    // Set coder ceiling to 1.
    await upsertSpendControl(client, { perKindCeilings: { coder: 1 } });

    let coderCallCount = 0;
    let writerDispatched = false;

    // Each coder handler blocks until explicitly resolved.
    const resolvers: Array<() => void> = [];

    const dispatcher = track(
      startDispatcher(
        client,
        [
          {
            name: 'coder-1',
            kind: 'coder',
            handler: async () => {
              coderCallCount++;
              await new Promise<void>(r => { resolvers.push(r); });
            },
          },
          {
            name: 'coder-2',
            kind: 'coder',
            handler: async () => {
              coderCallCount++;
              await new Promise<void>(r => { resolvers.push(r); });
            },
          },
          {
            name: 'writer',
            kind: 'writer',
            handler: async () => { writerDispatched = true; },
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    dispatcher.notify();

    // Writer (different kind, no ceiling) should dispatch freely.
    await vi.waitFor(() => expect(writerDispatched).toBe(true), { timeout: 500 });

    // Allow time for a ceiling violation to manifest — only 1 coder should run.
    await new Promise<void>(r => setTimeout(r, 100));
    expect(coderCallCount).toBe(1);

    // Unblock the in-flight coder; the dispatcher notifies waiting loops.
    resolvers[0]?.();

    // The second coder should now be able to dispatch.
    await vi.waitFor(() => expect(coderCallCount).toBe(2), { timeout: 500 });

    // Unblock all in-flight handlers so the dispatcher can stop cleanly.
    resolvers.forEach(r => r());
  });
});
