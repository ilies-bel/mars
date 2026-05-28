import { afterEach, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../src/index.js';
import { getSession, start } from '../src/index.js';

describe('sendMessage', () => {
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

  it('writes the supplied text followed by a carriage return and the output is observable via onData', async () => {
    // Spawn a shell that reads one line and prints it, then exits.
    // This lets us verify the sent text reaches the process stdin.
    const handle = await start({
      id: 'sendmsg-echo',
      cwd: process.cwd(),
      args: ['sh', '-c', 'read line; printf "%s" "$line"'],
      env: {},
    });
    handles.push(handle);

    const received: string[] = [];
    handle.onData((chunk) => received.push(chunk));

    // Short delay to allow the shell to reach the `read` builtin.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    handle.sendMessage('hello-sendmsg');

    // Wait for the process to exit naturally after reading one line.
    await handle.exited;

    expect(received.join('')).toContain('hello-sendmsg');
  });

  it('throws with a clear error when called on a session that has already exited', async () => {
    const handle = await start({
      id: 'sendmsg-exited',
      cwd: process.cwd(),
      args: ['sh', '-c', 'exit 0'],
      env: {},
    });
    handles.push(handle);

    await handle.exited;

    expect(() => handle.sendMessage('too late')).toThrow(
      /has already exited/,
    );
  });
});
