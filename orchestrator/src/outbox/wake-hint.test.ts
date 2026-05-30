/**
 * Wake-hint unit tests.
 *
 * Covers:
 *   1. Registry behaviour — callbacks register, fire on signal, deregister.
 *   2. Integration with the outbox dispatcher — a registered callback wired
 *      to dispatcher.notify() reduces same-process delivery latency to under
 *      50 ms.
 *   3. Fallback delivery — removing the wake-hint (no registered callbacks)
 *      still delivers within the configured poll interval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
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
// DB helper — mirrors the fixture in dispatcher.test.ts.
// -------------------------------------------------------------------

async function makeClient(dir: string): Promise<Client> {
  const client = createClient({ url: `file:${join(dir, 'events.db')}` });
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      type    TEXT    NOT NULL,
      payload TEXT    NOT NULL,
      ts      INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  return client;
}

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
  let tmpDir: string;
  let client: Client;
  const dispatchers: Dispatcher[] = [];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-wake-hint-test-'));
    client = await makeClient(tmpDir);
    dispatchers.length = 0;
  });

  afterEach(async () => {
    await Promise.all(dispatchers.map(d => d.stop()));
    client.close();
    rmSync(tmpDir, { recursive: true, force: true });
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
    expect(elapsed).toBeLessThan(50);

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
