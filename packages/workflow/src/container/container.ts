/**
 * The container itself — keyed service registry, plugin host and typed
 * event bus behind one `ctx`-shaped object, modelled on Cordis (the
 * meta-framework behind Koishi) and adapted to be dependency-free.
 *
 * `createContainer()` builds the root. `container.fork()` builds a child
 * scope that shares the same registry/events but tracks its own
 * disposers, so disposing the fork reverses only what was registered
 * through it. `container.plugin(p, config)` is a fork plus dependency
 * scheduling: `p.apply()` runs once `p.inject` is satisfied, and the
 * fork's registrations are torn down and reapplied as that satisfaction
 * changes.
 */

import type { Disposer } from './disposer.js';
import { DisposerSet } from './disposer.js';
import type { EventDispatcher, EventMap } from './events.js';
import { createEventDispatcher } from './events.js';
import type { ServiceMap, ServiceRegistry } from './service.js';
import { createServiceRegistry } from './service.js';
import type { ForkScope, Plugin } from './plugin.js';

export interface ContainerOptions {
  /** Called when a disposer throws during teardown. Default swallows. */
  onError?: (error: unknown) => void;
}

export interface Container<M extends ServiceMap = ServiceMap, E extends EventMap = EventMap> {
  /** This scope's name (`'root'`, a fork's name, or a plugin's name). */
  readonly name: string;
  /** The typed event bus, scoped so `events.on` here disposes with this scope. */
  readonly events: EventDispatcher<E>;
  get<K extends keyof M>(key: K): M[K] | undefined;
  has<K extends keyof M>(key: K): boolean;
  /** Like `get`, but throws if `key` is not registered. */
  require<K extends keyof M>(key: K): M[K];
  /** Register `value` under `key` for the lifetime of this scope. Returns a disposer. */
  provide<K extends keyof M>(key: K, value: M[K]): Disposer;
  keys(): (keyof M)[];
  /**
   * Load a plugin into a new fork scope. `plugin.apply()` runs once every
   * `inject` key is present (immediately, if already satisfied) and is
   * torn down / re-applied as that changes. Returns the fork's handle;
   * `scope.dispose()` reverses everything the plugin registered.
   */
  plugin<C>(plugin: Plugin<C, M>, config?: C): ForkScope;
  /** A child scope sharing this container's registry/events, with independent disposal bookkeeping. */
  fork(name?: string): Container<M, E>;
  /** Reverse everything registered through this scope, in LIFO order. Idempotent. */
  dispose(): void;
  readonly disposed: boolean;
}

/** Create a standalone root container. */
export function createContainer<M extends ServiceMap = ServiceMap, E extends EventMap = EventMap>(
  options: ContainerOptions = {},
): Container<M, E> {
  const onError = options.onError ?? (() => {});
  const registry = createServiceRegistry<M>();
  const events = createEventDispatcher<E>({ onError: (error) => onError(error) });
  return buildContainer(registry, events, new DisposerSet({ onError }), 'root', onError);
}

function buildContainer<M extends ServiceMap, E extends EventMap>(
  registry: ServiceRegistry<M>,
  events: EventDispatcher<E>,
  scope: DisposerSet,
  name: string,
  onError: (error: unknown) => void,
): Container<M, E> {
  const container: Container<M, E> = {
    name,
    events: scopeEvents(events, scope),

    get(key) {
      return registry.get(key);
    },
    has(key) {
      return registry.has(key);
    },
    require(key) {
      return registry.require(key);
    },
    keys() {
      return registry.keys();
    },
    provide(key, value) {
      const disposer = registry.provide(key, value);
      scope.add(disposer);
      return disposer;
    },

    plugin(pluginDef, config) {
      return createPluginScope(registry, events, scope, pluginDef, config as never, onError);
    },

    fork(childName) {
      const childScope = new DisposerSet({ onError });
      scope.add(() => childScope.dispose());
      return buildContainer(registry, events, childScope, childName ?? `${name}/fork`, onError);
    },

    dispose() {
      scope.dispose();
    },
    get disposed() {
      return scope.disposed;
    },
  };
  return container;
}

/** Wrap a shared dispatcher so `on()` calls made through this scope disposer-track into it. */
function scopeEvents<E extends EventMap>(events: EventDispatcher<E>, scope: DisposerSet): EventDispatcher<E> {
  return {
    on(name, listener) {
      const disposer = events.on(name, listener);
      scope.add(disposer);
      return disposer;
    },
    listenerCount(name) {
      return events.listenerCount(name);
    },
    emit(name, ...args) {
      events.emit(name, ...args);
    },
    parallel(name, ...args) {
      return events.parallel(name, ...args);
    },
    serial(name, ...args) {
      return events.serial(name, ...args);
    },
    waterfall(name, seed, ...args) {
      return events.waterfall(name, seed, ...args);
    },
  };
}

function createPluginScope<M extends ServiceMap, E extends EventMap, C>(
  registry: ServiceRegistry<M>,
  events: EventDispatcher<E>,
  parentScope: DisposerSet,
  pluginDef: Plugin<C, M>,
  config: C,
  onError: (error: unknown) => void,
): ForkScope {
  const injectKeys = pluginDef.inject ?? [];
  // The outer set lives for the plugin's whole lifetime: the dependency
  // watchers. The inner "generation" set is whatever `apply()` registered
  // for one satisfied period, and gets recreated on each re-apply.
  const outer = new DisposerSet({ onError });

  let generation: DisposerSet | null = null;
  let applying = false;
  let disposed = false;

  const satisfied = (): boolean => injectKeys.every((key) => registry.has(key));

  const teardown = (): void => {
    if (!generation) return;
    const gen = generation;
    generation = null;
    gen.dispose();
  };

  const apply = (): void => {
    if (disposed || applying || generation !== null || !satisfied()) return;
    applying = true;
    const gen = new DisposerSet({ onError });
    const pluginCtx = buildContainer(registry, events, gen, pluginDef.name, onError);
    Promise.resolve()
      .then(() => pluginDef.apply(pluginCtx, config))
      .then((result) => {
        applying = false;
        // Track the returned disposer in `gen` BEFORE checking `disposed`:
        // if the scope was disposed while `apply()` was still in flight, it
        // must still be reversed by the `gen.dispose()` below rather than
        // silently dropped — a disposer this function itself returned is a
        // registration like any other.
        if (typeof result === 'function') {
          gen.add(result);
        }
        if (disposed) {
          // Disposed while `apply()` was in flight — reverse everything it
          // just registered instead of adopting it as the active generation.
          gen.dispose();
          return;
        }
        generation = gen;
      })
      .catch((error) => {
        applying = false;
        gen.dispose();
        onError(error);
      });
  };

  const scope: ForkScope = {
    name: pluginDef.name,
    get disposed() {
      return disposed;
    },
    get active() {
      return generation !== null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      teardown();
      outer.dispose();
    },
  };

  // Route the parent's own teardown through `scope.dispose()` (not
  // `outer.dispose()` directly) so a parent-triggered disposal is
  // indistinguishable from a direct `scope.dispose()` call: the `disposed`
  // flag flips and an active generation is torn down either way.
  parentScope.add(() => scope.dispose());

  // Apply immediately if already satisfied (e.g. a plugin with no
  // `inject`, or one loaded after its dependencies were provided).
  apply();

  outer.add(
    registry.changes.on('provide', () => {
      apply();
    }),
  );
  outer.add(
    registry.changes.on('revoke', (key) => {
      if (injectKeys.includes(key)) teardown();
    }),
  );

  return scope;
}
