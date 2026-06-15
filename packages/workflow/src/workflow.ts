import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { StepOutcomeMeta, StepRecord, WorkflowStore } from './store.js';

/**
 * The imperative core.
 *
 * A workflow is a plain async TypeScript function:
 *
 *   async function implement(ctx: WorkflowCtx, input: I): Promise<O> { ... }
 *
 * Control flow — branching, loops, early return — is native TS. There is no
 * declarative graph, no `deps`, no topological sort, no DSL. The function
 * body is the single source of truth for execution order.
 *
 * Durability is checkpoint-resume, NOT deterministic replay: re-running a
 * run executes the function from the top again, but every `ctx.step(name,
 * fn)` whose record is already `'completed'` short-circuits — it returns
 * the recorded result without invoking `fn`. Side effects live in git and
 * the filesystem, not in a replayable event log, so replay would be a
 * category mismatch.
 */

/** A fine-grained progress event emitted from inside a workflow. */
export interface WorkflowEvent {
  runId: string;
  workflowId: string;
  /** The step that emitted it, if emitted from inside a step. */
  step: string | null;
  event: string;
  payload: unknown;
  time: number;
}

/** Options a step can attach to its own record as it runs. */
export interface StepOptions {
  /**
   * Worktree SHA this step ran against. Stored verbatim on the record so a
   * consumer can re-anchor on resume; the engine never runs git.
   */
  sha?: string | null;
  /** Key into external transcript storage for this step's full output. */
  transcriptKey?: string | null;
}

/**
 * The signature of the unit of work wrapped by a step. It may be sync or
 * async. Its return value is recorded as the step's result; on resume that
 * recorded value is returned in its place.
 */
export type StepFn<T> = (handle: StepHandle) => Promise<T> | T;

/**
 * Handed to a step's `fn`. Lets the body annotate its own record (sha,
 * transcript key, compact summary) and reach the shared run context.
 */
export interface StepHandle {
  /** The step's own name. */
  name: string;
  /** Child logger scoped to `{ runId, workflowId, step }`. */
  logger: Logger;
  /** Abort signal propagated from the run. */
  signal: AbortSignal;
  /** Record the worktree SHA this step ran against. */
  setSha(sha: string | null): void;
  /** Record the transcript key for this step's full output. */
  setTranscriptKey(key: string | null): void;
  /**
   * Override the compact result summary stored on the record. By default
   * the engine derives a short summary from the return value; call this to
   * supply a domain-specific one.
   */
  setSummary(summary: string): void;
}

/**
 * The context object every workflow function receives as its first
 * argument. It owns run identity, the step contract, the logger, the
 * progress emitter, and the run's abort signal.
 */
export interface WorkflowCtx<Services = unknown> {
  /** Stable run identity; keys every step record. */
  readonly runId: string;
  /** The workflow's name. */
  readonly workflowId: string;
  /** Run-scoped logger; steps get a child of it. */
  readonly logger: Logger;
  /** Abort signal for the whole run. */
  readonly signal: AbortSignal;
  /** Services wired in at `runWorkflow` time (agent runtime, git, fs…). */
  readonly services: Services;

  /**
   * Wrap a durable unit of work.
   *
   * `name` is explicit and LOAD-BEARING: it keys both checkpoint-resume and
   * the trace-view node label. Reaching the same `name` twice within a run
   * THROWS — use templated names (`` `verify-${pkg}` ``) for looped or
   * conditional steps.
   *
   * On resume, if a `'completed'` record already exists for `name`, `fn` is
   * NOT invoked and the recorded result is returned. Otherwise `fn` runs and
   * its return value is recorded.
   */
  step<T>(name: string, fn: StepFn<T>, options?: StepOptions): Promise<T>;

  /** Emit a fine-grained progress event (also logged at info). */
  emit(event: string, payload?: unknown): void;

  /**
   * The {@link StepHandle} of the step currently executing, or `null` when no
   * step is in flight (i.e. directly inside the workflow body, between steps,
   * or after a step settles). Set by the engine for the duration of a step's
   * `fn` and cleared afterwards.
   *
   * This exists so a helper invoked inside a step — e.g. a domain primitive
   * called as `ctx.step('s', () => primitive(ctx))` — can reach the live
   * handle (to record sha / transcript key / summary) WITHOUT the caller
   * having to thread `handle` through every call. Steps run sequentially
   * within a run, so there is never more than one in flight at a time.
   */
  readonly currentStep: StepHandle | null;
}

/** A workflow function: `(ctx, input) => Promise<output>`. */
export type WorkflowFn<I, O, Services = unknown> = (
  ctx: WorkflowCtx<Services>,
  input: I,
) => Promise<O>;

/**
 * A named workflow. `defineWorkflow` is sugar that pins a name and optional
 * input schema onto a workflow function; it does NOT build a graph. The
 * function is still the source of truth — this just gives the run a stable
 * `workflowId` and an optional validation gate.
 */
export interface Workflow<I, O, Services = unknown> {
  /** Stable identity used as `workflowId` on every run. */
  id: string;
  /** Optional Zod schema; when present, input is parsed before the run. */
  inputSchema?: z.ZodType<I>;
  /** The imperative body. */
  fn: WorkflowFn<I, O, Services>;
}

/** Define a named workflow around an imperative function. */
export function defineWorkflow<I, O, Services = unknown>(
  def: Workflow<I, O, Services>,
): Workflow<I, O, Services> {
  return def;
}

/** Options for a single `runWorkflow` invocation. */
export interface RunWorkflowOptions<Services = unknown> {
  /** Persistence backend (resume reads from here, lifecycle writes to it). */
  store: WorkflowStore;
  /** Logger; defaults to a silent one if omitted. */
  logger?: Logger;
  /** Services injected into `ctx.services`. */
  services?: Services;
  /**
   * Reuse an existing run id to resume it. Omit for a fresh run (a new id
   * is generated). Resuming a run whose steps are already `'completed'`
   * skips their `fn`.
   */
  runId?: string;
  /** Abort the run; propagated to `ctx.signal` and every step. */
  signal?: AbortSignal;
  /** Sink for fine-grained progress events from `ctx.emit`. */
  onEvent?: (event: WorkflowEvent) => void;
}

/** The terminal result of a run. */
export interface RunResult<O> {
  runId: string;
  status: 'completed' | 'failed';
  /** The workflow's projected output, present only when `completed`. */
  output?: O;
  /** The failure, present only when `failed`. */
  error?: Error;
}

/**
 * Run (or resume) a workflow.
 *
 * Accepts either a bare function or a `defineWorkflow` result. With a bare
 * function the `workflowId` defaults to the function's `.name`; supply a
 * `Workflow` to pin it explicitly.
 */
export async function runWorkflow<I, O, Services = unknown>(
  workflow: Workflow<I, O, Services> | WorkflowFn<I, O, Services>,
  input: I,
  options: RunWorkflowOptions<Services>,
): Promise<RunResult<O>> {
  const wf: Workflow<I, O, Services> =
    typeof workflow === 'function'
      ? { id: workflow.name || 'workflow', fn: workflow }
      : workflow;

  const parsedInput = wf.inputSchema ? wf.inputSchema.parse(input) : input;

  const store = options.store;
  const logger = options.logger ?? silentLogger();
  const services = (options.services ?? {}) as Services;
  const signal = options.signal ?? new AbortController().signal;
  const runId = options.runId ?? randomUUID();
  const workflowId = wf.id;

  const runLogger = logger.child({ runId, workflowId });

  const now = Date.now();
  const existing = await store.getRun(runId);
  if (!existing) {
    await store.createRun({
      id: runId,
      workflowId,
      inputJson: safeJson(parsedInput),
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
  } else if (existing.status !== 'running') {
    // A resumed run that previously terminated goes back to 'running'
    // until the (possibly re-run) function reaches a terminal state.
    await store.setRunStatus(runId, 'running', now);
  }

  // Names reached during THIS invocation — duplicate detection is per run
  // invocation, so a resumed run can re-reach a name it completed before.
  const seenNames = new Set<string>();

  const ctx: WorkflowCtx<Services> = {
    runId,
    workflowId,
    logger: runLogger,
    signal,
    services,
    currentStep: null,
    emit(event: string, payload?: unknown): void {
      const evt: WorkflowEvent = {
        runId,
        workflowId,
        step: null,
        event,
        payload,
        time: Date.now(),
      };
      runLogger.info({ event, payload }, `event:${event}`);
      options.onEvent?.(evt);
    },
    step<T>(name: string, fn: StepFn<T>, stepOptions?: StepOptions): Promise<T> {
      return runStep<T>({
        name,
        fn,
        stepOptions,
        runId,
        workflowId,
        store,
        logger: runLogger,
        signal,
        seenNames,
        onEvent: options.onEvent,
        // Publish the live step handle onto ctx for the duration of the step so
        // helpers invoked inside it (domain primitives) can reach it without
        // the caller threading `handle`. Cleared back to null when the step
        // settles. `currentStep` is readonly to consumers; the engine owns it.
        setCurrentStep: (handle) => {
          (ctx as { currentStep: StepHandle | null }).currentStep = handle;
        },
      });
    },
  };

  try {
    const output = await wf.fn(ctx, parsedInput);
    await store.setRunStatus(runId, 'completed', Date.now());
    runLogger.info({ event: 'run.completed' }, 'run.completed');
    return { runId, status: 'completed', output };
  } catch (error: unknown) {
    const err = toError(error);
    await store.setRunStatus(runId, 'failed', Date.now());
    runLogger.error({ event: 'run.failed', err: err.message }, 'run.failed');
    return { runId, status: 'failed', error: err };
  }
}

/** Internal args for executing one step. */
interface RunStepArgs<T> {
  name: string;
  fn: StepFn<T>;
  stepOptions: StepOptions | undefined;
  runId: string;
  workflowId: string;
  store: WorkflowStore;
  logger: Logger;
  signal: AbortSignal;
  seenNames: Set<string>;
  onEvent: ((event: WorkflowEvent) => void) | undefined;
  /**
   * Publish the live {@link StepHandle} onto the run ctx for the duration of
   * this step (called with the handle before `fn` runs, and with `null` once
   * the step settles). Lets a primitive invoked inside the step reach the
   * handle via `ctx.currentStep` without the caller threading it.
   */
  setCurrentStep: (handle: StepHandle | null) => void;
}

async function runStep<T>(args: RunStepArgs<T>): Promise<T> {
  const { name, fn, runId, workflowId, store, logger, signal, seenNames } = args;

  if (seenNames.has(name)) {
    throw new Error(
      `Duplicate step name "${name}" in run "${runId}". Step names must be unique within a run; use a templated name (e.g. \`step-\${i}\`) for loops or branches.`,
    );
  }
  seenNames.add(name);

  const stepLogger = logger.child({ step: name });

  // Resume short-circuit: a completed record means this step's side effects
  // already happened. Return the recorded result without invoking `fn`.
  const prior = await store.getStep(runId, name);
  if (prior && prior.status === 'completed') {
    stepLogger.info({ event: 'step.skipped', attempt: prior.attempt }, 'step.skipped');
    args.onEvent?.({
      runId,
      workflowId,
      step: name,
      event: 'step.skipped',
      payload: { attempt: prior.attempt },
      time: Date.now(),
    });
    return decodeResult<T>(prior.resultJson);
  }

  const attempt = (prior?.attempt ?? 0) + 1;
  const startedAt = Date.now();

  // Per-step record annotations the body can mutate while it runs.
  let sha: string | null = args.stepOptions?.sha ?? prior?.sha ?? null;
  let transcriptKey: string | null = args.stepOptions?.transcriptKey ?? prior?.transcriptKey ?? null;
  let summaryOverride: string | null = null;

  const handle: StepHandle = {
    name,
    logger: stepLogger,
    signal,
    setSha: (value) => {
      sha = value;
    },
    setTranscriptKey: (value) => {
      transcriptKey = value;
    },
    setSummary: (value) => {
      summaryOverride = value;
    },
  };

  // Mark the step running before invoking `fn` so a crash mid-step leaves a
  // 'running' row the trace view can show and a resume will retry.
  await store.putStep({
    runId,
    name,
    status: 'running',
    sha,
    startedAt,
    finishedAt: null,
    attempt,
    summary: null,
    errorSummary: null,
    transcriptKey,
    resultJson: null,
  });
  stepLogger.info({ event: 'step.started', attempt }, 'step.started');

  // Publish the live handle onto the run ctx so primitives invoked inside this
  // step can reach it (sha / transcript key / summary) without it being passed
  // through their args. Cleared in the finally below — including on throw —
  // so `ctx.currentStep` is null whenever no step is in flight.
  args.setCurrentStep(handle);
  try {
    const result = await fn(handle);
    const finishedAt = Date.now();
    const summary = summaryOverride ?? summarise(result);
    await store.putStep({
      runId,
      name,
      status: 'completed',
      sha,
      startedAt,
      finishedAt,
      attempt,
      summary,
      errorSummary: null,
      transcriptKey,
      resultJson: safeJson(result),
    });
    stepLogger.info(
      { event: 'step.completed', attempt, durationMs: finishedAt - startedAt },
      'step.completed',
    );
    return result;
  } catch (error: unknown) {
    const err = toError(error);
    const finishedAt = Date.now();
    await store.putStep({
      runId,
      name,
      status: 'failed',
      sha,
      startedAt,
      finishedAt,
      attempt,
      summary: null,
      errorSummary: truncate(err.message),
      transcriptKey,
      resultJson: null,
    });
    stepLogger.error({ event: 'step.failed', attempt, err: err.message }, 'step.failed');
    throw err;
  } finally {
    // Clear the published handle: no step is in flight once this one settles.
    args.setCurrentStep(null);
  }
}

/** Apply a step's outcome metadata to a record (used by consumers/tests). */
export function applyOutcomeMeta(record: StepRecord, meta: StepOutcomeMeta): StepRecord {
  return {
    ...record,
    sha: meta.sha ?? record.sha,
    transcriptKey: meta.transcriptKey ?? record.transcriptKey,
  };
}

const SUMMARY_MAX = 200;

/** Derive a compact, single-line summary of a step's return value. */
function summarise(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return truncate(safeJson(value));
}

function truncate(text: string): string {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

/** Serialise to JSON, tolerating values that can't be stringified. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ unserialisable: true });
  }
}

/** Decode a recorded step result back into its typed shape on resume. */
function decodeResult<T>(json: string | null): T {
  if (json === null) return undefined as T;
  return JSON.parse(json) as T;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : safeJson(value));
}
