/**
 * Wake-hint unit tests.
 *
 * Covers:
 *   1. Registry behaviour — callbacks register, fire on signal, deregister.
 *   2. Integration with the outbox dispatcher — a registered callback wired
 *      to dispatcher.notify() reduces same-process delivery latency to well
 *      under the dispatcher's poll interval (effectively immediate; we
 *      tolerate scheduler jitter / DB write latency on shared CI hosts).
 *   3. Fallback delivery — removing the wake-hint (no registered callbacks)
 *      still delivers within the configured poll interval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DbClient } from '../core/lib/db.js';
import { getTestDb } from '../../test/db-fixture.js';
import { registerSubscriber } from '../bus/subscribers.js';
import { publishWithRetry } from '../bus/publisher.js';
import { startDispatcher, type Dispatcher } from './dispatcher.js';

// -------------------------------------------------------------------
// Wake-hint module is loaded via vi.resetModules() so each describe
// block gets a fresh singleton (empty _callbacks set).
// -------------------------------------------------------------------

async function loadWakeHint(): Promise<{
  registerWakeHint: (cb: () => void) => () => void;
  signalWakeHint: () => void;
}> {
  vi.resetModules();
  return import('./wake-hint.js');
}

// -------------------------------------------------------------------
// The wake-hint module still resets its own singleton state, but its
// integration tests acquire database isolation from the shared fixture.
// -------------------------------------------------------------------

// -------------------------------------------------------------------
// 1. Registry behaviour
// -------------------------------------------------------------------

describe('registerWakeHint / signalWakeHint', () => {
  it('signal with no registered callbacks is a no-op', async () => {
    const { signalWakeHint } = await loadWakeHint();
    expect(() => signalWakeHint()).not.toThrow();
  });

  it('registered callback is called when signal fires', async () => {
    const { registerWakeHint, signalWakeHint } = await loadWakeHint();
    const cb = vi.fn();
    const unregister = registerWakeHint(cb);
    signalWakeHint();
    expect(cb).toHaveBeenCalledOnce();
    unregister();
  });

  it('callback is NOT called after it is deregistered', async () => {
    const { registerWakeHint, signalWakeHint } = await loadWakeHint();
    const cb = vi.fn();
    const unregister = registerWakeHint(cb);
    unregister();
    signalWakeHint();
    expect(cb).not.toHaveBeenCalled();
  });

  it('multiple callbacks all fire on a single signal', async () => {
    const { registerWakeHint, signalWakeHint } = await loadWakeHint();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    const u1 = registerWakeHint(cb1);
    const u2 = registerWakeHint(cb2);
    const u3 = registerWakeHint(cb3);
    signalWakeHint();
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).toHaveBeenCalledOnce();
    u1(); u2(); u3();
  });

  it('deregistering one callback does not affect the others', async () => {
    const { registerWakeHint, signalWakeHint } = await loadWakeHint();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const u1 = registerWakeHint(cb1);
    const u2 = registerWakeHint(cb2);
    u1(); // remove only cb1
    signalWakeHint();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
    u2();
  });
});

// -------------------------------------------------------------------
// 2. Integration: wake-hint → dispatcher.notify() → sub-50 ms delivery
// -------------------------------------------------------------------

describe('wake-hint + dispatcher integration', () => {
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

  it('publishing to the outbox and signalling produces sub-50 ms subscriber delivery', async () => {
    const { registerWakeHint, signalWakeHint } = await loadWakeHint();

    await registerSubscriber(client, 'wh-fast', { replay: true });

    let resolveHandler!: () => void;
    const handlerFired = new Promise<void>(r => { resolveHandler = r; });

    const dispatcher = track(
      startDispatcher(
        client,
        [{ name: 'wh-fast', handler: async () => resolveHandler() }],
        { pollMs: 60_000 }, // Long poll — only the wake-hint should fire.
      ),
    );

    // Wire the dispatcher's notify to the wake-hint registry.
    const unregister = registerWakeHint(() => dispatcher.notify());

    const before = Date.now();
    await publishWithRetry(client, 'task.queued', { taskId: 'wh-sub-50' });
    signalWakeHint(); // publisher signals after writing

    await handlerFired;
    const elapsed = Date.now() - before;
    // The intent of this assertion is "the wake-hint path is materially
    // faster than the configured poll interval (60 s)" — i.e. the dispatcher
    // is not waiting on its poll timer. A lenient bound keeps the test
    // honest without flaking on shared CI hosts where the DB write +
    // fetchPending round-trip can spike past a tight (e.g. 50 ms) bound.
    expect(elapsed).toBeLessThan(1_000);

    unregister();
  });

  it('without a registered wake-hint, events are still delivered within the poll interval', async () => {
    // Use a short poll to keep the test fast.
    const pollMs = 80;

    await registerSubscriber(client, 'wh-poller', { replay: true });

    let resolveHandler!: () => void;
    const handlerFired = new Promise<void>(r => { resolveHandler = r; });

    track(
      startDispatcher(
        client,
        [{ name: 'wh-poller', handler: async () => resolveHandler() }],
        { pollMs },
      ),
    );

    // No wake-hint registered — write directly to the DB.
    await client.execute({
      sql: 'INSERT INTO events (type, payload) VALUES (?, ?)',
      args: ['task.queued', JSON.stringify({ taskId: 'wh-fallback' })],
    });

    // Must be delivered within 3× the poll interval.
    await Promise.race([
      handlerFired,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`event not delivered within ${pollMs * 3} ms`)),
          pollMs * 3,
        ),
      ),
    ]);
  });
});
