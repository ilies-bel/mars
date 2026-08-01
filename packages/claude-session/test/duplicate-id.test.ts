import { describe, it, expect, afterEach } from 'vitest';
import { start, getSession, removeSession } from '../src/index.js';

// Track spawned ids so we can clean up after each test.
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

describe('duplicate session id rejection', () => {
  it('rejects with a clear error when start is called with an id already in use', async () => {
    const id = 'dup-reject-test';
    spawned.push(id);

    await start({
      id,
      cwd: process.cwd(),
      args: ['sleep', '30'],
      env: {},
    });

    await expect(
      start({
        id,
        cwd: process.cwd(),
        args: ['sleep', '30'],
        env: {},
      }),
      // The message must name the offending id AND the way out — "already in
      // use" alone left callers guessing. src/start.ts rejects before spawning
      // so no process leaks on the duplicate call.
    ).rejects.toThrow(`Session "${id}" is already running; call kill() or forceKill() first`);
  });

  it('leaves the original session live and reachable after a rejected duplicate call', async () => {
    const id = 'dup-original-survives';
    spawned.push(id);

    const original = await start({
      id,
      cwd: process.cwd(),
      args: ['sleep', '30'],
      env: {},
    });

    try {
      await start({
        id,
        cwd: process.cwd(),
        args: ['sleep', '30'],
        env: {},
      });
    } catch {
      // expected rejection
    }

    const found = getSession(id);
    expect(found).toBeDefined();
    expect(found).toBe(original);
  });

  it('allows the same id once the original session has been removed from the registry', async () => {
    const id = 'dup-reuse-after-removal';

    const first = await start({
      id,
      cwd: process.cwd(),
      args: ['echo', 'first'],
      env: {},
    });

    // Simulate session teardown: kill (may already have exited) then deregister.
    try {
      first.pty.kill();
    } catch {
      // already exited
    }
    removeSession(id);

    // Id is now free — a second start with the same id must succeed.
    spawned.push(id);
    const second = await start({
      id,
      cwd: process.cwd(),
      args: ['echo', 'second'],
      env: {},
    });

    expect(second.id).toBe(id);
    expect(getSession(id)).toBe(second);
  });
});
