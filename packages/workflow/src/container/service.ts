/**
 * Keyed service registration — the container's registry of named
 * implementations (services, tools, whatever a consumer keys by string).
 *
 * A plain `Map` would do the storage; what a registry adds is
 * `require()` (throws with the known-keys list instead of returning
 * `undefined`) and a `changes` event stream so higher-level machinery
 * (plugin dependency scheduling — see `plugin.ts`/`container.ts`) can react
 * to a key becoming available or being withdrawn without polling.
 */

import type { Disposer } from './disposer.js';
import type { EventDispatcher } from './events.js';
import { createEventDispatcher } from './events.js';

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
  readonly changes: EventDispatcher<ServiceChangeEvents<M>>;
}

/** Create a standalone, in-memory keyed service registry. */
export function createServiceRegistry<M extends object = ServiceMap>(): ServiceRegistry<M> {
  const store = new Map<keyof M, M[keyof M]>();
  const changes = createEventDispatcher<ServiceChangeEvents<M>>();

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
      changes.emit('provide', key);
      return () => {
        if (store.get(key) === value) {
          store.delete(key);
          changes.emit('revoke', key);
        }
      };
    },
  };
}
