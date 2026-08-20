/**
 * Fault-isolated dispatch for the engine's observer channel.
 *
 * Cordis's `ctx.emit()` is `dispatch('emit', args).map(cb => cb(...args))`. A
 * listener that throws synchronously therefore propagates into the EMITTER and
 * skips every listener after it; one that rejects becomes an unhandled
 * rejection. That is the right default for cordis's own internal hooks, but
 * `mars/workflow.event` (see `../workflow.ts`) is the engine's PUBLIC observer
 * channel — the primer tells plugin authors they can subscribe to it to watch
 * run progress. An observer must never be able to fail the run it is
 * observing: {@link safeEmit} is that guarantee, deliberately engineered
 * rather than inherited from cordis. It isolates every listener for one
 * dispatch, whatever the dispatch mode, and hands each failure to `onError`
 * instead of letting it reach the emitter or become an unhandled rejection.
 *
 * There is deliberately NO general-purpose "wrap every listener at
 * registration time" helper alongside it. Wrapping at registration time
 * cannot know the dispatch mode, so it would also swallow the failures that
 * `parallel` is contractually required to aggregate and that `serial` is
 * required to propagate — this module isolates one specific channel, not
 * cordis dispatch in general.
 */

import type { Context } from '@deepseek-ai/cordis';

/** Notified when a listener throws or rejects inside an isolated dispatch. */
export type ListenerErrorHandler = (error: unknown, name: string) => void;

const noop: ListenerErrorHandler = () => {
  // Swallow by default when the caller supplies no handler.
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Fire `name` at every listener, in registration order, without awaiting them —
 * and without letting any one of them stop the others or reach the caller.
 *
 * Synchronous throws and async rejections both go to `onError`. Return values
 * are ignored, exactly like `ctx.emit`.
 */
export function safeEmit(
  ctx: Context,
  name: string,
  args: readonly unknown[],
  onError: ListenerErrorHandler = noop,
): void {
  // `dispatch` consumes the head of the array it is given (an optional thisArg,
  // then the event name) and leaves the listener arguments behind, so hand it a
  // throwaway array and read the remainder back out of it.
  const rest: unknown[] = [name, ...args];
  const listeners = ctx.events.dispatch('emit', rest);
  for (const listener of listeners) {
    try {
      const result: unknown = listener(...rest);
      if (isThenable(result)) {
        Promise.resolve(result).then(undefined, (error: unknown) => onError(error, name));
      }
    } catch (error) {
      onError(error, name);
    }
  }
}
