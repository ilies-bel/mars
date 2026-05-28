import * as pty from 'node-pty';
import type { SessionHandle } from './session.js';
import { getSession, registerSession, removeSession } from './registry.js';

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
  /**
   * When set, `start` waits until this string appears anywhere in the PTY
   * output before resolving — signalling that the child is ready to receive
   * its first message.  If the process exits before the marker is seen,
   * `start` rejects with an error that surfaces the exit code.
   *
   * When omitted, `start` resolves immediately after the PTY is created.
   */
  readinessMarker?: string;
}

/**
 * Launch a process inside a pseudo-terminal and return a session handle.
 *
 * When `opts.readinessMarker` is set, `start` blocks until that string
 * appears in the PTY output.  If the process exits before the marker is
 * observed, `start` rejects with a descriptive error.
 *
 * The returned handle is also stored in the library's internal registry
 * so it can be retrieved later via `getSession(id)`.
 */
export async function start(opts: StartOptions): Promise<SessionHandle> {
  const { id, cwd, args, env, readinessMarker } = opts;
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

  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  let hasExited = false;

  proc.onExit(({ exitCode }) => {
    hasExited = true;
    removeSession(id);
    resolveExited(exitCode);
  });

  const handle: SessionHandle = {
    id,
    pty: proc,
    onData(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    exited,
    sendMessage(text: string): void {
      if (hasExited) {
        throw new Error(`Session "${id}" has already exited`);
      }
      proc.write(text + '\r');
    },
    kill() {
      proc.kill(); // sends SIGTERM
    },
    async forceKill() {
      if (hasExited) return;
      try {
        proc.kill('SIGKILL');
      } catch {
        // process may have exited between the hasExited-check and the kill call
      }
      await exited;
    },
  };
  registerSession(handle);

  if (readinessMarker !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const unsub = handle.onData((chunk) => {
        if (chunk.includes(readinessMarker)) {
          unsub();
          resolve();
        }
      });
      // If the process exits before the marker is seen, surface the exit code.
      handle.exited.then((code) => {
        unsub();
        reject(new Error(
          `Session "${id}" exited with code ${code} before the readiness marker was observed`,
        ));
      });
    });
  }

  return handle;
}
