import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../src/index.js';
import { getSession, start } from '../src/index.js';

describe('forceKill', () => {
  const handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles) {
      if (getSession(handle.id)) {
        try { handle.pty.kill('SIGKILL'); } catch { /* already dead */ }
        await handle.exited.catch(() => { /* ignore */ });
      }
    }
    handles.length = 0;
  });

  it('terminates the process and resolves only after the process has exited', async () => {
    const handle = await start({
      id: 'force-kill-basic',
      cwd: process.cwd(),
      args: ['sleep', '100'],
      env: {},
    });
    handles.push(handle);

    await handle.forceKill();

    // forceKill resolved — the exited promise must already be settled.
    const code = await handle.exited;
    expect(typeof code).toBe('number');
    expect(getSession(handle.id)).toBeUndefined();
  }, 5_000);

  it('terminates a process that ignores SIGTERM when kill then forceKill are called', async () => {
    const handle = await start({
      id: 'force-kill-sigterm-immune',
      cwd: process.cwd(),
      args: ['sh', '-c', 'trap "" TERM; sleep 100'],
      env: {},
    });
    handles.push(handle);

    handle.kill(); // sends SIGTERM, which the process ignores

    // Give the process a moment to (not) react to SIGTERM.
    await new Promise<void>((r) => setTimeout(r, 150));
    expect(getSession(handle.id)).toBeDefined(); // still alive — SIGTERM ignored

    await handle.forceKill(); // sends SIGKILL — cannot be ignored

    expect(getSession(handle.id)).toBeUndefined(); // removed from registry
  }, 5_000);

  it('is a safe no-op when the session has already exited', async () => {
    const handle = await start({
      id: 'force-kill-noop',
      cwd: process.cwd(),
      args: ['sh', '-c', 'exit 0'],
      env: {},
    });
    handles.push(handle);

    await handle.exited; // wait for natural exit

    // Must not throw.
    await expect(handle.forceKill()).resolves.toBeUndefined();
  }, 5_000);
});
