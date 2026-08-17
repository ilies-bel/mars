/**
 * Fault-isolated event dispatch.
 *
 * Cordis's `ctx.emit()` is `dispatch('emit', args).map(cb => cb(...args))`. A
 * listener that throws synchronously therefore propagates into the EMITTER and
 * skips every listener after it; one that rejects becomes an unhandled
 * rejection. The dispatcher this container replaced routed both to an error
 * sink and carried on, because `emit` is the observer channel — progress,
 * telemetry, narration — and an observer must never be able to fail the thing
 * it is observing.
 *
 * Two ways to get that back, deliberately kept separate:
 *
 *   {@link safeEmit} — dispatcher-level. Isolates EVERY listener for that one
 *   dispatch, however it was registered. This is the exact parity primitive and
 *   what the engine itself uses.
 *
 *   {@link safeOn} — listener-level. The listener can never throw into any
 *   dispatch. Use it for observers only: a guarded listener never bails a
 *   `serial`, never contributes to a `parallel` AggregateError, and never
 *   vetoes a `waterfall`, because its failures are swallowed into `onError`.
 *
 * There is deliberately NO global "wrap every listener" installer. Wrapping at
 * registration time cannot know the dispatch mode, so it would also swallow the
 * failures that `parallel` is contractually required to aggregate and that
 * `serial` is required to propagate.
 */

import type { Context } from '@deepseek-ai/cordis';

/** Notified when a listener throws or rejects inside an isolated dispatch. */
export type ListenerErrorHandler = (error: unknown, name: PropertyKey) => void;

/** Removes a listener; returns `true` if it was still registered. */
export type ListenerDisposer = () => boolean;

type Listener = (...args: never[]) => unknown;

const noop: ListenerErrorHandler = () => {
  // Swallow by default — same contract as the dispatcher this replaces.
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

/**
 * Register an observer listener that can never throw into a dispatch.
 *
 * Same signature and disposer as `ctx.on`; the listener is owned by the current
 * fiber and removed when it unloads.
 */
export function safeOn<L extends Listener>(
  ctx: Context,
  name: string,
  listener: L,
  onError: ListenerErrorHandler = noop,
): ListenerDisposer {
  const guarded = function (this: unknown, ...args: never[]): unknown {
    try {
      const result: unknown = listener.apply(this, args);
      if (isThenable(result)) {
        return Promise.resolve(result).then(undefined, (error: unknown) => {
          onError(error, name);
        });
      }
      return result;
    } catch (error) {
      onError(error, name);
      return undefined;
    }
  };
  // `keyof Events` is a closed union of cordis's own internal hooks plus
  // whatever consumers declaration-merge in; this helper is name-agnostic by
  // design, so the call is made through the untyped overload.
  const on = ctx.on as unknown as (
    event: string,
    fn: (...args: never[]) => unknown,
  ) => ListenerDisposer;
  return on(name, guarded);
}
