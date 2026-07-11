import type { IPty } from 'node-pty';

/**
 * A live handle to a spawned interactive PTY session.
 * The `pty` field exposes the underlying pseudo-terminal process.
 */
export interface SessionHandle {
  /** Caller-supplied identifier; unique within a single process. */
  id: string;
  /** The pseudo-terminal process instance. */
  pty: IPty;
  /**
   * Register a handler that receives every chunk the PTY emits.
   * Each chunk is a UTF-8 string that may contain ANSI escape sequences.
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
  /**
   * Write `text` followed by a carriage return (`\r`) to the PTY in one
   * call, submitting it as a single message. Throws if the session has
   * already exited.
   */
  sendMessage(text: string): void;
  /**
   * Requests graceful termination (SIGTERM on Unix, TerminateProcess on Windows).
   * Returns immediately without waiting for the process to exit. Callers can
   * await `exited` or call `forceKill()` on their own schedule if the process
   * does not respond.
   */
  kill(): void;
  /**
   * Sends SIGKILL to the underlying process and resolves only after the
   * process has exited. Calling this on an already-exited session is a
   * safe no-op that resolves immediately.
   */
  forceKill(): Promise<void>;
}
