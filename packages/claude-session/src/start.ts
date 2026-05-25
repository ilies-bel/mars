import * as pty from 'node-pty';
import type { SessionHandle } from './session.js';
import { getSession, registerSession } from './registry.js';

export interface StartOptions {
  /** Caller-supplied identifier for this session. */
  id: string;
  /** Working directory for the spawned process. */
  cwd: string;
  /**
   * argv-style list where index 0 is the executable and the rest are
   * its arguments (e.g. `['claude', '--no-color', '-p', 'hello']`).
   */
  args: string[];
  /** Environment variables passed to the child process. */
  env: Record<string, string>;
}

/**
 * Launch a process inside a pseudo-terminal and return a session handle.
 *
 * The process is spawned immediately; `start` resolves as soon as the PTY
 * has been created — it does not wait for the child to emit output or
 * reach a ready state (that belongs to a later slice).
 *
 * The returned handle is also stored in the library's internal registry
 * so it can be retrieved later via `getSession(id)`.
 */
export async function start(opts: StartOptions): Promise<SessionHandle> {
  const { id, cwd, args, env } = opts;
  const [file, ...rest] = args;

  if (!file) {
    throw new Error('start: args must contain at least one element (the executable)');
  }

  // Reject before spawning so no process is leaked on a duplicate id.
  if (getSession(id) !== undefined) {
    throw new Error(`Session id "${id}" is already in use`);
  }

  const proc = pty.spawn(file, rest, {
    name: 'xterm-256color',
    cwd,
    env: { ...process.env, ...env },
    cols: 80,
    rows: 24,
  });

  const handlers = new Set<(chunk: string) => void>();

  proc.onData((chunk) => {
    for (const h of handlers) h(chunk);
  });

  const handle: SessionHandle = {
    id,
    pty: proc,
    onData(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
  registerSession(handle);

  return handle;
}
