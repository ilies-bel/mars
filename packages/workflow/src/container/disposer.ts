/**
 * Reversible registration — the primitive every other container piece is
 * built on.
 *
 * Every registering call in the container (`provide`, `events.on`,
 * `plugin`, a registry's `register`) returns a {@link Disposer}. A
 * {@link DisposerSet} collects disposers for one scope (the root container,
 * a fork, a plugin's own generation) and reverses them together, in LIFO
 * order, when that scope tears down.
 */

// `Disposer` moved to `../ctx/disposer.ts` — it is the one name from this file
// that outlives the native container (four orchestrator registries import it).
export type { Disposer } from '../ctx/disposer.js';
import type { Disposer } from '../ctx/disposer.js';

export interface DisposerSetOptions {
  /**
   * Called when a disposer throws during {@link DisposerSet.dispose}. A
   * throwing disposer must never abort teardown of the rest of the set —
   * the default swallows the error. Pass a logger-backed handler to see it.
   */
  onError?: (error: unknown) => void;
}

/**
 * A LIFO stack of disposers for one scope. `dispose()` is idempotent —
 * calling it twice (or from two places) only runs the underlying disposers
 * once. Adding a disposer after the set has already disposed runs it
 * immediately, so a registration made mid-teardown is never silently lost.
 */
export class DisposerSet {
  private readonly disposers: Disposer[] = [];
  private readonly onError: (error: unknown) => void;
  private disposedFlag = false;

  constructor(options: DisposerSetOptions = {}) {
    this.onError = options.onError ?? noopOnError;
  }

  /** Whether {@link dispose} has already run. */
  get disposed(): boolean {
    return this.disposedFlag;
  }

  /** Number of disposers currently pending (0 once disposed). */
  get size(): number {
    return this.disposers.length;
  }

  /**
   * Track a disposer in this set. If the set is already disposed, the
   * disposer runs immediately instead of being queued — there is no scope
   * left for it to belong to.
   */
  add(disposer: Disposer): void {
    if (this.disposedFlag) {
      runOne(disposer, this.onError);
      return;
    }
    this.disposers.push(disposer);
  }

  /**
   * Run every tracked disposer in reverse (LIFO) registration order, then
   * mark the set disposed. A throwing disposer is reported via `onError`
   * and does not stop the remaining disposers from running. Safe to call
   * more than once — subsequent calls are no-ops.
   */
  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    for (let i = this.disposers.length - 1; i >= 0; i -= 1) {
      runOne(this.disposers[i], this.onError);
    }
    this.disposers.length = 0;
  }
}

function runOne(disposer: Disposer, onError: (error: unknown) => void): void {
  try {
    disposer();
  } catch (error) {
    onError(error);
  }
}

function noopOnError(): void {
  // Swallow by default — see DisposerSetOptions.onError.
}

/** Wrap a disposer so it runs at most once, even if invoked directly more than once. */
export function once(disposer: Disposer): Disposer {
  let ran = false;
  return () => {
    if (ran) return;
    ran = true;
    disposer();
  };
}
