import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbClient } from '../../core/lib/db.js';
import { getTestDb } from '../../../test/db-fixture.js';
import { publishWithRetry } from '../../bus/publisher.js';
import { registerSubscriber, getCursor } from '../../bus/subscribers.js';
import { apiCircuitBreaker } from '../../core/lib/api-circuit-breaker.js';
import { startDispatcher, type Dispatcher } from '../dispatcher.js';

describe('Dispatcher breaker gate', () => {
  let client: DbClient;
  const dispatchers: Dispatcher[] = [];

  beforeEach(async () => {
    client = await getTestDb();
    dispatchers.length = 0;
    apiCircuitBreaker.close(); // ensure clean state before each test
  });

  afterEach(async () => {
    await Promise.all(dispatchers.map(d => d.stop()));
    apiCircuitBreaker.close(); // reset singleton after each test
  });

  function track(d: Dispatcher): Dispatcher {
    dispatchers.push(d);
    return d;
  }

  it('holds a code-phase event when the breaker is open and dispatches it after close', async () => {
    await registerSubscriber(client, 'code-worker', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'ct1' });

    apiCircuitBreaker.open('connection refused', 1000);

    let dispatched = false;
    const dispatcher = track(
      startDispatcher(
        client,
        [
          {
            name: 'code-worker',
            handler: async () => {
              dispatched = true;
            },
            gatedByApiBreaker: true,
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    // First tick — breaker is open; nothing should be dispatched.
    dispatcher.notify();
    await new Promise<void>(r => setTimeout(r, 50));

    expect(dispatched).toBe(false);
    // Cursor must remain at 0 — event was not acknowledged.
    const cursorWhileOpen = await getCursor(client, 'code-worker');
    expect(cursorWhileOpen).toBe(0);

    // Close the breaker and trigger the next tick — task should now dispatch.
    apiCircuitBreaker.close();
    dispatcher.notify();

    await vi.waitFor(() => expect(dispatched).toBe(true), { timeout: 500 });
  });

  it('does not gate non-code subscribers when the breaker is open', async () => {
    await registerSubscriber(client, 'non-code-worker', { replay: true });
    await publishWithRetry(client, 'task.queued', { taskId: 'nct1' });

    apiCircuitBreaker.open('connection refused', 1000);

    let dispatched = false;
    const dispatcher = track(
      startDispatcher(
        client,
        [
          {
            name: 'non-code-worker',
            // No gatedByApiBreaker — this subscriber runs regardless of breaker state.
            handler: async () => {
              dispatched = true;
            },
          },
        ],
        { pollMs: 60_000 },
      ),
    );

    dispatcher.notify();

    await vi.waitFor(() => expect(dispatched).toBe(true), { timeout: 500 });
  });
});
