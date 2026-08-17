/**
 * Keyed service registration — a plain, fiber-free map of named
 * implementations.
 *
 * WHY THIS SURVIVED THE CORDIS CUT. A cordis `Context` is not a keyed map:
 *
 *   - `ctx.provide()` is an effect on the *current fiber*, so it needs a live
 *     context; the four Mars registries that use this
 *     (`registries/verify-heuristics.ts`, `core/workers/{provider,worker}-registry.ts`,
 *     `workflows/primitives/registry.ts`) are module-level singletons that
 *     register at import time, before any context exists;
 *   - `ctx.provide()` THROWS on a duplicate name within an isolation scope,
 *     while re-registering the same key is legal (and used) here;
 *   - a `Context` exposes no `keys()`, and `requireX()`'s known-keys error
 *     message is the whole reason these registries exist rather than a `Map`.
 *
 * Forcing those call sites onto a `Context` would be a regression dressed up as
 * adoption. What this module does NOT do any more is depend on the old
 * `EventDispatcher`: `changes` is a ~20-line local emitter, so the registry is
 * a leaf with no container dependency at all.
 */

import type { Disposer } from './disposer.js';

/** The shape a registry's keys/values are constrained to. */
export type ServiceMap = Record<string, unknown>;

/** Thrown by `require()` when the key has no registered value. */
export class ServiceNotFoundError extends Error {
  readonly key: PropertyKey;
  readonly knownKeys: readonly PropertyKey[];

  constructor(key: PropertyKey, knownKeys: readonly PropertyKey[]) {
    const known = knownKeys.length > 0 ? knownKeys.map(String).join(', ') : '(none registered)';
    super(`Service "${String(key)}" is not registered. Known services: ${known}`);
    this.name = 'ServiceNotFoundError';
    this.key = key;
    this.knownKeys = knownKeys;
  }
}

/** Events published as the registry's contents change. */
export interface ServiceChangeEvents<M extends object> {
  /** A key was registered (including replacing a previous value). */
  provide: (key: keyof M) => void;
  /** A key's current registration was withdrawn (its disposer ran). */
  revoke: (key: keyof M) => void;
}

/**
 * Subscription surface for {@link ServiceChangeEvents}. Intentionally
 * `on`-only: the registry is the sole publisher.
 */
export interface ServiceChanges<M extends object> {
  /** Register a listener. Returns a disposer that removes it. */
  on<K extends keyof ServiceChangeEvents<M>>(
    name: K,
    listener: ServiceChangeEvents<M>[K],
  ): Disposer;
}

export interface ServiceRegistry<M extends object = ServiceMap> {
  get<K extends keyof M>(key: K): M[K] | undefined;
  has<K extends keyof M>(key: K): boolean;
  /** Like `get`, but throws {@link ServiceNotFoundError} instead of returning `undefined`. */
  require<K extends keyof M>(key: K): M[K];
  /**
   * Register a value under `key`. Returns a disposer that withdraws it.
   * The disposer only clears the registration if it still holds the exact
   * value it registered — a later `provide()` for the same key that has
   * since superseded it is left alone, so disposing a stale registration
   * can never clobber a newer one.
   */
  provide<K extends keyof M>(key: K, value: M[K]): Disposer;
  keys(): (keyof M)[];
  /** Fires `provide` / `revoke` as the registry's contents change. */
  readonly changes: ServiceChanges<M>;
}

/** Create a standalone, in-memory keyed service registry. */
export function createServiceRegistry<M extends object = ServiceMap>(): ServiceRegistry<M> {
  const store = new Map<keyof M, M[keyof M]>();
  const listeners = new Map<keyof ServiceChangeEvents<M>, Set<(key: keyof M) => void>>();

  const emit = (name: keyof ServiceChangeEvents<M>, key: keyof M): void => {
    const set = listeners.get(name);
    if (!set) return;
    // Snapshot: a listener registered or removed from inside another listener
    // must not affect the dispatch already in flight.
    for (const listener of [...set]) listener(key);
  };

  const changes: ServiceChanges<M> = {
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
  };

  return {
    changes,
    get(key) {
      return store.get(key) as M[typeof key] | undefined;
    },
    has(key) {
      return store.has(key);
    },
    require(key) {
      if (!store.has(key)) throw new ServiceNotFoundError(key, [...store.keys()]);
      return store.get(key) as M[typeof key];
    },
    keys() {
      return [...store.keys()];
    },
    provide(key, value) {
      store.set(key, value);
      emit('provide', key);
      return () => {
        if (store.get(key) === value) {
          store.delete(key);
          emit('revoke', key);
        }
      };
    },
  };
}
