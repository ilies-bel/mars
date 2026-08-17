/**
 * Plugin definition — a named unit of registration with declared
 * dependencies.
 *
 * A plugin doesn't run the moment it's loaded; it runs once every key in
 * `inject` is present in the container, and is torn down automatically (in
 * LIFO order, per `disposer.ts`) if one of those keys is later withdrawn —
 * re-applying if it comes back. See `container.ts` for the scheduler.
 */

import type { Disposer } from './disposer.js';
import type { ServiceMap } from './service.js';
import type { Container } from './container.js';

export interface Plugin<C = unknown, M extends object = ServiceMap> {
  /** Stable, human-readable identity. Shown in errors and (later) narration. */
  readonly name: string;
  /**
   * Service/tool keys this plugin needs before it applies. `apply()` is
   * deferred (the plugin is "pending", not failed) until every key here is
   * registered, and the plugin is torn down and re-applied if one of these
   * keys is withdrawn and later comes back.
   */
  readonly inject?: readonly (keyof M)[];
  /**
   * Keys injected when available, absent otherwise. Unlike `inject`, these
   * never gate whether/when `apply()` runs — check `ctx.has(key)` inside
   * `apply()` if presence matters to the plugin's behaviour.
   */
  readonly optional?: readonly (keyof M)[];
  /**
   * Do the plugin's registration. May itself return a disposer for
   * teardown logic beyond what `provide`/`events.on`/`plugin` already
   * track automatically (those are collected into the fork scope with no
   * bookkeeping required here).
   */
  apply(ctx: Container<M>, config: C): void | Disposer | Promise<void | Disposer>;
}

/** The handle returned by `container.plugin(...)`. */
export interface ForkScope {
  /** The plugin's name. */
  readonly name: string;
  /** True once `dispose()` has run. */
  readonly disposed: boolean;
  /**
   * True while the plugin's `inject` dependencies are all present and
   * `apply()` has completed. False while pending (deps missing) or torn
   * down after a dependency was withdrawn.
   */
  readonly active: boolean;
  /** Reverse everything this plugin registered, in LIFO order. Idempotent. */
  dispose(): void;
}
