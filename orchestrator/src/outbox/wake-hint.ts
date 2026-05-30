/**
 * Process-level wake-hint for the outbox dispatcher.
 *
 * Publishers call {@link signalWakeHint} immediately after writing to the
 * outbox so the dispatcher polls without waiting for the next scheduled
 * interval. The hint carries no semantic payload — the dispatcher reads
 * the actual events from the database.
 *
 * The outbox dispatcher (or any other in-process consumer) registers its
 * wake callback via {@link registerWakeHint} at startup and deregisters
 * via the returned cleanup function on stop.
 *
 * Without a registered callback the signal is a safe no-op; eventual
 * delivery still occurs via the dispatcher's fallback poll interval.
 */

type WakeCallback = () => void;

/** Module-level registry of active callbacks. */
const _callbacks = new Set<WakeCallback>();

/**
 * Register a callback to be invoked synchronously when
 * {@link signalWakeHint} fires. Returns a deregister function that
 * removes this specific callback from the registry.
 *
 * @example
 * ```typescript
 * const unregister = registerWakeHint(() => dispatcher.notify());
 * // On shutdown:
 * unregister();
 * ```
 */
export function registerWakeHint(cb: WakeCallback): () => void {
  _callbacks.add(cb);
  return () => {
    _callbacks.delete(cb);
  };
}

/**
 * Signal that one or more events were just written to the outbox in this
 * process. Synchronously calls every registered callback in insertion
 * order, each call expected to be sub-millisecond (typically a single
 * Promise resolution or an EventEmitter nudge).
 *
 * Safe to call with no registered callbacks — becomes a no-op.
 */
export function signalWakeHint(): void {
  for (const cb of _callbacks) {
    cb();
  }
}
