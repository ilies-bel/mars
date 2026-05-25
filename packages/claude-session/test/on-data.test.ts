import { afterEach, describe, expect, it } from 'vitest';
import { getSession, removeSession, start } from '../src/index.js';

// Collect spawned ids so we can kill / clean up after each test.
const spawned: string[] = [];

afterEach(() => {
  for (const id of spawned) {
    const session = getSession(id);
    if (session) {
      try {
        session.pty.kill();
      } catch {
        // already exited — that's fine
      }
      removeSession(id);
    }
  }
  spawned.length = 0;
});

describe('onData', () => {
  it('delivers PTY output chunks to a registered handler', async () => {
    const id = 'test-ondata-single';
    spawned.push(id);

    const handle = await start({
      id,
      cwd: process.cwd(),
      args: [process.execPath, '-e', 'process.stdout.write("hello-from-pty")'],
      env: {},
    });

    const received: string[] = [];
    handle.onData((chunk) => received.push(chunk));

    await new Promise<void>((resolve) => {
      handle.pty.onExit(() => resolve());
    });

    expect(received.join('')).toContain('hello-from-pty');
  });

  it('delivers the same chunks to two concurrent handlers', async () => {
    const id = 'test-ondata-two-handlers';
    spawned.push(id);

    const handle = await start({
      id,
      cwd: process.cwd(),
      args: [process.execPath, '-e', 'process.stdout.write("shared-output")'],
      env: {},
    });

    const received1: string[] = [];
    const received2: string[] = [];

    handle.onData((chunk) => received1.push(chunk));
    handle.onData((chunk) => received2.push(chunk));

    await new Promise<void>((resolve) => {
      handle.pty.onExit(() => resolve());
    });

    expect(received1.join('')).toContain('shared-output');
    expect(received2.join('')).toContain('shared-output');
  });

  it('stops delivering chunks to an unsubscribed handler while others still receive them', async () => {
    const id = 'test-ondata-unsub';
    spawned.push(id);

    // The process writes after a 60 ms delay, giving us time to unsubscribe
    // handler1 synchronously before any output arrives.
    const handle = await start({
      id,
      cwd: process.cwd(),
      args: [
        process.execPath,
        '-e',
        'setTimeout(() => process.stdout.write("after-unsub"), 60)',
      ],
      env: {},
    });

    const received1: string[] = [];
    const received2: string[] = [];

    const unsub = handle.onData((chunk) => received1.push(chunk));
    handle.onData((chunk) => received2.push(chunk));

    // Unsubscribe handler1 before the process produces any output.
    unsub();

    await new Promise<void>((resolve) => {
      handle.pty.onExit(() => resolve());
    });

    // handler1 was removed before any chunk arrived — it should receive nothing.
    expect(received1).toHaveLength(0);
    // handler2 was never unsubscribed — it should see the output.
    expect(received2.join('')).toContain('after-unsub');
  });
});
