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
}
