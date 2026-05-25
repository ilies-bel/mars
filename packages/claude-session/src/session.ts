import type { IPty } from 'node-pty';

/**
 * A live handle to a spawned Claude session (or test subprocess).
 * The `pty` field exposes the underlying pseudo-terminal process.
 */
export interface SessionHandle {
  /** Caller-supplied identifier; unique within a single process. */
  id: string;
  /** The pseudo-terminal process instance. */
  pty: IPty;
  /**
   * Register a handler that receives every chunk the PTY emits.
   * Multiple subscribers each receive the same chunks.
   * Returns a function that removes this handler; calling it is idempotent.
   */
  onData(handler: (chunk: string) => void): () => void;
  /**
   * Resolves with the process exit code once the session has terminated,
   * regardless of whether it ended naturally, was gracefully killed, or
   * was force-killed. Awaiting this after the process has already exited
   * resolves immediately with the recorded exit code. The session is
   * removed from the live-sessions registry before this promise settles.
   */
  exited: Promise<number>;
}
