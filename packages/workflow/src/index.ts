/**
 * @mars/workflow
 *
 * A small, domain-agnostic, IMPERATIVE workflow engine for local TypeScript
 * CLIs that drive coding agents. A workflow is a plain async function whose
 * native control flow is the source of truth; `ctx.step(name, fn)` wraps
 * each durable unit. Durability is checkpoint-resume, not replay.
 */

export const VERSION = '0.1.0';

// Engine
export { runWorkflow, defineWorkflow, applyOutcomeMeta } from './workflow.js';
export type {
  WorkflowCtx,
  WorkflowFn,
  Workflow,
  StepFn,
  StepHandle,
  StepOptions,
  WorkflowEvent,
  FiberStatusPayload,
  RunWorkflowOptions,
  RunResult,
} from './workflow.js';

// Persistence
export { InMemoryStore } from './store-memory.js';
export { SqliteStore } from './store-sqlite.js';
export type {
  WorkflowStore,
  RunRecord,
  StepRecord,
  RunStatus,
  StepStatus,
  StepOutcomeMeta,
} from './store.js';

// Logging
export { createJsonLogger, silentLogger } from './logger.js';
export type { Logger, LogFields } from './logger.js';

// Manual step park/resume hooks
export { awaitManualDone, resolveManualStep } from './manual-step.js';

// ---------------------------------------------------------------------------
// The service container
// ---------------------------------------------------------------------------
// `WorkflowCtx.container` is a cordis `Context`: keyed services, plugins with
// fiber-based dependency scheduling, a typed event bus and effect-based
// teardown. Cordis's own surface is re-exported here so consumers depend on
// this package rather than on `@deepseek-ai/cordis` directly — two copies of
// cordis in one process do not share service-class identity.
//
// Mars-owned additions: `createServiceRegistry` (a fiber-free keyed registry
// for module-level singletons), `FiberState` (a runtime mirror of a const enum
// that does not survive compilation), `safeEmit`/`safeOn` (fault-isolated
// dispatch), and the ADR-0052 seal. See ctx/index.ts.
export {
  Context,
  CordisError,
  DisposableList,
  Service,
  ValidationError,
  createRunContainer,
  createServiceRegistry,
  disposeRunContainer,
  FiberState,
  fiberStateName,
  isActive,
  isBailed,
  isDisposed,
  isSealedName,
  readService,
  ReservedServiceNameError,
  safeEmit,
  safeOn,
  sealService,
  SEALED_SERVICE_KEYS,
  ServiceNotFoundError,
  symbols,
} from './ctx/index.js';
export type {
  ContainerErrorHandler,
  Disposable,
  Disposer,
  Effect,
  EffectMeta,
  EventOptions,
  Events,
  Fiber,
  Inject,
  ListenerDisposer,
  ListenerErrorHandler,
  Plugin,
  RunContainerOptions,
  SealedServiceKey,
  ServiceChangeEvents,
  ServiceChanges,
  ServiceMap,
  ServiceRegistry,
} from './ctx/index.js';
