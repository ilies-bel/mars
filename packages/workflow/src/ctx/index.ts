/**
 * The service container — now a real
 * [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) `Context`, plus
 * the four Mars-owned pieces cordis does not provide:
 *
 *   `registry.ts`      a fiber-free keyed registry, for module-level singletons
 *                      that register before any context exists;
 *   `fiber-state.ts`   a runtime mirror of the `FiberState` const enum, which
 *                      does not survive compilation;
 *   `safe-listen.ts`   fault-isolated `emit`, which cordis's does not do;
 *   `sealed.ts`        the ADR-0052 write-funnel seal.
 *
 * `WorkflowCtx.container` (see `../workflow.ts`) is a root `Context` seeded from
 * `ctx.services`, torn down when the run ends.
 */

// Ambient Context slot declarations (side-effect-only import; erased at build).
import './augmentations.js';

export type { Disposer } from './disposer.js';

export type {
  ServiceMap,
  ServiceRegistry,
  ServiceChanges,
  ServiceChangeEvents,
} from './registry.js';
export { createServiceRegistry, ServiceNotFoundError } from './registry.js';

export { FiberState, fiberStateName, isActive, isDisposed } from './fiber-state.js';
export type { FiberStateMirrorProof } from './fiber-state.js';

export { safeEmit, safeOn } from './safe-listen.js';
export type { ListenerErrorHandler, ListenerDisposer } from './safe-listen.js';

export { SEALED_SERVICE_KEYS, isSealedName, sealService, readService } from './sealed.js';
export type { SealedServiceKey } from './sealed.js';

export { createRunContainer, disposeRunContainer, ReservedServiceNameError } from './run-container.js';
export type { RunContainerOptions, ContainerErrorHandler } from './run-container.js';

// Cordis's own surface, re-exported so consumers never have to depend on
// `@deepseek-ai/cordis` directly (and so there is exactly one copy of it in a
// process — mixing two copies breaks service-class identity).
export { Context, Service, CordisError, ValidationError, DisposableList, isBailed, symbols } from '@deepseek-ai/cordis';
export type {
  Disposable,
  Effect,
  EffectMeta,
  EventOptions,
  Events,
  Fiber,
  Inject,
  Plugin,
} from '@deepseek-ai/cordis';
/**
 * TYPE-ONLY. `FiberState` is a `const enum` erased from cordis's shipped
 * JavaScript — importing it as a value compiles and then throws. Compare fiber
 * states against the {@link FiberState} mirror exported above instead.
 */
export type { FiberState as CordisFiberState } from '@deepseek-ai/cordis';
