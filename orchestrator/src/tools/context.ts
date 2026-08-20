/**
 * Shared primitive plumbing — the `ctx` seam every Mars tool sits on.
 *
 * Split out of the former `workflows/primitives/index.ts` god module
 * (docs/rework/TARGET-ARCHITECTURE.md §2.1). Behaviour is unchanged; this file
 * is the single owner of the per-`ctx` memoised caches (trace context,
 * worktree ref, index card). They MUST live in exactly one module: duplicating
 * them silently breaks `mars continue`, whose worktree recovery depends on
 * `setupWorktree` and `review`/`merge` sharing one WeakMap keyed on the
 * live ctx object.
 *
 * CRITICAL — no-stranded-entity invariant (ADR-0052). `MarsServices.store` is
 * the Arc-backed task store and the sole task-state write funnel. It is read
 * off `ctx.services` by the framework-owned primitive shells only; a tool
 * implementation never sees it.
 */
import type { WorkflowCtx } from '@mars/workflow'

import { nullTraceStore, type TraceCtx } from '../core/lib/run-tool'
import { type WorktreeRef } from '../core/lib/git/worktree'
import { type MergeResult } from '../core/lib/git/merge'
import { getTask, type TaskTag, type TaskSpec } from '../core/queue'
import { resolveOriginIdForTask } from '../core/lib/origin'
import { type DomainTaskStore as TaskStore } from '../core/store/task-store'
import { type TraceEventStore } from '../core/lib/trace-events-store'

// ---------------------------------------------------------------------------
// Services + ctx plumbing (resolved internally, never passed by the user)
// ---------------------------------------------------------------------------

/**
 * The `services` bag the daemon injects at `runWorkflow` time and the primitives
 * read off `ctx.services`. Task-state writes funnel through `store` (the Arc
 * aggregate, ADR-0052); trace events/spans go to `traceStore` (opened once at
 * daemon boot). A scaffolded workflow never constructs this — it is given.
 */
export interface MarsServices {
  /** Arc-backed task store — the sole task-state write funnel (ADR-0052). */
  store: TaskStore
  /** Workflow-level trace store; `nullTraceStore` disables span/event capture. */
  traceStore: TraceEventStore
  /**
   * Optional hook registered by the daemon for the promise-based manual step
   * park/resume mechanism. When present, a step with `mode === 'manual'` calls
   * this hook instead of the legacy `awaitHuman` sentinel-throw path. The hook
   * parks the task (writes `current_step_name` / `current_step_guide` via the
   * Arc write funnel, raises an action-queue row) and returns a Promise that
   * resolves when the operator fires `mars step done` for that step name.
   *
   * When absent, the primitives fall back to {@link awaitHuman} (sentinel
   * throw). This keeps the primitives usable in scaffolded workflows and test
   * contexts that do not wire up the full daemon.
   */
  onManualPark?: (args: {
    runId: string
    taskId: string
    stepName: string
    guide: string | null
  }) => Promise<void>
  /**
   * Optional callback invoked immediately after the coder/fixer child subprocess
   * is spawned, with the child's OS PID. The daemon registers this to call
   * `tracker.recordPid(taskId, pid)` so the phantom-task watchdog can use
   * PID liveness to protect legitimately long runs (case b/c) instead of
   * always falling back to the bare wall-clock ceiling on `task.updatedAt`.
   *
   * When absent the watchdog falls back to the no-PID ceiling path (case a),
   * which is the pre-fix behaviour. Scaffolded and test workflows that do not
   * inject a tracker can safely omit this field.
   */
  onPid?: (pid: number) => void
  /**
   * Optional callback invoked with the OS PID of each verify child subprocess
   * spawned by `verifyChanges`. The daemon uses this to gate the verify-phase
   * heartbeat on real child liveness: if the most recently reported child is
   * dead and has been gone for more than the grace window, the heartbeat stops
   * and the phantom-task watchdog can detect the hung runner as
   * `verify:runner-hung`.
   *
   * Called once per subprocess spawn (not per step). When absent, the heartbeat
   * fires unconditionally and the watchdog falls back to the updatedAt ceiling
   * (pre-fix behaviour).
   */
  onVerifyChildPid?: (pid: number) => void
  /**
   * Optional hook called by the `review` primitive (auto path) immediately
   * before running `verifyChanges`. When present, the daemon:
   *   1. Releases the implement semaphore slot so other tasks can start coding
   *      while this task waits for a verify slot (avoids wasting implement
   *      capacity on tasks that are just queued behind the verify cap).
   *   2. Acquires the verify semaphore (default limit 2, MARS_MAX_VERIFY).
   *   3. Calls `drain()` so freed implement slots are picked up immediately.
   *
   * When absent (scaffolded workflows, tests that don't inject the daemon
   * plumbing), verify runs without a concurrency cap — same as before this
   * feature was added.
   *
   * There is no circular dependency: coding never waits on verify, so a task
   * blocked on the verify semaphore does not prevent the verify semaphore from
   * being released. No deadlock is possible.
   */
  acquireVerifySlot?: () => Promise<void>
  /**
   * Optional hook called by the `review` primitive in its finally block,
   * paired with {@link acquireVerifySlot}. Releases the verify semaphore
   * slot so the next queued verify can proceed.
   *
   * When absent, this is a no-op.
   */
  releaseVerifySlot?: () => void
  /**
   * Optional abort signal from the daemon's per-task verify gate controller.
   * Fires with reason `'verify:child-vanished'` when the heartbeat detects
   * that the verify child pid has been dead for longer than the grace window
   * (`MARS_VERIFY_CHILD_GONE_GRACE_MS`, default 5 min).
   *
   * When this signal fires, `verifyChanges` kills any in-flight subprocess
   * immediately, the primitive classifies the result as `verify:child-vanished`
   * (not the generic gate that happened to fail), and the semaphore slot is
   * released so waiting verifies can proceed — without waiting for the
   * phantom-task watchdog to detect `runner-hung` (~35 min worst-case).
   *
   * When absent (scaffolded workflows, tests), `verifyChanges` runs without
   * an abort signal — same behaviour as before this field was added.
   */
  verifyGateSignal?: AbortSignal
  /**
   * Hook registered by the daemon that routes merge requests through the
   * durable single-consumer merge worker. The `merge` primitive always
   * delegates to this hook; it must be present in all runtime contexts
   * (daemon and integration tests) — there is no fallback path, so every
   * `MarsServices` bag (including test fixtures and scaffolded workflows)
   * must supply it. The hook enqueues a `merge_jobs` row, wakes the worker,
   * and returns a Promise that resolves with the worker's outcome when the
   * job completes.
   */
  enqueueMergeJobAndAwait: (args: {
    taskId: string
    branch: string
    worktreePath: string
    integrationBranch: string
  }) => Promise<{ status: 'done'; result: MergeResult } | { status: 'failed'; error: string; errorCode: string }>
  /**
   * Optional hook to spawn a long-lived preview process for the `reviewType:
   * 'manual'` gate. The daemon injects the real `PreviewRegistry.spawn`; tests
   * inject a fake. When absent the manual-review path throws immediately.
   *
   * Arguments mirror `PreviewRegistry.spawn(taskId, cmd, cwd)`. Returns the
   * OS PID, a log-file path, and an optional detected URL.
   */
  previewSpawn?: (args: {
    taskId: string
    cmd: string
    cwd: string
  }) => Promise<{ pid: number; logPath: string; url?: string }>
}

/**
 * The dispatch-level facts a Mars workflow run is parameterised by. Exposed on
 * `ctx.input` (engine, after any `inputSchema` parse) so a primitive can read a
 * field as its default without the author copying it out of the `input`
 * argument into every options bag. Every field is optional here: a custom
 * workflow may dispatch a partial input, and a primitive's explicit `opts`
 * value always wins over `ctx.input`, which in turn wins over the hard default.
 */
export interface MarsWorkflowInput {
  taskId?: string
  prompt?: string
  plan?: { functional: string; technical: string } | null
  tags?: TaskTag[]
  kind?: 'task' | 'fix' | 'diagnose'
  integrationBranch?: string
  spec?: TaskSpec | null
  resumeFromPriorAttempt?: boolean
  verifyFailureOutput?: string | null
  recoveryPayload?: string | null
  fixForTaskId?: string | null
}

/** The engine ctx a Mars primitive operates on (input typed as {@link MarsWorkflowInput}). */
export type MarsCtx = WorkflowCtx<MarsServices, MarsWorkflowInput>

/**
 * Internal trace/identity context every primitive needs to wrap its work in a
 * span and attribute its shell-outs. Resolved from `ctx` by {@link resolveTrace}
 * — never passed by the caller. Exported (with the resolver helpers below) so
 * the sibling primitive module `./behaviour-verify.ts` shares the same
 * per-ctx memoised caches instead of duplicating the plumbing; scaffolded
 * workflows never touch these.
 */
export interface PrimitiveTraceArgs {
  /** Engine run id (`ctx.runId`); used as `workflowInstanceId` on spans. */
  workflowInstanceId: string
  /** Stable origin attribution for every trace event. */
  originId: string
  /** The owning task id stamped on each span. */
  taskId: string | null
  /** Workflow-level trace store; `nullTraceStore` disables span/event capture. */
  traceStore: TraceEventStore
}

// Per-ctx memoised trace context. originId is a DB round-trip, so resolve it
// once per run and reuse across all four primitives. Keyed on the ctx object so
// a fresh run (fresh ctx) re-resolves.
const traceCache = new WeakMap<object, Promise<PrimitiveTraceArgs>>()

/**
 * Resolve (and memoise on `ctx`) the trace context for this run. The trace
 * store comes from `ctx.services.traceStore` (opened at daemon boot — no
 * per-run re-open); the origin id is resolved best-effort and falls back to the
 * task id. A null/absent traceStore collapses to `nullTraceStore` so a custom
 * workflow never fails on observability.
 */
export const resolveTrace = (ctx: MarsCtx, taskId: string): Promise<PrimitiveTraceArgs> => {
  let p = traceCache.get(ctx)
  if (!p) {
    p = (async (): Promise<PrimitiveTraceArgs> => {
      const traceStore = ctx.services?.traceStore ?? nullTraceStore
      const originId = await resolveOriginIdForTask(taskId).catch(() => taskId)
      return { workflowInstanceId: ctx.runId, originId, taskId, traceStore }
    })()
    traceCache.set(ctx, p)
  }
  return p
}

// Per-ctx memoised worktree ref. `setupWorktree` stashes its result here so
// `verify`/`merge` can read it without the user threading it between steps
// ("magic"). An explicit `opts.worktree` override always wins.
const worktreeCache = new WeakMap<object, WorktreeRef>()

// Per-ctx memoised index card text. `setupWorktree` stashes the built card here
// so `runAgent` can inject it into the composed prompt without re-threading it.
const indexCardCache = new WeakMap<object, string | null>()

/**
 * Resolve the worktree ref. Precedence:
 *   1. explicit `opts.worktree` override,
 *   2. the per-ctx in-memory cache `setupWorktree` populated this run,
 *   3. the worktree persisted on the task row (`worktreePath`/`branch`).
 *
 * The third fallback is what makes step-resume work: on `mars continue` the
 * engine short-circuits the already-completed `setup` step, so it never
 * repopulates the cache for the fresh `ctx` — but `setupWorktree` recorded
 * `worktreePath`/`branch` on the task row (see updateTask in setupWorktree), so
 * a re-run of just `verify`/`merge` can recover the ref from the store. Without
 * this, `mars continue` after a merge-preflight failure loops forever on
 * "no worktree available".
 */
export const resolveWorktree = async (
  ctx: MarsCtx,
  taskId: string,
  store: TaskStore,
  override?: WorktreeRef,
): Promise<WorktreeRef> => {
  const cached = override ?? worktreeCache.get(ctx)
  if (cached) return cached
  // Cache miss (a resumed run): recover from the persisted task row.
  const task = await getTask(taskId, store)
  if (task?.worktreePath != null && task.branch != null) {
    const recovered: WorktreeRef = {
      path: task.worktreePath,
      branch: task.branch,
    }
    worktreeCache.set(ctx, recovered)
    return recovered
  }
  throw new Error(
    'no worktree available: call setupWorktree(ctx, ...) before verify/merge, ' +
      'or pass { worktree } explicitly.',
  )
}

/** Read the run's dispatch input (never throws; `{}` when absent). */
const input = (ctx: MarsCtx): MarsWorkflowInput => ctx.input ?? {}
export { input as readWorkflowInput }


/**
 * The task id a primitive operates on. Precedence: explicit `opts` override →
 * `ctx.input.taskId` (dispatch fact) → `ctx.runId` (the daemon dispatches with
 * runId === task.id, so this is the common case).
 */
export const resolveTaskId = (ctx: MarsCtx, override?: string): string =>
  override ?? input(ctx).taskId ?? ctx.runId

/** Build the per-phase {@link TraceCtx} a primitive threads into git shell-outs. */
export const buildPhaseCtx = (
  trace: PrimitiveTraceArgs,
  taskId: string,
  phase: 'setup' | 'code' | 'verify' | 'merge',
): TraceCtx => ({
  store: trace.traceStore,
  taskId,
  originId: trace.originId,
  phase,
})

/** Resolve the span trace store (undefined when the workflow has no real store). */
export const spanStore = (trace: PrimitiveTraceArgs): TraceEventStore | undefined =>
  trace.traceStore === nullTraceStore ? undefined : trace.traceStore


// ---------------------------------------------------------------------------
// Cache write seams
//
// `setupWorktree` populates the per-ctx worktree / index-card caches that
// `resolveWorktree` (above) and `runAgent` read back. The WeakMaps stay
// module-private so there is exactly one instance of each; these accessors are
// the only way in.
// ---------------------------------------------------------------------------

/** Memoise the worktree ref for this run (called by `setupWorktree`). */
export const cacheWorktree = (ctx: MarsCtx, ref: WorktreeRef): void => {
  worktreeCache.set(ctx, ref)
}

/** Memoise the built index card for this run (called by `setupWorktree`). */
export const cacheIndexCard = (ctx: MarsCtx, card: string | null): void => {
  indexCardCache.set(ctx, card)
}

/** Read the index card `setupWorktree` stashed (undefined when never set). */
export const readCachedIndexCard = (ctx: MarsCtx): string | null | undefined =>
  indexCardCache.get(ctx)
