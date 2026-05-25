import { describe, it, expect, afterEach } from 'vitest';
import { start, getSession, removeSession } from '../src/index.js';

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

describe('start', () => {
  it('returns a handle carrying the id the caller passed in', async () => {
    const id = 'test-id-echo';
    spawned.push(id);

    const handle = await start({
      id,
      cwd: process.cwd(),
      args: ['echo', 'hello'],
      env: {},
    });

    expect(handle.id).toBe(id);
  });

  it('registers the live session so getSession returns it immediately', async () => {
    const id = 'test-id-registry';
    spawned.push(id);

    await start({
      id,
      cwd: process.cwd(),
      args: ['echo', 'hello'],
      env: {},
    });

    const found = getSession(id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
  });

  it('spawns the process inside a PTY so the child sees a real tty', async () => {
    const id = 'test-id-tty';
    spawned.push(id);

    // Ask node to report whether its stdout is a TTY.
    // When the process runs inside a node-pty pseudo-terminal, the slave
    // end is a real TTY device, so process.stdout.isTTY evaluates to true.
    const handle = await start({
      id,
      cwd: process.cwd(),
      args: [
        process.execPath, // absolute path to the current `node` binary
        '-e',
        'process.stdout.write(process.stdout.isTTY ? "tty" : "not-tty")',
      ],
      env: {},
    });

    const output = await new Promise<string>((resolve) => {
      let buf = '';
      handle.pty.onData((chunk) => {
        buf += chunk;
      });
      handle.pty.onExit(() => {
        resolve(buf);
      });
    });

    // The output may include ANSI escape sequences from the PTY; the
    // important thing is that the string "tty" appears in it.
    expect(output).toContain('tty');
    expect(output).not.toContain('not-tty');
  });

  it('uses the supplied cwd when spawning', async () => {
    const id = 'test-id-cwd';
    spawned.push(id);

    const cwd = '/tmp';

    const handle = await start({
      id,
      cwd,
      args: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
      env: {},
    });

    const output = await new Promise<string>((resolve) => {
      let buf = '';
      handle.pty.onData((chunk) => {
        buf += chunk;
      });
      handle.pty.onExit(() => {
        resolve(buf);
      });
    });

    expect(output).toContain(cwd);
  });
});
