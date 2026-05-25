import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../src/index.js';
import { getSession, start } from '../src/index.js';

describe('session exited promise', () => {
  const handles: SessionHandle[] = [];

  afterEach(async () => {
    for (const handle of handles) {
      if (getSession(handle.id)) {
        try { handle.pty.kill(); } catch { /* already dead */ }
        await handle.exited.catch(() => { /* ignore */ });
      }
    }
    handles.length = 0;
  });

  it('resolves with the exit code when a short-lived process completes on its own', async () => {
    const handle = await start({
      id: 'exited-natural',
      cwd: process.cwd(),
      args: ['sh', '-c', 'exit 0'],
      env: {},
    });
    handles.push(handle);

    const code = await handle.exited;
    expect(code).toBe(0);
  });

  it('awaiting exited after the process has already ended still resolves with the recorded exit code', async () => {
    const handle = await start({
      id: 'exited-already-done',
      cwd: process.cwd(),
      args: ['sh', '-c', 'exit 0'],
      env: {},
    });
    handles.push(handle);

    // First await — waits for the process to finish.
    await handle.exited;
    // Second await — promise is already settled; resolves immediately.
    const code = await handle.exited;
    expect(code).toBe(0);
  });

  it('removes the session from the live-sessions registry after exit', async () => {
    const handle = await start({
      id: 'exited-registry-cleanup',
      cwd: process.cwd(),
      args: ['sh', '-c', 'exit 0'],
      env: {},
    });
    handles.push(handle);

    expect(getSession('exited-registry-cleanup')).toBeDefined();
    await handle.exited;
    expect(getSession('exited-registry-cleanup')).toBeUndefined();
  });
});
