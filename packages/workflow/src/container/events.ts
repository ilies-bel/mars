/**
 * Typed event dispatch.
 *
 * Four dispatch modes over the same listener list, each with distinct
 * semantics for how listener results and failures are handled:
 *
 * - `emit`     — fire-and-forget, sequential. Listeners run in registration
 *                order; a synchronous throw or an async rejection is routed
 *                to `onError` and does not block the caller or stop the
 *                remaining listeners. Return values are ignored. This is
 *                for pure observers (progress, telemetry) that must never
 *                delay the dispatcher.
 * - `parallel` — awaited, concurrent. Every listener starts immediately and
 *                the call resolves once all have settled. Any rejections
 *                are aggregated into one `AggregateError`, never swallowed.
 *                Use when every listener MUST finish before the caller
 *                continues and none of them depends on another's result.
 * - `serial`   — awaited, sequential. Listeners run one at a time, in
 *                registration order; the first one to return a value other
 *                than `undefined` short-circuits the dispatch and that
 *                value is returned. A listener that wants to "pass" returns
 *                `undefined`. Use for classification/routing decisions
 *                where registration order is a priority list.
 * - `waterfall`— awaited, sequential middleware. Each listener receives the
 *                previous listener's return value (the seed, for the
 *                first) and returns the value the next listener will see.
 *                Use for successive transformation of one value (composing
 *                a prompt, filtering a list).
 */

import type { Disposer } from './disposer.js';

/** A map from event name to the listener signature that event dispatches. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = Record<string, (...args: any[]) => any>;

/** The parameter tuple of a listener function type. */
export type Args<F> = F extends (...args: infer A) => unknown ? A : never;

/** The (awaited) return type of a listener function type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ret<F> = F extends (...args: any[]) => infer R ? Awaited<R> : never;

export interface EventDispatcherOptions {
  /**
   * Called when a listener throws or rejects in a context where the
   * dispatcher itself does not propagate the error to its caller (`emit`).
   * The default swallows.
   */
  onError?: (error: unknown, name: PropertyKey) => void;
}

export interface EventDispatcher<M extends EventMap = EventMap> {
  /** Register a listener. Returns a disposer that removes it. */
  on<K extends keyof M>(name: K, listener: M[K]): Disposer;
  /** Number of listeners currently registered for `name`. */
  listenerCount<K extends keyof M>(name: K): number;
  /** Fire-and-forget, sequential invocation order. See module docs. */
  emit<K extends keyof M>(name: K, ...args: Args<M[K]>): void;
  /** Awaited, concurrent. Rejections aggregate into one AggregateError. */
  parallel<K extends keyof M>(name: K, ...args: Args<M[K]>): Promise<void>;
  /** Awaited, sequential; first non-undefined return value wins. */
  serial<K extends keyof M>(name: K, ...args: Args<M[K]>): Promise<Ret<M[K]> | undefined>;
  /**
   * Awaited, sequential transform of `seed` through every listener — each
   * listener is called as `(value, ...args)` and returns the value the
   * next listener sees. `args` is intentionally untyped against `M[K]`:
   * a waterfall listener's first parameter is the threaded value (`T`),
   * not part of the fixed call-site arguments, so it cannot be sliced out
   * of `Args<M[K]>` generically. Give `T` explicitly at the call site for
   * a precisely typed result.
   */
  waterfall<K extends keyof M, T>(name: K, seed: T, ...args: unknown[]): Promise<T>;
}

/** Create a standalone, in-memory event dispatcher. */
export function createEventDispatcher<M extends EventMap = EventMap>(
  options: EventDispatcherOptions = {},
): EventDispatcher<M> {
  const onError = options.onError ?? (() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners = new Map<keyof M, Set<(...args: any[]) => any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function listenersFor(name: keyof M): Array<(...args: any[]) => any> {
    const set = listeners.get(name);
    // Snapshot: a listener registered/removed mid-dispatch (e.g. from
    // inside another listener) must not affect the dispatch already in
    // flight.
    return set ? [...set] : [];
  }

  return {
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(listener);
      const target = set;
      return () => {
        target.delete(listener);
      };
    },

    listenerCount(name) {
      return listeners.get(name)?.size ?? 0;
    },

    emit(name, ...args) {
      for (const listener of listenersFor(name)) {
        try {
          const result = listener(...args);
          if (isThenable(result)) {
            result.then(undefined, (error: unknown) => onError(error, name));
          }
        } catch (error) {
          onError(error, name);
        }
      }
    },

    async parallel(name, ...args) {
      // Wrap each invocation so a listener that throws SYNCHRONOUSLY is
      // captured as a rejected promise too, exactly like one that rejects
      // asynchronously — otherwise it would escape `Promise.allSettled`
      // entirely and abort the dispatch outside the aggregation below.
      const settled = await Promise.allSettled(
        listenersFor(name).map((listener) => {
          try {
            return Promise.resolve(listener(...args));
          } catch (error) {
            return Promise.reject(error);
          }
        }),
      );
      const rejections = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (rejections.length > 0) {
        throw new AggregateError(
          rejections.map((r) => r.reason),
          `parallel dispatch of "${String(name)}" had ${rejections.length} rejection(s)`,
        );
      }
    },

    async serial(name, ...args) {
      for (const listener of listenersFor(name)) {
        const result = await listener(...args);
        if (result !== undefined) return result;
      }
      return undefined;
    },

    async waterfall(name, seed, ...args) {
      let value = seed;
      for (const listener of listenersFor(name)) {
        value = await listener(value, ...args);
      }
      return value;
    },
  };
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
