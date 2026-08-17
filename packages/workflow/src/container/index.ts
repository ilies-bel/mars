/**
 * The service container — a keyed service registry, a plugin host with
 * `inject`-style dependency scheduling, and a typed event bus with four
 * dispatch modes, all built on reversible (disposer-returning)
 * registration. See `container.ts` for the overview.
 *
 * Dependency-free and domain-agnostic: nothing here knows about Mars,
 * tasks, or coding agents. `WorkflowCtx.container` (see `../workflow.ts`)
 * is a plain root container seeded from `ctx.services`.
 */

export type { Disposer, DisposerSetOptions } from './disposer.js';
export { DisposerSet, once } from './disposer.js';

export type { EventDispatcher, EventDispatcherOptions, EventMap, Args, Ret } from './events.js';
export { createEventDispatcher } from './events.js';

export type { ServiceMap, ServiceRegistry, ServiceChangeEvents } from './service.js';
export { createServiceRegistry, ServiceNotFoundError } from './service.js';

export type { Plugin, ForkScope } from './plugin.js';

export type { Container, ContainerOptions } from './container.js';
export { createContainer } from './container.js';
