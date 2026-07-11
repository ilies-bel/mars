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

// Agent runtimes + manual step park/resume hooks
export { HeadlessRuntime, awaitManualDone, resolveManualStep } from './runtime.js';
export type {
  AgentRuntime,
  AgentRunOptions,
  HeadlessRuntimeOptions,
} from './runtime.js';
