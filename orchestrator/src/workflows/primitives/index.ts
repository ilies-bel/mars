/**
 * Git step-primitive surface (ADR-0056).
 *
 * ADR-0056 frames the orchestrator as "one library, three logical layers" and
 * says scaffolded `.mars/workflows/*.js` files should COMPOSE engine
 * step-primitives — "workflows are just one implementation". This module is
 * that composable surface: the four reusable primitives — `setupWorktree`,
 * `runAgent`, `verify`, `merge` — mirroring the four steps of the bundled
 * implement pipeline.
 *
 * The `@mars/workflow` engine is deliberately domain-agnostic (it knows nothing
 * about git or Arc). So the primitive surface lives HERE, in the orchestrator
 * (the domain library), and is imported by BOTH:
 *   - the bundled `implement-workflow.ts` (its four `ctx.step` bodies are now
 *     thin compositions over these primitives), and
 *   - scaffolded `.mars/workflows/<kind>-workflow.js` files (which import the
 *     primitives and call them with what `ctx` / `ctx.services` provides).
 *
 * Each primitive takes `(ctx, opts)` — the engine `WorkflowCtx` plus a small
 * bag of per-call domain options. ALL plumbing (the Arc `store`, the trace
 * store, the live step handle, the `emit` sink, the resolved worktree ref) is
 * pulled from `ctx` / `ctx.services` internally, so a scaffolded `.mars/
 * workflows/*.js` file calls them as `setupWorktree(ctx, { kind })` and never
 * touches the plumbing. This is the Claude-SDK-style "options bag with
 * defaults" ergonomics (ADR-0056).
 *
 * `ctx.services` is typed {@link MarsServices} (`{ store, traceStore }`,
 * injected by the daemon at `runWorkflow`). The per-task trace context and the
 * worktree ref are resolved lazily on first use and memoised on `ctx` (see
 * `resolveTrace` / `resolveWorktree`) so the user never calls a `buildTrace`
 * helper or threads the worktree between steps.
 *
 * CRITICAL — no-stranded-entity invariant (ADR-0052). Every primitive that
 * mutates task state routes that mutation through `ctx.services.store`
 * (the Arc-backed `DomainTaskStore`) and the failure handler's `store` arg,
 * exactly as the former inline step bodies did. A custom workflow that calls
 * these primitives therefore CANNOT bypass Arc — the write funnel is baked into
 * the primitive, not left to the caller.
 */
import type { StepHandle, WorkflowCtx } from '@mars/workflow'

import { runTool, nullTraceStore, type TraceCtx } from '../../core/lib/run-tool'
import {
  createWorktree,
  provisionCommitterWorktree,
  removeWorktree,
  attachToOriginWorktree,
  OriginWorktreeMissingError,
  restoreWorktreeIfMissing,
  ResumeWorktreeUnrecoverable,
  syncWorktreeToIntegration,
  WorktreeRebaseConflictError,
  type WorktreeConflictPolicy,
  type WorktreeRef,
} from '../../core/lib/git/worktree'
import {
  cleanWorktreeIfNoCommitsAhead,
  verifyChanges,
  selectVerifySteps,
  getChangedFiles,
  isInfraFailureOutput,
} from '../../core/lib/git/verify'
import {
  appendEnrichmentScopes,
  recordEnrichmentShadowRuns,
} from '../../core/lib/gate-enrichment'
import { mergeBranch, checkMergeTargetStatus, isZeroCommitBranch, isBranchTipInIntegration, type MergeResult } from '../../core/lib/git/merge'
import { autoCommitWorktreeIfDeterministic } from '../../core/lib/git/commit-main'
import {
  createWorker,
  pickWorkerForTags,
  Workers,
  type Worker,
} from '../../core/workers'
import { isTaskTag, type TaskTag, type TaskSpec } from '../../core/queue'
import { resolveContext, getStateDir } from '../../core/context'
import {
  installWorktreeDeps,
  repairInstallInPlace,
  WorktreeInstallError,
  WorktreeModulesMissingError,
} from '../../core/lib/worktree-install'
import { extractLastStreamText, type ClaudeEvent } from '../../core/lib/claude-stream'
import { readWorkerOutputText } from '../../core/lib/worker-json'
import { getTask, hasIncompleteBlockers, TERMINAL_TASK_STATUSES, updateTask } from '../../core/queue'
import { Arc } from '../../core/arc'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { observeVerifyGateFailure } from '../../core/lib/gate-meta-monitor'
import { resolveOriginIdForTask } from '../../core/lib/origin'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { quarantineVerifyGate } from '../../core/verify-gates'
import { buildEventInsert } from '../../bus/publisher'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { findLiveWorktreeDependents } from '../../core/lib/worktree-dependents'
import { AWAIT_HUMAN_SENTINEL } from '../../core/lib/sentinels'
import {
  summarizeUsage,
  summarizeUsageForSemantics,
  buildContextTokenSignals,
} from '../../core/lib/claude-usage'
import { usageSemanticsOf } from '../../core/workers/providers'
import { recordSignals } from '../../core/lib/reflect-signals'
import {
  resolveTaskDomains,
  fetchLessonsForTask,
} from '../../core/store/memory-packet-store'
import { type TraceEventStore } from '../../core/lib/trace-events-store'
import {
  runWorkerWithSpan,
  runNonLlmStepWithSpan,
} from '../../core/lib/run-worker-with-span'
import { type RanVerifyStep } from '../../core/lib/derive-repro-command'
import {
  composePrompt,
  detectPostCoderState,
  failureExcerpt,
  recoveryAttachesToOrigin,
  resolveWorkerSystemPrompt,
  BLOCKERS_ABORT_MESSAGE,
  coderUncommittedFailure,
  CODER_EXIT_NONZERO_ABORT_MESSAGE,
  CODER_UNCOMMITTED_ABORT_MESSAGE,
  CODER_UNCOMMITTED_SIGNATURE,
  CODER_UNCOMMITTED_STEP,
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  MAIN_DIRTY_VERIFY_MESSAGE,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
  WORKTREE_REBASE_CONFLICT_ABORT_MESSAGE,
  AWAIT_HUMAN_MESSAGE,
  QUOTA_REJECTED_ABORT_MESSAGE,
} from './shared'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { loadDeployConfig, DeployConfigError } from '../../core/lib/deployment/config'
import { getProvider } from '../../core/lib/deployment/registry'
import type { DeployResult } from '../../core/lib/deployment/provider'
import {
  ReviewPacketSchema,
  type ReviewPacket,
} from '../../core/lib/review-packet'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Session-key construction (exported for regression tests)
// ---------------------------------------------------------------------------

/**
 * Build a per-invocation session key for a Claude Code dispatch.
 *
 * Format: `<taskId>#<8-hex-random>` — the taskId prefix keeps logs attributable
 * while the random suffix guarantees uniqueness across parallel dispatches and
 * `mars continue` re-entries that would otherwise collide on the same session ID
 * (fix df826e9b, 2026-06-24).
 *
 * Both spawn paths (PTY and headless/stream) normalise the key to a valid UUID
 * via `toClaudeSessionId` before it reaches `claude --session-id`, so a
 * non-UUID key is acceptable here.
 */
export function buildSessionKey(taskId: string): string {
  return `${taskId}#${randomUUID().slice(0, 8)}`
}

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
   * Hook registered by the daemon that routes merge requests through the
   * durable single-consumer merge worker. The `merge` primitive always
   * delegates to this hook; it must be present in all runtime contexts
   * (daemon and integration tests). The hook enqueues a `merge_jobs` row,
   * wakes the worker, and returns a Promise that resolves with the worker's
   * outcome when the job completes.
   */
  enqueueMergeJobAndAwait?: (args: {
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

// ---------------------------------------------------------------------------
// Validation recorder seam (`mars workflow validate`)
// ---------------------------------------------------------------------------

/** One primitive declaration captured during a validation dry-run. */
export interface ValidateRecorderEntry {
  /** The ctx.step name the primitive ran under (null outside a step). */
  step: string | null
  primitive: 'setupWorktree' | 'runAgent' | 'review' | 'merge' | 'awaitHuman'
  /** Execution mode the workflow declares for this step. */
  mode: 'auto' | 'manual' | 'full-review'
  /** Step guide for manual or full-review steps; null otherwise. */
  guide: string | null
}

/**
 * When present on `ctx.services`, every primitive records its declaration
 * (step name, primitive, Execution mode, Step guide) and returns an inert
 * result instead of doing real work — a dry-run that enumerates a user-owned
 * workflow's declared runbook with zero side effects. Threaded via services
 * (per-run state), never an env var, so the daemon can validate one workflow
 * while real dispatches run concurrently.
 */
export interface ValidateRecorder {
  record(entry: ValidateRecorderEntry): void
}

const validationRecorder = (ctx: MarsCtx): ValidateRecorder | null =>
  (ctx.services as { validateRecorder?: ValidateRecorder }).validateRecorder ??
  null

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
// worktree currency
// ---------------------------------------------------------------------------

/**
 * Bring a task's worktree up to date with the integration branch before
 * anything runs inside it.
 *
 * THE DEFECT THIS CLOSES. `mars restart` deliberately preserves `task/<id>`
 * whenever the branch carries unmerged commits (deleting it would destroy the
 * failed attempt's work). `createWorktree` then re-attaches that preserved
 * branch AT ITS OLD TIP rather than branching off the integration tip, so a
 * restarted task re-ran `code` and `verify` against superseded source —
 * worktrees were measured 46-89 commits behind `main`, and `verify` re-failed
 * on assertions `main` had already fixed. No number of restarts could drain
 * such a task. Recovery (`kind:'fix'`) tasks attach to the ORIGIN's worktree,
 * so a stale origin poisoned its recovery for free.
 *
 * Called from two places, because they cover disjoint dispatch paths and the
 * second is a `merge-base --is-ancestor` no-op whenever the first ran:
 *   - `setupWorktree`, before deps are installed, so the install sees current
 *     manifests — this is the path a restarted task takes;
 *   - `runAgent`'s preflight, which is the ONLY guaranteed pre-`code` hook on a
 *     checkpoint-resume (`mars continue`, a watchdog retry), where the completed
 *     `setup` step short-circuits entirely.
 *
 * CONFLICT POLICY — and why it is keyed on the dispatch path, not on how
 * valuable the commits look. I cannot tell "genuinely valuable unique commits"
 * from "superseded auto-commits" safely: a `chore(auto-commit)` subject is only
 * evidence about WHO committed (the orchestrator rescuing a coder's edits), not
 * about whether the diff matters, and judging that needs intent the git
 * metadata does not carry. So the rule is blunt and derived from what each
 * dispatch path has already promised:
 *
 *   - the task carves its OWN branch at setup → `'recreate'`. `mars restart`
 *     already means "run this from scratch": it deletes the run journal, nulls
 *     `branch`/`worktreePath`, and keeps `task/<id>` purely as an archive.
 *     Parking the tip on `refs/mars/parked/<id>-<sha>` honours that archive
 *     obligation without dragging a superseded partial turn forward.
 *   - a recovery attached to its ORIGIN's worktree, or a checkpoint-resume →
 *     `'reconcile'`. The existing commits ARE the premise of the run, so they
 *     must not be reset — but they must not be a dead end either. The live
 *     conflict goes to the vcs-supervisor, the agent this repo already uses for
 *     exactly this at merge time; only if Vega cannot finish does the task fail
 *     with a NAMED, `orchestration`-classified signature (the single recovery
 *     slot is not burnt on a code fixer that cannot see a git conflict) and an
 *     operator item.
 *   - a main-commiter worktree → `'escalate'`. It is carved off the integration
 *     tip, so it is current by construction and cannot reach this at all.
 *
 * WHY NOT A "VALUABLE VS SUPERSEDED COMMITS" TEST for the recovery case. The
 * proposal was to recreate when the origin's only commits are orchestrator
 * `chore(auto-commit)` turns. The live case that motivated this refutes it:
 * `fix-ec2f6c04`'s origin `mars-76fef59f` was described as carrying an
 * auto-commit partial turn, but its one unique commit is
 * `fix(ui): preserve persisted action queue kinds` — a deliberate coder commit,
 * conflicting in a single test file. An auto-commit subject records WHO
 * committed (the orchestrator rescuing a coder's uncommitted edits), never
 * whether the diff matters, so the signal would have discarded real work.
 *
 * `'recreate'` is a SUCCESS path: it records no failure signature, so a fleet
 * of stale branches cannot trip the signature-storm breaker and pause dispatch.
 * It is also idempotent — afterwards the branch IS the integration tip, so a
 * repeat pass short-circuits at `already-current`. Both properties matter: 24
 * of the ~65 active tasks currently carry a divergent branch and will be
 * restarted together.
 */
const ensureWorktreeCurrent = async (args: {
  taskId: string
  ref: WorktreeRef
  integrationBranch: string
  phase: 'setup' | 'code'
  onConflict: WorktreeConflictPolicy
  traceCtx?: TraceCtx
  store: TaskStore
}): Promise<void> => {
  const { taskId, ref, integrationBranch, phase, onConflict, store } = args
  try {
    const outcome = await syncWorktreeToIntegration({
      taskId,
      ref,
      integrationBranch,
      onConflict,
      traceCtx: args.traceCtx,
    })
    if (outcome.kind === 'rebased') {
      console.log(
        `[worktree-sync] task ${taskId}: replayed ${ref.branch} onto ${integrationBranch} ` +
          `(${outcome.from.slice(0, 9)} -> ${outcome.to.slice(0, 9)})` +
          (outcome.checkpointRef === null
            ? ''
            : `; uncommitted work parked on ${outcome.checkpointRef} and restored`),
      )
    }
    if (outcome.kind === 'reconciled') {
      console.log(
        `[worktree-sync] task ${taskId}: vcs-supervisor reconciled ${ref.branch} onto ` +
          `${integrationBranch} (${outcome.from.slice(0, 9)} -> ${outcome.to.slice(0, 9)})` +
          (outcome.vegaSessionId === null
            ? ''
            : `; vega session ${outcome.vegaSessionId}`),
      )
    }
    // `recreated` is logged (loudly, with the parked ref and the recovery
    // command) by syncWorktreeToIntegration itself. Neither it nor `reconciled`
    // is a failure: no status write, no signature, no action-queue row — so
    // neither can feed the signature-storm breaker.
  } catch (err) {
    if (!(err instanceof WorktreeRebaseConflictError)) throw err
    const reason = `${phase}:worktree-rebase-conflict`
    const summary = err.message
    const signature = computeFailureSignature(reason, summary)
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: summary,
        // `FailedPhase` has no 'setup' member; the setup step's own
        // origin-worktree-missing escalation reports 'code' for the same
        // reason. The phase-specific detail lives in `failureReason`.
        failedPhase: 'code',
        failureReason: reason,
        failureSignature: signature,
        failureReasonCode: signature,
      },
      store,
    )
    await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${taskId}: branch ${err.branch} conflicts with ${err.integrationBranch}`,
      body: [
        `Task ${taskId}'s worktree is behind ${err.integrationBranch} and its branch ${err.branch} cannot be replayed onto the current tip — the rebase conflicts.`,
        '',
        'Nothing was discarded. The rebase was aborted, so the worktree at',
        `  ${err.worktreePath}`,
        'is byte-for-byte what it was: every commit on the branch is intact, and any uncommitted change was restored' +
          (err.checkpointRef === null
            ? '.'
            : ` (it is also anchored on ${err.checkpointRef}).`),
        '',
        'The task was NOT allowed to continue on stale code: running it would re-verify against source that ' +
          `${err.integrationBranch} has already moved past, which is how a restarted task fails forever.`,
        '',
        'Resolve explicitly — reconcile the conflict in the worktree and',
        `\`git -C ${err.worktreePath} rebase ${err.integrationBranch}\`, then \`mars restart ${taskId}\`;`,
        `or \`mars purge --force ${taskId}\` if the branch's work is no longer wanted.`,
        '',
        'Rebase output:',
        err.rebaseOutput,
      ].join('\n'),
      payload: {
        taskId,
        branch: err.branch,
        integrationBranch: err.integrationBranch,
        worktreePath: err.worktreePath,
        checkpointRef: err.checkpointRef,
        failureReason: reason,
      },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: `agent:${phase}-worktree-sync`,
      signature: `${taskId}:${reason}`,
      originTaskId: taskId,
    }).catch((raiseErr) => {
      console.error(
        `[worktree-sync] task ${taskId} rebase-conflict escalation errored:`,
        raiseErr,
      )
    })
    throw new WorkflowTerminalError(
      'worktree-rebase-conflict',
      WORKTREE_REBASE_CONFLICT_ABORT_MESSAGE(taskId),
    )
  }
}

// ---------------------------------------------------------------------------
// setupWorktree
// ---------------------------------------------------------------------------

/** Per-call domain options for {@link setupWorktree}. All fields default. */
export interface SetupWorktreeOpts {
  /** Pipeline kind. Default `'task'`. `'fix'` attaches to the origin worktree. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** Serialised recovery payload (`tasks.recovery_payload`); only on `kind:'fix'`. Default null. */
  recoveryPayload?: string | null
  /** The origin task a recovery recovers (`tasks.fix_for_task_id`). Default null. */
  fixForTaskId?: string | null
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /**
   * Conflict policy for {@link syncWorktreeToIntegration}. Overrides the
   * default policy that is derived from `kind`:
   *
   * - Default for `kind:'task'`: `'recreate'` — safe for a fresh branch that
   *   has never been coded yet; the old tip is parked on a ref.
   * - Default for `kind:'fix'`: `'reconcile'` — the origin's existing commits
   *   must not be reset; invoke the vcs-supervisor on conflict.
   *
   * **Use `'reconcile'` for remerge workflows** where the task branch already
   * carries commits that must survive the sync. Passing `'recreate'` (or
   * accepting the default) silently parks the commits and resets to integration
   * tip, after which `isZeroCommitBranch` fires and the merge is skipped with
   * `status='done'` — data loss without an error.
   */
  onConflict?: WorktreeConflictPolicy
}

export interface SetupWorktreeResult {
  path: string
  branch: string
}

/**
 * Provision (or attach to) the worktree the rest of the pipeline runs in, then
 * install its deps. Mirrors the former `setup-worktree` step body verbatim:
 *
 *   - aborts (throws) when the task has incomplete blockers,
 *   - `kind:'fix'` (non-main-commiter) ATTACHES to the origin's worktree+branch
 *     and stacks its commit there; a missing origin worktree fails the fix,
 *     raises an operator action-queue item, and throws the missing-worktree
 *     sentinel,
 *   - everything else CREATES a fresh `task/<id>` worktree off integration,
 *   - records the integration HEAD sha, installs deps, and on a frozen-install
 *     failure attempts an in-place lockfile repair before escalating to a
 *     fix-task.
 *
 * Every task-state write goes through `ctx.services.store` (the Arc funnel), so
 * a custom workflow composing this primitive cannot strand a task.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * const worktree = await ctx.step('setup', () => setupWorktree(ctx, { kind }))
 * ```
 * Stashes the resolved worktree on `ctx` so later `verify`/`merge` calls read
 * it without the caller threading it.
 */
export const setupWorktree = async (
  ctx: MarsCtx,
  opts: SetupWorktreeOpts = {},
): Promise<SetupWorktreeResult> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'setupWorktree',
      mode: 'auto',
      guide: null,
    })
    const inert = { path: '(validation dry-run)', branch: 'validate' }
    worktreeCache.set(ctx, inert)
    return inert
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default. Plumbing
  // (store / trace / handle) is pulled off ctx; the author never passes it.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const recoveryPayload =
    opts.recoveryPayload ?? input(ctx).recoveryPayload ?? null
  const fixForTaskId = opts.fixForTaskId ?? input(ctx).fixForTaskId ?? null
  const store: TaskStore = ctx.services.store
  const trace = await resolveTrace(ctx, taskId)
  const handle: Pick<StepHandle, 'setSha'> | undefined =
    ctx.currentStep ?? undefined

  const result = await runSetupWorktree()
  // Memoise so verify/merge can read the worktree without re-threading it.
  // WorktreeRef and SetupWorktreeResult are the same { path, branch } shape.
  worktreeCache.set(ctx, { path: result.path, branch: result.branch })
  return result

  async function runSetupWorktree(): Promise<SetupWorktreeResult> {
  // Check blockers BEFORE the span: an abort here means no setup work ran, so
  // no span should be emitted.
  if (await hasIncompleteBlockers(taskId, store)) {
    throw new WorkflowTerminalError('blockers-abort', BLOCKERS_ABORT_MESSAGE(taskId))
  }

  // Resolve a recovery (kind=fix) task's worktree by attaching to its origin's
  // existing worktree + branch. A missing origin worktree is a hard,
  // operator-owned failure — stamp the fix failed, raise an action-queue item,
  // and throw the sentinel; never silently recreate (that would discard the
  // origin's in-progress work).
  const attachOriginWorktreeForFix = async (): Promise<WorktreeRef> => {
    const originTaskId = fixForTaskId
    if (originTaskId === null) {
      throw new Error(
        `recovery ${taskId} has kind='fix' but no fixForTaskId; cannot resolve origin worktree`,
      )
    }
    const origin = await getTask(originTaskId, store)
    if (origin !== null && TERMINAL_TASK_STATUSES.has(origin.status)) {
      await updateTask(
        taskId,
        {
          status: 'dropped',
          dropReason: origin.status === 'done' ? 'origin-succeeded' : 'arc-rescued',
        },
        store,
      )
      throw new WorkflowTerminalError(
        'origin-terminal',
        `Chore ${taskId} was dropped because origin ${originTaskId} is already ${origin.status}`,
      )
    }
    const originBranch = origin?.branch ?? null
    const originWorktreePath = origin?.worktreePath ?? null
    try {
      if (origin === null || originBranch === null || originWorktreePath === null) {
        throw new OriginWorktreeMissingError({
          originTaskId,
          expectedPath: originWorktreePath ?? '(unrecorded)',
          expectedBranch: originBranch ?? '(unrecorded)',
        })
      }
      return await attachToOriginWorktree({
        originTaskId,
        originBranch,
        originWorktreePath,
        traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
      })
    } catch (err) {
      if (!(err instanceof OriginWorktreeMissingError)) throw err
      const summary = err.message
      const missingSignature = computeFailureSignature(
        'setup:origin-worktree-missing',
        summary,
      )
      await updateTask(
        taskId,
        {
          status: 'failed',
          error: summary,
          failedPhase: 'code',
          failureReason: 'setup:origin-worktree-missing',
          failureSignature: missingSignature,
          failureReasonCode: missingSignature,
        },
        store,
      )
      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Recovery ${taskId} cannot attach: origin worktree for ${originTaskId} is gone`,
        body: [
          `Recovery task ${taskId} (kind=fix) recovers origin task ${originTaskId}, but the origin's worktree is no longer on disk, so the recovery cannot continue the origin's in-progress work in place.`,
          '',
          'Context:',
          `  Expected branch: ${err.expectedBranch}`,
          `  Expected worktree: ${err.expectedPath}`,
          '',
          'Resolve explicitly — e.g. `mars restart` the origin to re-run it from a fresh worktree, or `mars purge` it if the work is no longer needed. The orchestrator does not silently recreate a recovery worktree, because branching off the integration tip would discard the origin\'s in-progress changes.',
        ].join('\n'),
        payload: {
          recoveryTaskId: taskId,
          originTaskId,
          expectedBranch: err.expectedBranch,
          expectedWorktreePath: err.expectedPath,
        },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'agent:setup-worktree',
        signature: `${originTaskId}:setup:origin-worktree-missing`,
        originTaskId,
        occurrence: {
          at: new Date().toISOString(),
          recoveryTaskId: taskId,
        },
      }).catch((raiseErr) => {
        console.error(
          `[setup] recovery ${taskId} origin-worktree-missing escalation errored:`,
          raiseErr,
        )
      })
      throw new WorkflowTerminalError('origin-worktree-missing', ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE(taskId))
    }
  }

  return await runNonLlmStepWithSpan({
    stepName: 'setup-worktree',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId: taskId,
    phase: 'setup',
    traceStore: spanStore(trace),
    fn: async (): Promise<SetupWorktreeResult> => {
      await updateTask(taskId, { status: 'running' }, store)

      // Ordinary recovery (kind=fix) tasks attach to the origin's worktree;
      // a main-commiter recovery (also kind=fix) carves its own fresh worktree.
      let isMainCommiterFix = false
      if (kind === 'fix' && recoveryPayload != null) {
        const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
          '../../core/lib/main-dirty'
        )
        isMainCommiterFix =
          parseMainCommiterPayload(recoveryPayload)?.recipe ===
          MAIN_COMMITER_RECIPE
      }
      const attachesToOrigin = recoveryAttachesToOrigin(
        kind,
        isMainCommiterFix,
      )
      // A main-commiter recovery MUST carry the integration branch's dirty
      // state into its fresh worktree (checkpoint capture on repoRoot → apply
      // by object id in the worktree, see `core/lib/git/checkpoint.ts`) so the
      // committer coder sees the files it is meant to commit.
      // The generic createWorktree() branches off the clean integration tip
      // and leaves the dirty state stranded on the integration checkout —
      // every downstream task then fails verify:main-dirty forever.
      const ref = attachesToOrigin
        ? await attachOriginWorktreeForFix()
        : isMainCommiterFix
          ? await provisionCommitterWorktree({
              recoveryTaskId: taskId,
              integrationBranch,
              traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
            })
          : await createWorktree({
              taskId,
              integrationBranch,
              traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
            })
      await updateTask(
        taskId,
        { branch: ref.branch, worktreePath: ref.path },
        store,
      )

      // The worktree exists — but existing is not the same as CURRENT. A
      // preserved `task/<id>` branch (restart) or an attached origin worktree
      // (recovery) starts at whatever tip it was left at, which is how a
      // restarted task ended up verifying against source dozens of commits
      // behind the integration branch. Replay it onto the tip BEFORE deps are
      // installed, so the install below reads the current manifests.
      //
      // Only a task that carves its OWN branch may recreate on conflict.
      //
      // A recovery attached to its origin's worktree exists to continue THAT
      // work in place, so its commits must not be reset — but escalating was a
      // dead end: the recovery could never start, so it failed, and its origin
      // sat blocked behind a permanently-failed blocker. It reconciles instead,
      // handing the live conflict to the vcs-supervisor and only escalating if
      // Vega cannot finish.
      //
      // A main-commiter worktree is carved off the integration tip and is
      // therefore current by construction; it keeps the conservative default.
      await ensureWorktreeCurrent({
        taskId,
        ref,
        integrationBranch,
        phase: 'setup',
        // An explicit `onConflict` in opts always wins. This lets remerge
        // workflows pass `'reconcile'` to prevent a diverged branch from being
        // silently recreated (which would zero its commits, trigger the
        // `isZeroCommitBranch` short-circuit, and mark the task done while the
        // commits were never in integration — the root cause of the silent
        // data-loss bug this option was added to fix).
        onConflict: opts.onConflict ?? (isMainCommiterFix
          ? 'escalate'
          : attachesToOrigin
            ? 'reconcile'
            : 'recreate'),
        traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
        store,
      })

      // Capture the integration HEAD sha at setup time (non-fatal).
      try {
        const { repoRoot } = resolveContext()
        const r = await runTool(
          {
            tool: 'git',
            argv: ['rev-parse', integrationBranch],
            cwd: repoRoot,
            taskId,
            originId: trace.originId,
            phase: 'setup',
          },
          trace.traceStore,
        )
        if (r.exitCode !== 0) throw new Error(`rev-parse exit ${r.exitCode}`)
        const headSha = r.stdout.trim()
        handle?.setSha(headSha)
        await updateTask(taskId, { integrationHeadSha: headSha }, store)
      } catch {
        // Non-fatal: leave integration_head_sha as null.
      }

      try {
        const summary = await installWorktreeDeps({
          worktreeRoot: ref.path,
          requireModuleTrees: true,
          log: (line) => console.log(line),
          traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
        })
        if (summary.sites.length > 0) {
          console.log(
            `[setup] task ${taskId} install completed in ${(
              summary.totalDurationMs / 1000
            ).toFixed(1)}s (${summary.sites.length} manifest${summary.sites.length === 1 ? '' : 's'})`,
          )
        }
      } catch (error: unknown) {
        const isInstallErr = error instanceof WorktreeInstallError
        const isModulesMissingErr = error instanceof WorktreeModulesMissingError
        const errorOutput = isInstallErr ? error.message : String(error)
        const failingStep = isModulesMissingErr
          ? error.failureStep
          : 'setup:install'

        // Repair-in-place FIRST: a frozen-install failure is an environment
        // failure, not a code defect. Reconcile the lockfile in the origin's
        // own worktree and continue; only escalate if the repair fails.
        if (isInstallErr) {
          try {
            const repair = await repairInstallInPlace({
              site: error.site,
              log: (line) => console.log(line),
              traceCtx: buildPhaseCtx(trace, taskId, 'setup'),
            })
            if (repair.repaired) {
              if (repair.lockfileChanged) {
                for (const argv of [
                  ['add', '-A'],
                  [
                    'commit',
                    '-m',
                    `chore(setup): reconcile ${error.site.lockfile} with manifest (in-place install repair)`,
                  ],
                ]) {
                  const c = await runTool(
                    {
                      tool: 'git',
                      argv,
                      cwd: ref.path,
                      taskId,
                      originId: trace.originId,
                      phase: 'setup',
                    },
                    trace.traceStore,
                  )
                  if (c.exitCode !== 0) {
                    throw new Error(
                      `git ${argv[0]} after lockfile repair exited ${c.exitCode}: ${c.stderr}`,
                    )
                  }
                }
                console.log(
                  `[setup:install] task ${taskId} reconciled ${error.site.lockfile} in place and committed; continuing`,
                )
              } else {
                console.log(
                  `[setup:install] task ${taskId} install recovered in place (no lockfile change); continuing`,
                )
              }
              return { path: ref.path, branch: ref.branch }
            }
            console.log(
              `[setup:install] task ${taskId} in-place repair did not reconcile; escalating to fix-task`,
            )
          } catch (repairErr: unknown) {
            console.error(
              `[setup:install] task ${taskId} in-place repair errored; escalating to fix-task:`,
              repairErr,
            )
          }
        }

        const failSummary = errorOutput.slice(0, 1000)
        const setupSignature = computeFailureSignature(failingStep, errorOutput)
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: failSummary,
            failedPhase: 'code',
            failureReason: isModulesMissingErr ? failingStep : failSummary,
            failureSignature: setupSignature,
            failureReasonCode: setupSignature,
          },
          store,
        )
        await handleTaskFailureWithFixTask({
          taskId,
          failingStep,
          errorOutput: isModulesMissingErr
            ? `dependency module tree missing\n${errorOutput}`
            : `frozen-lockfile install failed\n${errorOutput}`,
          branch: ref.branch,
          store,
          recipeContext: {
            targetPath: isInstallErr || isModulesMissingErr ? error.site.dir : ref.path,
            statusOutput: errorOutput,
            targetBranch: ref.branch,
            originalPrompt: '',
          },
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${taskId} ${failingStep} handling errored:`,
            err,
          )
        })
        throw error instanceof Error ? error : new Error(errorOutput)
      }

      return { path: ref.path, branch: ref.branch }
    },
  })
  }
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * Per-call domain options for {@link runAgent}. Every field defaults — `prompt`
 * falls back to `ctx.input.prompt`, so a step can be as terse as
 * `runAgent(ctx)`. Pass `prompt` explicitly only to override the dispatch input.
 */
export interface RunAgentOpts {
  /** The task prompt fed to the coder. Defaults to `ctx.input.prompt`. */
  prompt?: string
  /** Optional plan sections injected into the composed prompt. Default null. */
  plan?: { functional: string; technical: string } | null
  /** Routing tags (selects the Worker). Default `['coder']`. */
  tags?: TaskTag[]
  /** Pipeline kind. Default `'task'`. `'fix'` routes to the Fixer. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Structured task spec. Default null. */
  spec?: TaskSpec | null
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** True when re-dispatched to repair a prior attempt (prepends a resume banner). Default false. */
  resumeFromPriorAttempt?: boolean
  /** Recorded output from the failed verify, when the resumed coder should repair it. */
  verifyFailureOutput?: string | null
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /** Override the worktree (defaults to the one stashed by setupWorktree). */
  worktree?: WorktreeRef
  /**
   * Override the model for this step. Mirrors the Agent SDK's per-call
   * `{ prompt, model }`: precedence is `opts.model ?? MARS_WORKER_MODEL (Coder
   * only) ?? the selected Worker's pinned default`. Applies to whichever Worker
   * the tags/kind resolve to (Coder, Fixer, or an operator-declared Worker),
   * so a step can run on a heavier model without editing Worker configs.
   */
  model?: string
}

export interface RunAgentResult {
  /** Claude session id (transcript key), null when the run produced none. */
  sessionId: string | null
}

/**
 * Run the coder through the selected headless provider inside the worktree. Mirrors the former
 * `run-claude-code` step body: sweeps stray debris from a prior failed attempt
 * (gated on 0 commits ahead), composes the full prompt, picks the worker
 * (kind-aware: fix → Fixer; else tag-routed including registry workers), runs
 * the worker span, classifies the post-coder worktree state for the run log,
 * and records usage signals.
 *
 * Context-budget hard abort (exitCode 138 + "context budget exhausted") is
 * handled here exactly as before: stamp the task failed, spawn the resume
 * fix-task through `store`, and throw the context-exhausted sentinel.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * await ctx.step('code', () => runAgent(ctx, { prompt: input.prompt, tags: input.tags }))
 * ```
 * Coder progress is forwarded to `ctx.emit('claude-event', …)` internally.
 */
export const runAgent = async (
  ctx: MarsCtx,
  opts: RunAgentOpts = {},
): Promise<RunAgentResult> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'runAgent',
      mode: 'auto',
      guide: null,
    })
    return { sessionId: null }
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default. Plumbing
  // (store / trace / emit / handle / worktree) is pulled off ctx.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const prompt = opts.prompt ?? input(ctx).prompt
  if (prompt === undefined) {
    throw new Error(
      `runAgent: no prompt — pass { prompt } or dispatch the run with ctx.input.prompt (task ${taskId})`,
    )
  }
  const plan = opts.plan ?? input(ctx).plan ?? null
  const tags: TaskTag[] = opts.tags ?? input(ctx).tags ?? ['coder']
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const spec = opts.spec ?? input(ctx).spec ?? null
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const resumeFromPriorAttempt =
    opts.resumeFromPriorAttempt ?? input(ctx).resumeFromPriorAttempt ?? false
  const verifyFailureOutput =
    opts.verifyFailureOutput ?? input(ctx).verifyFailureOutput ?? null
  const model = opts.model
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)
  const emit = (event: ClaudeEvent): void => ctx.emit('claude-event', event)
  const handle: Pick<StepHandle, 'setTranscriptKey'> | undefined =
    ctx.currentStep ?? undefined

  const worktreePath = worktree.path
  const branch = worktree.branch

  // ── Resume preflight: the worktree must actually exist ────────────────────
  // On a checkpoint-resume (a watchdog-killed task being retried, `mars
  // continue`, any re-dispatch with runId=task.id) the completed `setup` step
  // short-circuits and `resolveWorktree` hands back the path recorded on the
  // task row WITHOUT revalidating it. If that directory was removed while the
  // task was parked, every spawn below runs with a dead `cwd` and Node reports
  // `spawn <bin> ENOENT` → exit 127 in ~20ms, which looks exactly like a
  // missing provider binary and buckets as a contentless coder-exit-nonzero.
  // Re-attach the worktree from its branch when possible so the retry gets a
  // real working directory; fail with a NAMED signature when it cannot be.
  try {
    const restored = await restoreWorktreeIfMissing({
      taskId,
      ref: { path: worktreePath, branch },
      traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    })
    if (restored === 'rebuilt') {
      console.log(
        `[resume] task ${taskId}: worktree ${worktreePath} was missing on resume; ` +
          `re-attached from branch ${branch}`,
      )
    }
  } catch (err) {
    if (!(err instanceof ResumeWorktreeUnrecoverable)) throw err
    const summary = err.message
    const missingSignature = computeFailureSignature('code:worktree-missing', summary)
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: summary,
        failedPhase: 'code',
        failureReason: 'code:worktree-missing',
        failureSignature: missingSignature,
        failureReasonCode: missingSignature,
      },
      store,
    )
    throw new WorkflowTerminalError('resume-worktree-missing', summary)
  }

  // ── Currency preflight: the worktree must contain the integration tip ─────
  // A checkpoint-resume short-circuits the completed `setup` step, so this is
  // the only hook guaranteed to run before the coder on `mars continue` / a
  // watchdog retry. It is a single `merge-base --is-ancestor` probe when setup
  // already synced and the integration branch has not advanced since.
  //
  // `reconcile`, never `recreate`: by the time the code step runs, the branch's
  // commits are the run's own prior progress — `resumeFromPriorAttempt` literally
  // tells the coder "prior progress is already in this worktree, review
  // `git log -p` and continue". Resetting it here would silently gut that, so
  // a conflict goes to the vcs-supervisor and only escalates if it cannot be
  // reconciled.
  await ensureWorktreeCurrent({
    taskId,
    ref: { path: worktreePath, branch },
    integrationBranch,
    phase: 'code',
    onConflict: 'reconcile',
    traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    store,
  })

  // Sweep stray untracked files from a prior failed attempt BEFORE the agent
  // runs (gated on 0 commits ahead so real committed work is preserved).
  try {
    const cleanResult = await cleanWorktreeIfNoCommitsAhead({
      worktreePath,
      integrationBranch,
      traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    })
    if (cleanResult.cleaned && cleanResult.output.trim().length > 0) {
      console.log(
        `[clean] task ${taskId} ${cleanResult.reason}\n${cleanResult.output.trim()}`,
      )
    } else if (!cleanResult.cleaned) {
      console.log(`[clean] task ${taskId} skipped: ${cleanResult.reason}`)
    }
  } catch (err) {
    console.error(
      `[clean] task ${taskId} threw, continuing without clean:`,
      err,
    )
  }

  const originId = await resolveOriginIdForTask(taskId)
  const primaryTag: TaskTag = tags.find(isTaskTag) ?? 'coder'
  const basePrompt = resumeFromPriorAttempt
    ? `## Resume prior work\n\nPrior progress is already in this worktree. Run \`git log -p\` first to review what was already completed, then continue from where the last coder stopped. Do NOT restart from scratch.${verifyFailureOutput === null ? '' : `\n\nThe previous verification failed. Fix the task diff using this recorded output:\n\n\`\`\`text\n${verifyFailureOutput}\n\`\`\``}\n\n${prompt}`
    : prompt
  const fullTask = await store.getTask(taskId).catch(() => null)
  const domains = resolveTaskDomains({
    workflow: fullTask?.workflow ?? null,
    tags,
  })
  const lessons = await fetchLessonsForTask(domains).catch(() => [] as string[])
  const fullPrompt = composePrompt(
    basePrompt,
    plan,
    primaryTag,
    spec ?? null,
    taskId,
    worktreePath,
    kind,
    lessons,
  )

  // Registry workers: merge operator-declared Workers so their tag sets are
  // visible to pickWorkerForTags. listMergedWorkers now returns fully-
  // constructed Worker instances, so no createWorker call is needed here.
  const { listMergedWorkers } = await import('../../core/workers/persisted-registry')
  const mergedWorkers = listMergedWorkers(resolveContext().stateDir)
  const allWorkers: Record<string, Worker> = { ...Workers }
  for (const worker of mergedWorkers) {
    if (!(worker.config.name in allWorkers)) {
      allWorkers[worker.config.name] = worker
    }
  }
  const selectedWorker =
    kind === 'fix' ? Workers.Fixer : pickWorkerForTags(tags, allWorkers)
  // Per-step model override (Agent-SDK parity): rebuild the chosen Worker with
  // the requested model so it threads through buildWorker to both the headless
  // and pty spawn paths. Undefined ⇒ keep the Worker's pinned default.
  const worker =
    model !== undefined && model !== selectedWorker.config.model
      ? createWorker({ ...selectedWorker.config, model })
      : selectedWorker
  // How the selected Worker's Provider reports usage. Every token read below
  // (post-coder telemetry, reflect signals) goes through it — the assistant
  // shape is Claude's alone.
  const coderSemantics = usageSemanticsOf(worker.config.provider)

  // Generate a fresh random invocation token per coder/recovery dispatch so
  // concurrent and rapid-resume runs NEVER collide on the same Claude session
  // UUID. The previous retryCount-based salt was insufficient because:
  //   (a) `mars continue` does not increment retryCount, so a code-phase
  //       re-entry after a kill reused the same UUID while Claude still held it,
  //       producing "Session ID <uuid> is already in use" exits.
  //   (b) Under parallel recovery the orchestrator can spawn multiple code
  //       phases faster than Claude releases session bookkeeping, causing the
  //       same collision even when retryCount differs across tasks.
  //
  // A per-invocation random suffix makes every dispatch unconditionally unique.
  // The session key is still prefixed with taskId so traces/logs remain
  // attributable to the task. Both spawn paths normalise the key to a valid
  // UUID via toClaudeSessionId (PTY in providers.ts, headless/stream in
  // claudeStreamArgs) before it reaches `claude --session-id`, so a non-UUID
  // key is acceptable here.
  const sessionKey = buildSessionKey(taskId)

  const r = await runWorkerWithSpan({
    worker,
    prompt: fullPrompt,
    runOptions: {
      cwd: worktreePath,
      sessionId: sessionKey,
      systemPrompt: resolveWorkerSystemPrompt(primaryTag),
      onEvent: async (event) => {
        emit?.(event)
      },
      // Wire the spawn-time PID callback so the phantom-task watchdog can
      // switch from the bare wall-clock ceiling (no-PID path, case a) to the
      // alive-PID + heartbeat path (case b/c), preventing false ceiling kills
      // of legitimately long-running coders.
      onPid: ctx.services.onPid,
      externalAbort: ctx.signal,
    },
    traceStore: spanStore(trace),
    stepName: 'run-claude-code',
    workflowInstanceId: trace.workflowInstanceId,
    originId,
    taskId,
    phase: 'code',
  })

  // A task stop is an operator decision, not a coder failure. Bail out before
  // the ordinary non-zero-exit recovery path can stamp or recover the task;
  // the daemon already marked it failed with failureReason='cancelled'.
  if (ctx.signal.aborted) throw new Error(`task ${taskId} stopped by operator`)

  // Context-budget hard abort: spawn a resume fix-task and throw the sentinel.
  if (r.exitCode === 138 && r.stderr.includes('context budget exhausted')) {
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: `context-exhausted: coder hit the context token budget limit`,
        failedPhase: 'code',
        failureReason: 'context-exhausted',
        failureReasonCode: 'context-exhausted',
        // Self-heal keys off `failure_signature`, not `failure_reason_code`:
        // a NULL here hides the failure from recipe matching, the storm streak
        // counter and the Steward brief.
        failureSignature: computeFailureSignature(
          'code:context-exhausted',
          'context budget exhausted (maxContextTokens) mid-code',
        ),
      },
      store,
    )
    await handleTaskFailureWithFixTask({
      taskId,
      failingStep: 'code:context-exhausted',
      errorOutput: `context budget exhausted (maxContextTokens) mid-code; the worktree holds in-progress work to resume`,
      branch,
      store,
      recipeContext: {
        targetPath: worktreePath,
        statusOutput: `The coder ran out of context budget mid-implementation. The worktree at ${worktreePath} holds whatever it committed before the kill — read it and continue.`,
        targetBranch: branch,
        originalPrompt: '',
      },
    })
    console.log(
      `[ctx] task ${taskId}: context-exhausted; recovery fix-task spawned to resume the existing worktree`,
    )
    throw new WorkflowTerminalError('context-exhausted', CONTEXT_EXHAUSTED_ABORT_MESSAGE(taskId))
  }

  // Provider rate/spend-limit rejection (GLOBAL ENVIRONMENTAL CONDITION).
  //
  // When the provider rejects the run before the coder can do any work (e.g.
  // monthly spend limit, five-hour rate limit), the Claude CLI emits a
  // `rate_limit_event` followed by a `result` event with is_error:true and
  // api_error_status:429, then exits non-zero. This is NOT a code failure —
  // the coder never ran, the worktree is untouched, and spawning a recovery
  // fix-task would instantly hit the same rejection and burn the single
  // recovery slot with nothing to show for it.
  //
  // Correct response: re-queue with the worktree intact, throw a quota-
  // rejection sentinel that the daemon catches to pause dispatch until
  // resetsAt and raise exactly one level-triggered action-queue row.
  if (r.exitCode !== 0 && r.quotaRejected !== null) {
    // Increment the quota-rejected counter so the poll-fallback ceiling can
    // discount these attempts. Fetch the current value for a safe increment;
    // the task semaphore guarantees one active coder per task so no race.
    const currentTask = await getTask(taskId, store)
    const nextQuotaRejectedAttempts = (currentTask?.quotaRejectedAttempts ?? 0) + 1
    await updateTask(taskId, { status: 'queued', quotaRejectedAttempts: nextQuotaRejectedAttempts }, store)
    console.log(
      `[code] task ${taskId}: env-rejected by provider quota (resetsAt=${r.quotaRejected.resetsAt}); re-queued; quotaRejectedAttempts=${nextQuotaRejectedAttempts}`,
    )
    throw new WorkflowTerminalError('quota-rejected', QUOTA_REJECTED_ABORT_MESSAGE(taskId, r.quotaRejected.resetsAt), { resetsAt: r.quotaRejected.resetsAt })
  }

  // Catch-all for any OTHER non-zero coder exit (138/context-exhausted is the
  // only sentinel handled above). Previously such an exit fell straight through
  // to the normal return: verify then no-ops on the untouched worktree and an
  // empty diff merges as a false "done". A real example is claude rejecting a
  // bad --session-id ("Invalid session ID. Must be a valid UUID.") and exiting
  // before doing any work. Treat it as a code-phase failure: stamp the task,
  // spawn exactly one recovery fix-task, and throw to stop before verify/merge.
  if (r.exitCode !== 0) {
    const stderrTail = r.stderr.trim().slice(-1000)
    // When the claude CLI dies from an API-level rejection (e.g. monthly spend
    // limit, auth error) it exits non-zero but writes nothing to stderr — the
    // actual cause arrives in the event stream as a `result` event or a final
    // assistant message. Fall back to that text so the task `error` field is
    // diagnosable without reading the raw transcript.
    const diagText =
      stderrTail.length > 0
        ? `stderr tail:\n${stderrTail}`
        : (() => {
            const streamText = extractLastStreamText(r.conversation)
            return streamText
              ? `stderr empty; last stream text:\n${streamText.slice(-500)}`
              : `stderr empty; no stream text captured`
          })()

    // Before reporting failure, detect whether the coder did real work before
    // it was killed. A watchdog kill, timeout, or quota death can leave
    // completed but uncommitted changes in the worktree — work that would be
    // silently lost if the fixer starts from a clean tree. Preserve those
    // changes as a wip(checkpoint) commit so the recovery fixer inherits a
    // reviewable, rebuildable baseline. The marker is intentionally
    // unambiguous so the fixer can distinguish checkpointed WIP from
    // deliberate commits and knows not to merge as-is.
    let checkpointFiles: string[] | null = null
    try {
      const postState = await detectPostCoderState({
        worktreePath,
        integrationBranch,
        traceCtx: buildPhaseCtx(trace, taskId, 'code'),
      })
      if (
        postState.kind === 'dirty-no-commits' ||
        postState.kind === 'dirty-with-commits'
      ) {
        const addR = await runTool(
          {
            tool: 'git',
            argv: ['add', '-A'],
            cwd: worktreePath,
            taskId,
            originId,
            phase: 'code',
          },
          trace.traceStore,
        )
        if (addR.exitCode === 0) {
          const commitMsg = `wip(checkpoint): coder killed (exit ${r.exitCode}) with ${postState.dirtyFiles.length} uncommitted path(s) — do not merge as-is`
          const commitR = await runTool(
            {
              tool: 'git',
              argv: ['commit', '-m', commitMsg],
              cwd: worktreePath,
              taskId,
              originId,
              phase: 'code',
            },
            trace.traceStore,
          )
          if (commitR.exitCode === 0) {
            checkpointFiles = postState.dirtyFiles
            console.log(
              `[code] task ${taskId}: checkpointed ${postState.dirtyFiles.length} uncommitted path(s) as wip(checkpoint) commit (exit ${r.exitCode})`,
            )
          }
        }
      }
    } catch (err) {
      console.warn(`[code] task ${taskId}: checkpoint attempt failed, continuing:`, err)
    }

    const worktreeNote =
      checkpointFiles !== null
        ? `worktree had ${checkpointFiles.length} uncommitted path(s); preserved as wip(checkpoint) commit on branch ${branch}`
        : 'worktree was clean at exit (no uncommitted work found)'

    // One string, two consumers: the row's `error` column and the signature the
    // failure handler computes. Deriving both from the same text keeps the
    // stamped signature identical to the one the handler mints, so
    // `upsertFixTask`'s (taskId, signature) dedup agrees across the two paths.
    const coderExitOutput = `coder process exited ${r.exitCode}. ${worktreeNote}. ${diagText}`
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: `coder exited ${r.exitCode} before completing; ${diagText}`,
        failedPhase: 'code',
        failureReason: 'coder-exit-nonzero',
        failureReasonCode: 'coder-exit-nonzero',
        // Without this the row lands with a NULL signature and is invisible to
        // recipe matching (`code:coder-exit-nonzero/api-unreachable` and
        // friends), the storm streak counter and the Steward brief.
        failureSignature: computeFailureSignature(
          'code:coder-exit-nonzero',
          coderExitOutput,
        ),
      },
      store,
    )
    await handleTaskFailureWithFixTask({
      taskId,
      failingStep: 'code:coder-exit-nonzero',
      errorOutput: coderExitOutput,
      branch,
      store,
      recipeContext: {
        targetPath: worktreePath,
        statusOutput:
          checkpointFiles !== null
            ? `The coder exited ${r.exitCode} mid-run. The worktree had ${checkpointFiles.length} uncommitted path(s) which have been preserved as a wip(checkpoint) commit on branch ${branch}. Review the checkpoint (\`git -C ${worktreePath} log -p -1\`) and continue from there — do NOT redo work that is already in the checkpoint commit.`
            : `The coder exited ${r.exitCode} and the worktree was clean at exit (no uncommitted work found). Investigate the exit cause from the diagnostic text before retrying.`,
        targetBranch: branch,
        originalPrompt: '',
      },
    })
    console.log(
      `[code] task ${taskId}: coder exited ${r.exitCode}; recovery fix-task spawned`,
    )
    throw new WorkflowTerminalError('coder-exit-nonzero', CODER_EXIT_NONZERO_ABORT_MESSAGE(taskId, r.exitCode))
  }

  // Classify the worktree end-state. A `dirty-no-commits` tree (the coder did
  // real work but never ran `git commit`) is NOT benign: it silently falls
  // through verify (the has-diff gate reads 0 commits ahead and PASSES it as a
  // no-op) into merge, which rebases an empty branch and dispatches the
  // vcs-supervisor with a "rebase just conflicted / is in progress" prompt that
  // is false — Vega aborts, no recipe matches, and the first-principles recovery
  // idles until the phantom-task watchdog ceiling kills it (~2h; observed on
  // mars-c6cab686 / fix-64929590). Catch it here, at the earliest point, and
  // spawn exactly one cheap recovery whose only job is to commit the work that
  // is already in the worktree — mirroring the coder-exit-nonzero handler above.
  // Classifier failures (`error`) stay best-effort: log and fall through, so a
  // transient git hiccup never blocks an otherwise-good run.
  let postState: Awaited<ReturnType<typeof detectPostCoderState>> | null = null
  let commitSource: 'self' | 'corrected' | 'net' | 'no-work' | 'unknown' = 'unknown'
  try {
    postState = await detectPostCoderState({
      worktreePath,
      integrationBranch,
      traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    })
    if (postState.kind === 'error') {
      console.warn(
        `[post-coder] task ${taskId}: classifier error: ${postState.error}`,
      )
    }
    if (postState.kind === 'clean-with-commits') commitSource = 'self'
    if (postState.kind === 'clean-no-work') commitSource = 'no-work'
  } catch (err) {
    console.warn(
      `[post-coder] task ${taskId}: classifier threw, continuing:`,
      err,
    )
  }

  // --- Coder commit contract -----------------------------------------------
  // Post-condition on the `code` step: the coder must hand over a CLEAN
  // worktree. TWO shapes violate it and they are the SAME defect, so they get
  // the SAME two-stage escalation:
  //
  //   `dirty-no-commits`   — the coder committed nothing at all.
  //   `dirty-with-commits` — the coder committed once, kept working, and left
  //                          the rest dirty.
  //
  // Until 2026-07 only the first shape was recoverable; the second failed the
  // task outright as `code:commit-contract/uncommitted-changes`, on the theory
  // that a coder which had already committed deliberately chose to leave the
  // rest out. Live evidence says otherwise: that signature became the single
  // largest source of task failures and tripped the signature-storm circuit
  // breaker, and the leftover paths were ordinary source and test files the
  // coder simply never got around to committing. Failing a task for it throws
  // away a worktree full of good work over a missing `git commit`.
  //
  // The escalation is the one `fix-recipes.ts` already documents for
  // `code/uncommitted-changes`, now applied to both shapes:
  //
  //   1. One corrective coder turn — the coder gets to commit its own work
  //      rather than have the orchestrator take authorship of it.
  //   2. A guarded, deterministic `git add -A && git commit` net, attributed to
  //      the orchestrator (`chore(auto-commit): task <id> — …`) so history
  //      never implies the agent committed it.
  //
  // Only when BOTH fail is the task terminal — the guard refused an unsafe
  // path (`.env`, `.mars/`, `node_modules`), or git itself rejected the commit
  // (pre-commit hook, nothing stageable). That case keeps the registered
  // `code/uncommitted-changes` signature, which failure-kinds.ts and
  // fix-recipes.ts both know how to name and recover.
  //
  // Deliberately NOT asserted here: that the branch is ahead of
  // `integrationBranch`. Zero commits ahead is a legitimate terminal state —
  // verify's has-diff gate passes it on purpose (a task that correctly
  // concluded there was nothing to do, or whose work already landed upstream;
  // see the 2026-05-29 main-committer incident documented in
  // `core/lib/git/verify.ts`). The clean-tree assertion has no such exemption
  // and applies to every path.
  if (postState?.kind === 'dirty-no-commits' || postState?.kind === 'dirty-with-commits') {
    const dirtyList = postState.dirtyFiles.join('\n  ')
    const committedNote =
      postState.kind === 'dirty-with-commits'
        ? `${postState.commitsAhead} commit(s) ahead of ${integrationBranch}`
        : `0 commits ahead of ${integrationBranch}`
    console.log(
      `[post-coder] task ${taskId}: dirty tree with ${committedNote} — coder left ${postState.dirtyFiles.length} uncommitted path(s):\n  ${dirtyList}`,
    )

    // A clean process exit with a dirty worktree is a recoverable instruction
    // adherence failure, not a reason to immediately take authorship of the
    // change. Give the same Coder one short, worktree-backed correction turn
    // first. Codex exec is ephemeral, so this deliberately starts a second
    // process; the worktree is the continuation state.
    const alreadyCommittedLine =
      postState.kind === 'dirty-with-commits'
        ? `You already made ${postState.commitsAhead} commit(s) on this branch, but these paths were left out.\n\n`
        : ''
    const correction = await runWorkerWithSpan({
      worker,
      prompt: `${alreadyCommittedLine}Your previous pass left uncommitted changes in these paths:\n  ${dirtyList}\n\nCommit them now. Do not make unrelated changes.`,
      runOptions: {
        cwd: worktreePath,
        systemPrompt: resolveWorkerSystemPrompt(primaryTag),
        onEvent: async (event) => emit?.(event),
        onPid: ctx.services.onPid,
        externalAbort: ctx.signal,
      },
      traceStore: spanStore(trace),
      stepName: 'commit-correction',
      workflowInstanceId: trace.workflowInstanceId,
      originId,
      taskId,
      phase: 'code',
    })

    if (ctx.signal.aborted) throw new Error(`task ${taskId} stopped by operator`)

    try {
      const correctedState = await detectPostCoderState({
        worktreePath,
        integrationBranch,
        traceCtx: buildPhaseCtx(trace, taskId, 'code'),
      })
      if (correctedState.kind === 'clean-with-commits') {
        postState = correctedState
        commitSource = 'corrected'
        console.log(
          `[post-coder] task ${taskId}: coder committed ${correctedState.commitsAhead} change(s) on corrective turn`,
        )
      } else if (correctedState.kind === 'error') {
        console.warn(`[post-coder] task ${taskId}: corrective classifier error: ${correctedState.error}`)
      } else {
        postState = correctedState
        console.warn(
          `[post-coder] task ${taskId}: corrective commit turn exited ${correction.exitCode} without a commit; using the auto-commit net`,
        )
      }
    } catch (err) {
      console.warn(`[post-coder] task ${taskId}: corrective classifier threw; using the auto-commit net:`, err)
    }
  }

  // Stage 2 — the deterministic net. Runs for both dirty shapes, so a coder
  // that committed once and left the rest dirty is no longer terminal.
  if (postState?.kind === 'dirty-no-commits' || postState?.kind === 'dirty-with-commits') {
    const dirtyList = postState.dirtyFiles.join('\n  ')
    const commitsAhead =
      postState.kind === 'dirty-with-commits' ? postState.commitsAhead : 0
    const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
      '../../core/lib/main-dirty'
    )
    const provenance =
      parseMainCommiterPayload(fullTask?.recoveryPayload ?? null)?.recipe === MAIN_COMMITER_RECIPE
        ? 'committer-salvage'
        : 'coder-left-dirty'
    const autoResult = await autoCommitWorktreeIfDeterministic({
      taskId,
      provenance,
      integrationBranch,
      worktreePath,
      dirtyFiles: postState.dirtyFiles,
      traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    })

    if (autoResult.committed) {
      commitSource = 'net'
      console.log(
        `[post-coder] task ${taskId}: auto-committed ${postState.dirtyFiles.length} path(s) as ${autoResult.sha.slice(0, 8)} (on top of ${commitsAhead} coder commit(s))`,
      )
    } else {
      // Genuinely terminal: the guard refused an unsafe path, or git rejected
      // the commit. Either way nothing landed and nothing can land without an
      // operator, so this keeps failing — with the ONE registered signature.
      const errorMsg = coderUncommittedFailure({
        taskId,
        worktreePath,
        branch,
        integrationBranch,
        dirtyFiles: postState.dirtyFiles,
        commitsAhead,
        autoCommitReason: autoResult.reason,
      })
      console.log(
        `[post-coder] task ${taskId}: auto-commit refused (${autoResult.refusal}) — ${autoResult.reason}`,
      )
      await updateTask(
        taskId,
        {
          status: 'failed',
          error: errorMsg,
          failedPhase: 'code',
          // `failure_reason` doubles as the fine-grained failing step for the
          // durable recovery-spawn subscriber (`asStepId(task.failureReason)`),
          // which recomputes the signature from it. It must stay the bare step
          // id that, combined with the "has uncommitted changes" phrase in
          // `error`, recomputes to CODER_UNCOMMITTED_SIGNATURE — the prose
          // lives in `error`.
          failureReason: CODER_UNCOMMITTED_STEP,
          failureReasonCode: 'orchestration:coder-left-uncommitted-unfixable',
          // Stamp the structured signature so the action queue can name this
          // failure (failure-kinds.ts) and self-heal can find its recipe
          // (fix-recipes.ts `code/uncommitted-changes`). Without it the row
          // resolves to the generic "A pipeline step did not complete".
          failureSignature: CODER_UNCOMMITTED_SIGNATURE,
        },
        store,
      )
      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Auto-commit failed for task ${taskId}: coder left uncommitted work`,
        body: [
          `Task ${taskId} coder exited cleanly but left ${postState.dirtyFiles.length} uncommitted path(s) (${commitsAhead} commit(s) ahead of ${integrationBranch}).`,
          'A corrective coder turn ran first and did not commit them.',
          `Deterministic auto-commit was then attempted and refused (${autoResult.refusal}): ${autoResult.reason}`,
          '',
          'Dirty files:',
          `  ${dirtyList}`,
          '',
          `Worktree: ${worktreePath}`,
          '',
          'Resolve: inspect the worktree, commit manually if the work is viable, or `mars purge` the task.',
        ].join('\n'),
        payload: {
          taskId,
          worktreePath,
          dirtyFiles: postState.dirtyFiles,
          commitsAhead,
          autoCommitRefusal: autoResult.refusal,
          autoCommitReason: autoResult.reason,
        },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'workflow:code:auto-commit-failed',
        signature: `coder-uncommitted:${taskId}`,
      }).catch((raiseErr) => {
        console.error(
          `[post-coder] task ${taskId}: action-queue raise for auto-commit failure errored:`,
          raiseErr,
        )
      })
      throw new WorkflowTerminalError('coder-uncommitted', CODER_UNCOMMITTED_ABORT_MESSAGE(taskId))
    }
  }

  // Emitted only for runs that survive every post-coder gate above, matching
  // the existing terminal-failure branches (auto-commit-failed, commit
  // contract), which throw before reaching this point.
  await trace.traceStore
    .record({
      kind: 'post-coder-commit',
      taskId,
      originId,
      phase: 'code',
      payload: {
        provider: worker.config.provider,
        commitSource,
        // Occupancy for a per-request provider, cumulative spend for a
        // cumulative one, and NEITHER field for a provider that reports no
        // usage — a hardcoded `contextTokens` read the assistant shape on
        // every provider and stamped a fabricated 0 on every Codex run.
        ...buildContextTokenSignals(coderSemantics, r.conversation),
      },
    })
    .catch(() => {
      // Telemetry must never change the completion result.
    })

  const usage = summarizeUsageForSemantics(coderSemantics, r.conversation)
  if (r.sessionId) {
    handle?.setTranscriptKey(r.sessionId)
    await updateTask(taskId, { claudeSessionId: r.sessionId }, store)
  }
  await recordSignals(taskId, 'run-claude-code', usage, store).catch(() => {
    // signal capture must never fail the task
  })

  return { sessionId: r.sessionId ?? null }
}

// ---------------------------------------------------------------------------
// review (formerly verify)
// ---------------------------------------------------------------------------

/** Per-call domain options for {@link review}. All fields default. */
export interface ReviewOpts {
  /** Pipeline kind. Default `'task'`. `'diagnose'` short-circuits. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** Serialised recovery payload; only on `kind:'fix'`. Default null. */
  recoveryPayload?: string | null
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /** Override the worktree (defaults to the one stashed by setupWorktree). */
  worktree?: WorktreeRef
  /**
   * Review type — WHO executes this step (workflow-declared).
   *   - `'auto'` (default) runs scope-aware typecheck/tests/lint.
   *   - `'manual'` boots the stack and parks for human QA.
   *   - `'full-review'` spawns a review agent that produces a ReviewPacket
   *     with findings across correctness/security/style/test-coverage.
   */
  reviewType?: 'auto' | 'manual' | 'full-review'
  /** Step guide for a `'manual'` step. Reserved for future use. */
  guide?: string
}

export interface ReviewResult {
  verified: true
}

/**
 * Full-workspace review of the worktree's committed changes. Formerly named
 * `verify`. Two review types:
 *
 *   - `reviewType:'auto'` (default) — runs every configured typecheck/test/lint gate:
 *     - `kind:'diagnose'` short-circuits (no artefact to verify),
 *     - non-fix tasks run the verify-time dirty-main check and, if the
 *       integration branch is dirty, park behind a `main-commiter` recovery and
 *       throw the `verify:main-dirty` sentinel,
 *     - selects root gates plus path-covered scoped gates from the task's actual diff
 *       (a main-commiter recovery skips all test/typecheck/lint steps),
 *     - runs `verifyChanges` (the has-diff / commits-ahead gate always runs),
 *     - on failure stamps the task, spawns the recovery fix-task through `store`,
 *       and throws.
 *   - `reviewType:'manual'` — boots the stack and parks for human QA via `awaitHuman`.
 *
 * Returns `{ verified: true }` on success. The throw model means reaching the
 * caller's merge step always implies review passed.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * await ctx.step('review', () => review(ctx, { reviewType: 'auto' }))
 * ```
 */
export const review = async (
  ctx: MarsCtx,
  opts: ReviewOpts = {},
): Promise<ReviewResult> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'review',
      mode: opts.reviewType ?? 'auto',
      guide: opts.guide ?? null,
    })
    return { verified: true }
  }

  // Full-review type: spawn a review agent and produce a ReviewPacket.
  if (opts.reviewType === 'full-review') {
    const frTaskId = resolveTaskId(ctx, opts.taskId)
    const frStore: TaskStore = ctx.services.store
    const frWorktree = await resolveWorktree(ctx, frTaskId, frStore, opts.worktree)
    const frBranch = frWorktree.branch
    const frIntegrationBranch =
      opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'

    const reviewPrompt = [
      `You are a code reviewer. Review the changes on branch "${frBranch}" against "${frIntegrationBranch}".`,
      `Run: git diff ${frIntegrationBranch}...${frBranch} --stat`,
      `Then: git diff ${frIntegrationBranch}...${frBranch}`,
      '',
      'Produce a JSON object (and nothing else) matching this schema:',
      '{ "type": "full-review", "findings": [{ "category": "correctness"|"security"|"style"|"test-coverage", "severity": "info"|"warn"|"error", "message": "<description>", "file": "<path>", "line": <number> }], "generatedAt": "<ISO timestamp>" }',
      '',
      'Review for correctness bugs, security issues, style violations, and missing test coverage.',
      'Output ONLY the JSON object.',
    ].join('\n')

    const worker = Workers.Coder
    const sessionKey = buildSessionKey(frTaskId)
    const trace = await resolveTrace(ctx, frTaskId)

    const r = await runWorkerWithSpan({
      worker,
      prompt: reviewPrompt,
      runOptions: {
        cwd: frWorktree.path,
        sessionId: sessionKey,
        onEvent: async () => {},
        onPid: ctx.services.onPid,
      },
      traceStore: spanStore(trace),
      stepName: 'full-review',
      workflowInstanceId: trace.workflowInstanceId,
      originId: trace.originId,
      taskId: frTaskId,
      phase: 'verify',
    })

    const rawOutput =
      extractLastStreamText(r.conversation) ??
      readWorkerOutputText(worker.config.provider, r.stdout) ??
      ''
    let packet: ReviewPacket
    try {
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/)
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawOutput)
      packet = ReviewPacketSchema.parse(parsed)
    } catch {
      packet = {
        type: 'full-review',
        findings: [{
          category: 'correctness',
          severity: 'warn',
          message: 'Review agent output could not be parsed into a ReviewPacket.',
        }],
        generatedAt: new Date().toISOString(),
      }
    }

    await frStore.setReviewPacket(frTaskId, packet)
    return { verified: true }
  }

  // Manual review type: boot the stack and park for human QA.
  if (opts.reviewType === 'manual') {
    const manualTaskId = resolveTaskId(ctx, opts.taskId)
    const manualStore: TaskStore = ctx.services.store
    const manualWorktree = await resolveWorktree(ctx, manualTaskId, manualStore, opts.worktree)
    const cwd = manualWorktree.path

    // ── Remote deployment gate ─────────────────────────────────────────────
    // When .mars/deploy.config.json exists in stateDir, delegate QA hosting
    // to the configured provider.  The task parks in awaiting-validation in
    // both the success and failure paths — it must never fall through and
    // silently merge.
    const _stateDir = getStateDir()
    let _deployConfig: Awaited<ReturnType<typeof loadDeployConfig>> | null = null
    try {
      _deployConfig = await loadDeployConfig(_stateDir)
    } catch (err) {
      if (!(err instanceof DeployConfigError)) throw err
      // No deploy.config.json — fall through to local dev server.
    }

    if (_deployConfig !== null) {
      const provider = getProvider(_deployConfig.provider)
      if (!provider) {
        throw new Error(
          `preview-gate: deployment provider '${_deployConfig.provider}' is not registered`,
        )
      }
      const worktreeBranch = manualWorktree.branch

      let deployResult: DeployResult | null = null
      let deployErrMsg: string | null = null
      try {
        deployResult = await provider.deploy({
          taskId: manualTaskId,
          worktreePath: cwd,
          branch: worktreeBranch,
          env: _deployConfig.env,
        })
      } catch (err) {
        deployErrMsg = err instanceof Error ? err.message : String(err)
      }

      if (deployResult !== null) {
        // Success: write a ready deployment row and park for human validation.
        await manualStore.writeDeployment({
          taskId: manualTaskId,
          provider: _deployConfig.provider,
          deploymentId: deployResult.deploymentId,
          url: deployResult.url,
          status: 'ready',
        })
        await manualStore.updateTask(manualTaskId, {
          status: 'awaiting-validation',
          devServerUrl: deployResult.url,
          devServerPid: null,
        })
        raiseActionQueueItem({
          kind: 'awaiting-validation',
          category: 'task',
          priority: 'normal',
          title: `Validate ${manualTaskId}`,
          body: `Remote deployment ready${deployResult.url ? `: ${deployResult.url}` : ''}.`,
          payload: {
            taskId: manualTaskId,
            devServerUrl: deployResult.url,
            remoteUrl: deployResult.url,
            branch: worktreeBranch,
          },
          context: { taskId: manualTaskId },
          raisedBy: 'primitive:preview-gate',
          signature: manualTaskId,
          originTaskId: manualTaskId,
        }).catch((err) => {
          console.error(`[preview-gate] task ${manualTaskId} action-queue raise errored:`, err)
        })
      } else {
        // Failure: persist the error and notify the operator.
        const errMsg = deployErrMsg ?? 'deploy returned no result'
        const deploymentId = `deploy-fail-${manualTaskId}`
        const row = await manualStore.writeDeployment({
          taskId: manualTaskId,
          provider: _deployConfig.provider,
          deploymentId,
          url: null,
          status: 'failed',
        })
        await manualStore.updateDeploymentStatus(row.deploymentId, {
          status: 'failed',
          error: errMsg,
        })
        raiseActionQueueItem({
          kind: 'awaiting-validation',
          category: 'task',
          priority: 'normal',
          title: `Validate ${manualTaskId}: remote deploy failed`,
          body: errMsg,
          payload: { remoteUrl: null, branch: worktreeBranch },
          context: { taskId: manualTaskId },
          raisedBy: 'primitive:preview-gate',
          signature: `${manualTaskId}:deploy-failed`,
          originTaskId: manualTaskId,
        }).catch((err) => {
          console.error(`[preview-gate] task ${manualTaskId} action-queue raise errored:`, err)
        })
      }

      // In both cases, park the task — never fall through to local dev server.
      throw new WorkflowTerminalError(
        'preview-gate',
        deployErrMsg !== null
          ? `remote deploy failed for ${manualTaskId}: ${deployErrMsg}`
          : `remote deployment ready for ${manualTaskId}, awaiting validation`,
        { stepName: ctx.currentStep?.name ?? 'preview-gate' },
      )
    }
    // ── End remote deployment gate ──────────────────────────────────────────

    // Resolve boot command: task-spec previewCmd → package.json scripts.dev → error.
    let cmd: string | null = input(ctx).spec?.previewCmd ?? null
    if (!cmd) {
      try {
        const pkgRaw = await readFile(join(cwd, 'package.json'), 'utf8')
        const pkg = JSON.parse(pkgRaw) as Record<string, unknown>
        const scripts = pkg.scripts
        if (
          scripts !== null &&
          typeof scripts === 'object' &&
          'dev' in scripts &&
          typeof (scripts as Record<string, unknown>).dev === 'string'
        ) {
          cmd = (scripts as Record<string, string>).dev
        }
      } catch {
        // no package.json or parse error — fall through to the error below
      }
    }
    if (!cmd) {
      throw new Error(
        `manual review: no preview command found for task ${manualTaskId}. ` +
          `Set \`previewCmd\` on the task spec or add a "dev" script to ` +
          `package.json in the worktree (${cwd}).`,
      )
    }

    // Spawn the preview via the daemon-injected previewSpawn service.
    const { previewSpawn } = ctx.services
    if (!previewSpawn) {
      throw new Error(
        `manual review: previewSpawn service not available for task ${manualTaskId}. ` +
          `The daemon must inject MarsServices.previewSpawn.`,
      )
    }
    const { logPath, url: previewUrl } = await previewSpawn({
      taskId: manualTaskId,
      cmd,
      cwd,
    })

    // Park via awaitHuman with the preview info embedded in the payload.
    const guide = [
      `Test the app and run \`mars step done ${manualTaskId}\` to pass or ` +
        `\`mars release --abort ${manualTaskId} --note '<qa note>'\` to fail.`,
      previewUrl ? `Preview URL: ${previewUrl}` : null,
      `Logs: ${logPath}`,
    ]
      .filter(Boolean)
      .join('\n')

    await awaitHuman(ctx, {
      note: guide,
      taskId: manualTaskId,
      previewUrl: previewUrl ?? null,
      logPath,
    })
    // awaitHuman always throws WorkflowTerminalError; this return is unreachable
    // but satisfies the Promise<ReviewResult> return type.
    return { verified: true }
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const recoveryPayload =
    opts.recoveryPayload ?? input(ctx).recoveryPayload ?? null
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)

  const worktreePath = worktree.path
  const branch = worktree.branch

  if (kind === 'diagnose') {
    return { verified: true }
  }

  let capturedVerifyOutput: string | undefined
  return await runNonLlmStepWithSpan({
    stepName: 'verify',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId: taskId,
    phase: 'verify',
    traceStore: spanStore(trace),
    getCommandOutput: () => capturedVerifyOutput,
    fn: async (): Promise<ReviewResult> => {
      // ── Worktree preflight: verify is a RESUME ENTRY POINT ────────────────
      // On a checkpoint-resume both `setup` and `code` short-circuit (their
      // records are 'completed'), so verify is the first step that actually
      // executes — and NOTHING before it revalidates the worktree. `runAgent`
      // has `restoreWorktreeIfMissing` for exactly this, but it lives inside
      // the `code` step, which is precisely the step that gets skipped.
      //
      // Observed live on mars-a13334fd (and 3 others): its recovery merged and
      // cleaned up the shared worktree + branch, after which every re-dispatch
      // skipped setup and code, ran verify against a deleted directory, and
      // failed. Because `verifyChanges` reports a hygiene throw under the step
      // name `has-diff`, this surfaced as `verify:has-diff failed` — on a diff
      // that was never examined — and the task re-queued forever (attempts
      // 4 → 10 in under a minute).
      //
      // Re-attach from the branch when the committed work still exists; when
      // the branch is gone too there is genuinely nothing to verify, so fail
      // ONCE with a named, orchestration-classified signature instead of
      // looping on a misleading one.
      try {
        const restored = await restoreWorktreeIfMissing({
          taskId,
          ref: { path: worktreePath, branch },
          traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
        })
        if (restored === 'rebuilt') {
          console.log(
            `[verify] task ${taskId}: worktree ${worktreePath} was missing on resume; ` +
              `re-attached from branch ${branch}`,
          )
        }
      } catch (err) {
        if (!(err instanceof ResumeWorktreeUnrecoverable)) throw err
        const summary = err.message
        const signature = computeFailureSignature('verify:worktree-missing', summary)
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: summary,
            failedPhase: 'verify',
            failureReason: 'verify:worktree-missing',
            failureSignature: signature,
            failureReasonCode: signature,
          },
          store,
        )
        throw new WorkflowTerminalError('resume-worktree-missing', summary)
      }

      // Verify-time dirty-main check (non-fix only).
      if (kind !== 'fix') {
        try {
          const {
            checkIntegrationBranchDirty,
            MAIN_COMMITER_RECIPE,
            spawnOrAttachMainCommitter,
          } = await import('../../core/lib/main-dirty')
          const { loadRecipeCatalog } = await import('../../core/lib/recipes')
          const verifyTopCtx = resolveContext()
          const detection = await checkIntegrationBranchDirty({
            repoRoot: verifyTopCtx.repoRoot,
            integrationBranch,
            traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
          })
          if (detection.dirty) {
            const catalog = await loadRecipeCatalog(verifyTopCtx.stateDir)
            const recipe = catalog.get(MAIN_COMMITER_RECIPE)
            if (recipe) {
              const resolution = await spawnOrAttachMainCommitter({
                sourceTaskId: taskId,
                detection,
                integrationBranch,
                dispatchPhase: 'verify',
                recipePrompt: recipe.prompt,
                sourceOriginId: trace.originId,
                traceStore: trace.traceStore,
                store,
              })
              console.log(
                `[main-dirty] verify-time: task ${taskId} parked blocked on main-commiter ${resolution.fixTaskId} (${
                  resolution.spawned
                    ? resolution.reapedZombieCommitterId
                      ? `spawned fresh, replacing zombie committer ${resolution.reapedZombieCommitterId}`
                      : 'spawned fresh'
                    : `attached to live committer in status=${resolution.attachedToStatus}`
                })`,
              )
              throw new WorkflowTerminalError(
                'main-dirty-verify',
                `task ${taskId} verify:main-dirty: ${MAIN_DIRTY_VERIFY_MESSAGE}`,
              )
            } else {
              console.log(
                `[main-dirty] verify-time: integration branch is dirty but recipe '${MAIN_COMMITER_RECIPE}' is missing from the catalog; falling through to standard verify`,
              )
            }
          }
        } catch (err) {
          if (err instanceof WorkflowTerminalError && err.kind === 'main-dirty-verify') {
            throw err
          }
          console.warn(
            `[main-dirty] verify-time check threw, continuing with verify: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }

      // Branch-contamination guard (best-effort, non-fatal on git errors):
      // A task branch that was repointed onto the integration main line from
      // outside the normal workflow (e.g. by a concurrent restart/recovery
      // race rewriting the branch ref) would otherwise cause verify to run
      // against mismatched code and produce misleading errors like "Conflicting
      // declarations" when multiple tasks' commits are combined on one branch.
      // Catch it early with a clear `verify:branch-contaminated` signal.
      //
      // Three shapes are distinguished:
      //   1. Zero commits ahead (`integrationBranch..HEAD` == 0): the agent
      //      legitimately produced no commits, or its commits were already
      //      fast-forwarded into integration via another path. Both sub-shapes
      //      are benign — fall through to verifyChanges, which accepts them as
      //      "no-op accepted" or "work already merged" (checkBranchHasDiff).
      //   2. Positive commits AND HEAD is an ancestor of integrationBranch:
      //      the branch was externally repointed onto the integration timeline
      //      (parallel recovery/restart race). Hard-fail.
      //
      // Not applied to fix tasks (they run on the origin's branch, which is
      // expected to start on the integration timeline and then add commits).
      if (kind !== 'fix') {
        try {
          // Count task-specific commits first. A zero-ahead count means there
          // is no un-integrated work — verifyChanges handles both the
          // "no-op" and "already merged" sub-shapes correctly. Only when the
          // branch has commits that are NOT yet on integration can --is-ancestor
          // returning 0 indicate a genuine external repoint.
          const countResult = await runTool(
            {
              tool: 'git',
              argv: ['rev-list', '--count', `${integrationBranch}..HEAD`],
              cwd: worktreePath,
              expectsFailure: true,
              taskId,
              originId: trace.originId,
              phase: 'verify',
            },
            trace.traceStore,
          )
          const aheadCount = Number.parseInt(countResult.stdout.trim(), 10)
          if (Number.isInteger(aheadCount) && aheadCount > 0) {
            // Task produced commits not yet on integration; check if HEAD was
            // externally repointed onto the integration timeline.
            const ancestorResult = await runTool(
              {
                tool: 'git',
                argv: ['merge-base', '--is-ancestor', 'HEAD', integrationBranch],
                cwd: worktreePath,
                expectsFailure: true,
                taskId,
                originId: trace.originId,
                phase: 'verify',
              },
              trace.traceStore,
            )
            if (ancestorResult.exitCode === 0) {
              // HEAD is on the integration timeline — branch was contaminated.
              const headShortResult = await runTool(
                {
                  tool: 'git',
                  argv: ['rev-parse', '--short', 'HEAD'],
                  cwd: worktreePath,
                  expectsFailure: true,
                  taskId,
                  originId: trace.originId,
                  phase: 'verify',
                },
                trace.traceStore,
              )
              const headShort = headShortResult.stdout.trim() || 'unknown'
              const contamMsg = `branch HEAD ${headShort} is already an ancestor of ${integrationBranch} — task branch was repointed onto the integration timeline (parallel recovery/restart race)`
              const contamSignature = computeFailureSignature(
                'verify:branch-contaminated',
                contamMsg,
              )
              await updateTask(
                taskId,
                {
                  status: 'failed',
                  error: contamMsg,
                  failedPhase: 'verify',
                  failureReason: 'verify:branch-contaminated',
                  failureSignature: contamSignature,
                  failureReasonCode: contamSignature,
                },
                store,
              )
              throw new Error(
                `task ${taskId} verify:branch-contaminated: ${contamMsg}`,
              )
            }
          }
          // aheadCount == 0 (or unparseable): fall through to verifyChanges.
        } catch (guardErr) {
          // Re-throw contamination sentinel so it stops the pipeline.
          if (
            guardErr instanceof Error &&
            guardErr.message.includes('verify:branch-contaminated')
          ) {
            throw guardErr
          }
          // Other git failures (e.g. timeout, git not found) are non-fatal;
          // fall through to the standard verify steps.
          console.warn(
            `[verify] task ${taskId} branch-contamination guard threw, continuing:`,
            guardErr instanceof Error ? guardErr.message : guardErr,
          )
        }
      }

      await updateTask(
        taskId,
        { status: 'verifying', failedPhase: null, activityDetail: 'verify' },
        store,
      )

      // Acquire the daemon-level verify semaphore (MARS_MAX_VERIFY) before
      // running the CPU-intensive test suite. This releases the implement slot
      // first (see dispatchImplement) so other tasks can keep coding while this
      // one waits for a free verify slot. When absent (scaffolded workflows,
      // test contexts without the daemon plumbing), verify runs uncapped.
      await ctx.services.acquireVerifySlot?.()

      // Wrap the verify body: any unexpected throw (e.g. verifyChanges rejects,
      // lock acquisition fails) must transition the task to 'failed' before
      // rethrowing, so the row never stays pinned in 'verifying' until the
      // phantom-task watchdog ceiling (mars-42b5bfec).
      let _verifyFailedRecorded = false
      try {
      // Verify step dirs are repo-root-relative supervisor scopes (for example
      // `ui` or `orchestrator`). Anchor them at the worktree root so each
      // scoped command runs in `<worktree>/<scope>`, not beneath whichever
      // subproject happens to be selected by the legacy repro heuristic.
      const verifyCwd = worktreePath
      const verifyCtx = resolveContext()
      const { loadVerifyGates } = await import('../../core/verify-gates')
      const recipeScopes = await loadVerifyGates(store)
      // Gate-enrichment merge (PRD 745f33e0): human-approved shadow/enforcing
      // checks from the signature-keyed registry are appended BEHIND
      // loadVerifyGates and flow through the same changed-path selection below
      // — no recipe schema change,
      // and the seam survives the manifest.json→verify.json migration.
      // `appendEnrichmentScopes` never throws (registry failure → recipe
      // scopes untouched).
      const scopes = await appendEnrichmentScopes(store, recipeScopes)
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE, checkIntegrationBranchDirty } = await import(
        '../../core/lib/main-dirty'
      )
      const commiterPayload =
        recoveryPayload != null
          ? parseMainCommiterPayload(recoveryPayload)
          : null
      const isMainCommitter = commiterPayload?.recipe === MAIN_COMMITER_RECIPE
      const changedFiles = await getChangedFiles(
        worktreePath,
        integrationBranch,
        branch,
        buildPhaseCtx(trace, taskId, 'verify'),
      )
      const steps = isMainCommitter ? [] : selectVerifySteps(scopes, changedFiles)

      let r = await verifyChanges({
        cwd: verifyCwd,
        steps,
        branch,
        integrationBranch,
        changedFiles: isMainCommitter ? [] : changedFiles,
        traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
      })

      // Infra-failure retry (once only): if any failed step output matches an
      // infrastructure-failure pattern (embedded-PG shutdown mid-suite, Spring
      // context init error), retry the full suite once before counting the
      // failures as real regressions.  Genuine assertion failures still surface
      // because the retry runs on a clean, serially-acquired DB — the retry
      // just removes phantom failures caused by concurrent infra contention.
      if (!r.passed) {
        const failedSteps = r.steps.filter((s) => !s.passed)
        if (failedSteps.some((s) => isInfraFailureOutput(s.output))) {
          console.log(
            `[verify] task ${taskId}: infra failure detected in ${failedSteps.length} step(s) ` +
              `(embedded-PG shutdown or Spring context init); retrying once`,
          )
          r = await verifyChanges({
            cwd: verifyCwd,
            steps,
            branch,
            integrationBranch,
            changedFiles: isMainCommitter ? [] : changedFiles,
            traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
          })
        }
      }

      // Shadow burn-in accounting for enriched checks (PRD 745f33e0): each
      // enrich:<signature> step that ran in shadow status records one clean
      // parse against its per-check gate_burn_in row; the parse that crosses
      // SHADOW_BURN_IN_COUNT auto-promotes the record shadow → enforcing.
      // Best-effort — never breaks the verify path.
      await recordEnrichmentShadowRuns(store, r.steps).catch(() => {})

      // Main-committer invariant: the integration checkout must be clean after
      // the committer ran. A committer task may only succeed if
      // `git status --porcelain` on the integration branch's primary checkout
      // (repoRoot, not the committer worktree) is empty. If the checkout is
      // still dirty — e.g. because ignored files remain (a checkpoint never
      // captures those), or the committer exited without committing anything
      // meaningful — the
      // verify step must fail so the task escalates to the action queue for
      // operator review (non-recoverable per ADR-0040).
      //
      // Only fires when `verifyChanges` already passed: no point stacking a
      // second failure message on top of an already-failed verify run.
      if (r.passed && commiterPayload?.recipe === MAIN_COMMITER_RECIPE) {
        const postClean = await checkIntegrationBranchDirty({
          repoRoot: verifyCtx.repoRoot,
          integrationBranch,
          traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
        })
        if (postClean.dirty) {
          // Orchestration failure: the committer ran and passed its own verify
          // steps but left the integration branch dirty. This is NOT a code
          // defect — no fix task must be spawned. Stamp the task failed with an
          // orchestration code, raise a dedicated action-queue alert, and throw
          // a terminal error so the pipeline aborts. The _verifyFailedRecorded
          // flag prevents the outer catch from double-stamping.
          const { handleCommitterStillDirty } = await import(
            '../../core/daemon/main-dirty-action-queue'
          )
          const contaminatedPaths = postClean.statusOutput
            .split('\n')
            .map((l) => l.slice(3).trim())
            .filter(Boolean)
          await handleCommitterStillDirty(taskId, integrationBranch, contaminatedPaths, store)
          _verifyFailedRecorded = true
          throw new WorkflowTerminalError(
            'committer-still-dirty',
            `task ${taskId} orchestration:main-committer-still-dirty: integration branch ${integrationBranch} still dirty after committer ran`,
          )
        }
      }

      // Enrich each step header with tier and duration for the run-timeline view.
      const verifyOutput = r.steps
        .map((s) => {
          const tierBadge =
            s.tier === 'integration'
              ? ' [integration:deferred]'
              : s.tier === 'task'
                ? ' [task]'
                : ''
          const durationBadge =
            s.duration !== undefined ? ` ${s.duration}ms` : ''
          return `=== ${s.name} (${s.passed ? 'pass' : 'fail'})${tierBadge}${durationBadge} ===\n${s.output}`
        })
        .join('\n\n')
      // Append a structured gate-outcomes block so the run-timeline view can
      // surface per-gate metrics (name, tier, passed, duration) without parsing
      // free-form step output.
      // Note: `has-diff` is included in r.steps when it passes (it is a real
      // gate that ran). A non-empty gateOutcomes means at least one gate ran;
      // a no-coverage task now contributes the explicit
      // `cant-verify:no-gate-coverage` outcome rather than a silent empty list.
      const gateOutcomes = r.steps.map((s) => ({
        name: s.name,
        tier: s.tier ?? 'task',
        passed: s.passed,
        ...(s.duration !== undefined ? { duration: s.duration } : {}),
      }))
      const gateOutcomesBlock =
        gateOutcomes.length === 0
          ? '(no gates ran)\n[]'
          : JSON.stringify(gateOutcomes, null, 2)
      capturedVerifyOutput =
        verifyOutput +
        '\n\n=== gate outcomes ===\n' +
        gateOutcomesBlock

      // Registry-backed task gates are observed before ordinary failure
      // handling. A systemic threshold crossing quarantines only that gate,
      // turning its result into a passing CAN'T-VERIFY diagnostic; any other
      // active gate failure remains a normal task failure.
      if (!r.passed) {
        for (const step of r.steps) {
          if (step.passed || step.tier !== 'task' || step.gateId === undefined) continue
          const failureSignature = computeFailureSignature(
            `verify:${step.name}`,
            step.output,
          )
          try {
            const quarantined = await store.atomic(async (tx) => {
              const observed = await observeVerifyGateFailure(tx, {
                gateId: step.gateId!,
                originId: trace.originId,
                failureSignature,
                failedAt: Date.now(),
              })
              if (!observed.thresholdCrossed) return false
              const transitioned = await quarantineVerifyGate(
                tx,
                step.gateId!,
                failureSignature,
                trace.originId,
              )
              if (transitioned) {
                await tx.execute(
                  buildEventInsert('verify-gate.quarantined', {
                    gateId: step.gateId!,
                    originId: trace.originId,
                    failureSignature,
                    failureEvidence: step.output,
                  }),
                )
              }
              return transitioned
            })
            if (quarantined) {
              step.passed = true
              step.output = `CAN'T-VERIFY: registry gate ${step.name} was quarantined after systemic failures\n${step.output}`
            }
          } catch (error) {
            console.error(
              `[verify] task ${taskId}: could not observe registry gate ${step.gateId}:`,
              error,
            )
          }
        }
        const stillHasRequiredFailure = r.steps.some((step) => {
          if (step.passed) return false
          if (step.gateId === undefined) return true
          return steps.find((spec) => spec.gateId === step.gateId)?.required ?? true
        })
        if (!stillHasRequiredFailure) {
          r.passed = true
          r.verdict = "CAN'T-VERIFY"
        }
      }

      if (!r.passed) {
        const failed = r.steps.filter((s) => !s.passed)
        const summary = failed
          .map((s) => `${s.name}:\n${failureExcerpt(s.output)}`)
          .join('\n\n')
        const firstFailedName = failed[0]?.name ?? 'verify'
        // Build a structured diagnostics block for each failed gate so
        // post-mortems and recovery prompts can see the actual command, cwd,
        // exit code, stdout, and stderr rather than just the merged output.
        // Synthetic steps (integration-clean, has-diff) lack cmd/stepDir —
        // fall back to the step's combined output for those.
        const gateFailureDiags = failed
          .map((s) => {
            if (s.cmd !== undefined && s.stepDir !== undefined) {
              const cmdPart = `${s.cmd}${s.args?.length ? ' ' + s.args.join(' ') : ''}`
              const stdoutPart = s.stdout ? `\nstdout:\n${failureExcerpt(s.stdout)}` : ''
              const stderrPart = s.stderr ? `\nstderr:\n${failureExcerpt(s.stderr)}` : ''
              return (
                `--- diagnostics: ${s.name} ---\n` +
                `cmd: ${cmdPart}\n` +
                `cwd: ${s.stepDir}\n` +
                `exitCode: ${s.exitCode ?? 'null'}` +
                stdoutPart +
                stderrPart
              )
            }
            return `--- diagnostics: ${s.name} ---\n${failureExcerpt(s.output)}`
          })
          .join('\n\n')
        // Re-assign capturedVerifyOutput to include the diagnostics block
        // BEFORE the gate-outcomes JSON so the run-timeline view and recovery
        // prompts both see the structured failure detail.
        capturedVerifyOutput =
          verifyOutput +
          '\n\n=== gate failure diagnostics ===\n' +
          gateFailureDiags +
          '\n\n=== gate outcomes ===\n' +
          gateOutcomesBlock
        // Build firstFailedOutput with the gate identity, exit code, and
        // stderr excerpt so the Fixer prompt shows the real failure context.
        const firstFailed = failed[0]
        // A conventional 128+N exit means the child died from signal N, not
        // that its verify command reported a defect. Keep the signal separate
        // from the gate that happened to be running: otherwise a SIGTERM while
        // typecheck runs is incorrectly recorded as `verify:typecheck`.
        const killedBy =
          firstFailed?.exitCode === 143
            ? 'sigterm'
            : firstFailed?.exitCode === 137
              ? 'sigkill'
              : null
        const failingStep = killedBy === null ? `verify:${firstFailedName}` : 'verify:killed'
        const firstFailedOutputBody = firstFailed
          ? firstFailed.cmd !== undefined
            ? failureExcerpt(
                [
                  firstFailed.name,
                  `cmd: ${firstFailed.cmd}${firstFailed.args?.length ? ' ' + firstFailed.args.join(' ') : ''}`,
                  `cwd: ${firstFailed.stepDir ?? ''}  exitCode: ${firstFailed.exitCode ?? 'null'}`,
                  ...(firstFailed.stderr
                    ? [`stderr:\n${failureExcerpt(firstFailed.stderr)}`]
                    : []),
                  ...(firstFailed.stdout
                    ? [`stdout:\n${failureExcerpt(firstFailed.stdout)}`]
                    : []),
                ].join('\n'),
              )
            : failureExcerpt(firstFailed.output)
          : summary
        // `computeFailureSignature` preserves an explicit signature at the
        // start of the output. This lets the downstream failure handler derive
        // the same infrastructure signature instead of reclassifying an empty
        // killed child as an unclassified typecheck failure.
        const firstFailedOutput =
          killedBy === null
            ? firstFailedOutputBody
            : `${failingStep}/${killedBy}\n${firstFailedOutputBody}`
        const ranVerifySteps: RanVerifyStep[] = r.steps
          .filter(
            (s): s is typeof s & { cmd: string; stepDir: string } =>
              s.cmd !== undefined && s.stepDir !== undefined,
          )
          .map((s) => ({
            name: s.name,
            cmd: s.cmd,
            args: s.args ?? [],
            stepDir: s.stepDir,
            passed: s.passed,
          }))
        const verifySignature = computeFailureSignature(
          failingStep,
          firstFailedOutput,
        )
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: summary,
            failedPhase: 'verify',
            failureReason: failingStep,
            failureSignature: verifySignature,
            failureReasonCode: verifySignature,
          },
          store,
        )
        _verifyFailedRecorded = true
        await runNonLlmStepWithSpan({
          stepName: 'recovery-dispatch',
          workflowInstanceId: trace.workflowInstanceId,
          originId: trace.originId,
          taskId: taskId,
          phase: 'verify',
          traceStore: spanStore(trace),
          fn: () =>
            handleTaskFailureWithFixTask({
              taskId,
              failingStep,
              errorOutput: firstFailedOutput,
              branch,
              ranVerifySteps,
              store,
              recipeContext: {
                targetPath: worktreePath,
                statusOutput: firstFailedOutput,
                targetBranch: branch,
                integrationBranch,
                originalPrompt: '',
              },
            }),
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${taskId} verify failure handling errored:`,
            err,
          )
        })
        throw new Error(`task ${taskId} verify:${firstFailedName} failed`)
      }

      return { verified: true }
      } catch (err) {
        // Only stamp if the deliberate !r.passed path has not already recorded
        // a failure. Best-effort write (mirrors phantom-task-watchdog pattern):
        // if the status write itself throws, swallow it so the original error
        // propagates unchanged.
        if (!_verifyFailedRecorded) {
          // Populate capturedVerifyOutput so getCommandOutput returns non-empty
          // for the step_ended trace event, and persist it on the task record
          // so structural crashes don't surface as 'none recorded'.
          capturedVerifyOutput =
            capturedVerifyOutput ??
            'verify:step-threw\n' +
              (err instanceof Error ? (err.stack ?? err.message) : String(err))
          await updateTask(
            taskId,
            {
              status: 'failed',
              failedPhase: 'verify',
              failureReason: err instanceof Error ? err.message : String(err),
              failureReasonCode: 'verify:step-threw',
              verifyOutput: capturedVerifyOutput,
            },
            store,
          ).catch(() => {})
        }
        throw err
      } finally {
        // Release the daemon-level verify semaphore slot unconditionally so the
        // next queued verify step can proceed regardless of pass/fail/throw.
        ctx.services.releaseVerifySlot?.()
      }
    },
  })
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/** Per-call domain options for {@link merge}. All fields default. */
export interface MergeOpts {
  /** Pipeline kind. Default `'task'`. `'diagnose'` removes the worktree, marks done. */
  kind?: 'task' | 'fix' | 'diagnose'
  /** Merge target. Default `'main'`. */
  integrationBranch?: string
  /** Override the task id (defaults to `ctx.runId`). */
  taskId?: string
  /** Override the worktree (defaults to the one stashed by setupWorktree). */
  worktree?: WorktreeRef
}

export interface MergeOutput {
  taskId: string
  success: boolean
  message: string
}

/**
 * Per-run budget for the integration gate. Must be well under the 300s merge
 * watchdog (DEFAULT_WATCHDOG_MS in git/merge.ts) so a hung gate command fails
 * fast and releases the merge lock in ~2 min instead of occupying it for the
 * full watchdog budget. Override via MARS_INTEGRATION_GATE_TIMEOUT_MS.
 */
const INTEGRATION_GATE_TIMEOUT_MS = Number(
  process.env.MARS_INTEGRATION_GATE_TIMEOUT_MS ?? 120_000,
)

/**
 * Fast-forward (+ Vega conflict reconciliation) of the task branch into the
 * integration branch. Mirrors the former `merge` step body:
 *
 *   - `kind:'diagnose'` removes the empty worktree and marks done (verdict-only),
 *   - pre-flight `checkMergeTargetStatus`: `needs-rebase` falls through to the
 *     rebase-before-ff; `dirty` parks the task failed with an operator
 *     action-queue item (does NOT burn the recovery budget); `error` fails it,
 *   - `mergeBranch` performs the serialized FF, escalating conflicts to Vega,
 *   - a Vega abort spawns a recovery fix-task; an unhandled crash stamps the
 *     task failed and spawns a fix-task,
 *   - on success removes the worktree and marks the task done.
 *
 * All task-state writes route through `ctx.services.store`.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * return await ctx.step('merge', () => merge(ctx, { kind }))
 * ```
 * Vega conflict-resolution events are forwarded to
 * `ctx.emit('vcs-supervisor-event', …)` internally.
 */
export const merge = async (
  ctx: MarsCtx,
  opts: MergeOpts = {},
): Promise<MergeOutput> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'merge',
      mode: 'auto',
      guide: null,
    })
    return {
      taskId: resolveTaskId(ctx, opts.taskId),
      success: true,
      message: 'validation dry-run',
    }
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)
  const emit = (event: ClaudeEvent): void =>
    ctx.emit('vcs-supervisor-event', event)

  const worktreePath = worktree.path
  const branch = worktree.branch

  if (kind === 'diagnose') {
    await removeWorktree(
      { path: worktreePath, branch },
      true,
      false,
      buildPhaseCtx(trace, taskId, 'merge'),
    )
    await updateTask(taskId, { status: 'done', failedPhase: null }, store)
    return {
      taskId,
      success: true,
      message: 'diagnose Chore complete; verdict-driven branch runs in daemon',
    }
  }

  let vegaSpanInfo: { workerName: string; sessionId: string | null } | null = null
  // Captured inside fn() so getCommandOutput can forward it to the trace even
  // when fn() throws (integration gate failure case).
  let capturedIntegrationGateOutput: string | undefined
  // Fast-forward SHAs captured by onAfterFastForward and persisted into the
  // merge step_ended payload. The Scorer runtime (PRD 6cf85bc9) reconstructs
  // the merged diff from these after the worktree is removed:
  // `git diff <mergePreSha> <mergePostSha>` — both SHAs are permanent objects,
  // so the diff stays reproducible even after the integration branch advances.
  let capturedMergeShas: { mergePreSha: string; mergePostSha: string } | null =
    null

  // Integration-gate runner: called inside the merge lock (inside mergeBranch)
  // after the fast-forward and working-tree resync, BEFORE the lock releases.
  // Serialisation is therefore inherited — at most one full suite at a time.
  // Repos whose recipe defines no integration-tier steps are a true no-op.
  const integrationGateRunner = async (info: {
    finalTaskSha: string
    finalIntegrationSha: string
  }): Promise<void> => {
    const { loadVerifyGates } = await import('../../core/verify-gates')
    const gateScopes = await loadVerifyGates(store)

    // Collect ALL integration-tier steps from ALL scopes: integration tests
    // verify the full merged tree, not just the files this task touched.
    const integrationSteps = gateScopes.flatMap((sc) =>
      sc.steps
        .filter((s) => s.tier === 'integration')
        .map((s) => ({ ...s, dir: sc.scope })),
    )

    if (integrationSteps.length === 0) {
      // No integration gates defined — zero added latency.
      return
    }

    console.log(
      `[merge:integration-gate] task ${taskId}: running ${integrationSteps.length} integration-tier gate(s) under merge lock (pre-merge: ${info.finalIntegrationSha.slice(0, 9)}, post-merge: ${info.finalTaskSha.slice(0, 9)})`,
    )

    // Bound the gate with its own timeout so a hung integration command (e.g. a
    // test suite with no global testTimeout) fails fast and releases the merge
    // lock in ~2 min instead of occupying it for the full 300s merge watchdog.
    // AbortSignal.timeout() is available on Node >= 17.3; this project requires
    // >= 22.13.0, so it is always safe to call here.
    const gateSignal = AbortSignal.timeout(INTEGRATION_GATE_TIMEOUT_MS)

    // Run gates via verifyChanges, remapping tier to 'task' so the function
    // actually executes them (verifyChanges defers integration-tier steps to
    // this boundary).
    const gateResult = await verifyChanges({
      cwd: worktreePath,
      steps: integrationSteps.map((s) => ({ ...s, tier: 'task' as const })),
      // No branch/integrationBranch — skip the has-diff gate for this run.
      traceCtx: buildPhaseCtx(trace, taskId, 'merge'),
      signal: gateSignal,
    })

    // Build the formatted output and structured gate-outcomes block, recorded
    // with tier:'integration' so the run-timeline view can distinguish them
    // from task-tier gate outcomes.
    const gateOutcomes = gateResult.steps.map((s) => ({
      name: s.name,
      tier: 'integration' as const,
      passed: s.passed,
      ...(s.duration !== undefined ? { duration: s.duration } : {}),
    }))
    const gateStepsText = gateResult.steps
      .map((s) => {
        const durationBadge = s.duration !== undefined ? ` ${s.duration}ms` : ''
        return `=== ${s.name} (${s.passed ? 'pass' : 'fail'}) [integration]${durationBadge} ===\n${s.output}`
      })
      .join('\n\n')
    const gateOutputFormatted =
      gateStepsText +
      '\n\n=== integration gate outcomes ===\n' +
      JSON.stringify(gateOutcomes, null, 2)

    // Capture for the trace regardless of outcome.
    capturedIntegrationGateOutput = gateOutputFormatted

    if (!gateResult.passed) {
      const failed = gateResult.steps.filter((s) => !s.passed)
      // If the gate timed out, name the timed-out step so the failure is
      // actionable ("step X timed out after 120000ms") rather than the opaque
      // "mergeBranch aborted (watchdog) during step 'integration-gate'".
      if (gateSignal.aborted) {
        const timedOutStep = failed[0]
        throw new Error(
          `merge:integration-gate task ${taskId}: integration gate step "${timedOutStep?.name ?? 'unknown'}" timed out after ${INTEGRATION_GATE_TIMEOUT_MS}ms\n\n${gateOutputFormatted}`,
        )
      }
      const summary = failed.map((s) => `${s.name}:\n${failureExcerpt(s.output)}`).join('\n\n')
      throw new Error(
        `merge:integration-gate task ${taskId} failed (${failed.length} gate(s)):\n${summary}\n\n${gateOutputFormatted}`,
      )
    }

    console.log(
      `[merge:integration-gate] task ${taskId}: all ${integrationSteps.length} integration-tier gate(s) passed`,
    )
  }

  return await runNonLlmStepWithSpan({
    stepName: 'merge',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId: taskId,
    phase: 'merge',
    traceStore: spanStore(trace),
    getVegaInfo: () => vegaSpanInfo,
    getCommandOutput: () => capturedIntegrationGateOutput,
    getExtraPayload: () => (capturedMergeShas !== null ? { ...capturedMergeShas } : {}),
    fn: async (): Promise<MergeOutput> => {
      try {
        await updateTask(
          taskId,
          { status: 'merging', failedPhase: null },
          store,
        )

        // Short-circuit: if the task branch has zero commits ahead of the
        // integration branch the fast-forward would be a no-op. Skip the merge
        // lock entirely — acquiring it for a no-op wastes serialisation budget
        // and can stall concurrent merges for nothing.
        const { repoRoot: mergeRepoRoot } = resolveContext()
        if (await isZeroCommitBranch(branch, mergeRepoRoot, buildPhaseCtx(trace, taskId, 'merge'))) {
          console.log(
            `[merge] task ${taskId}: branch ${branch} has zero commits ahead of ${integrationBranch} — skipping merge lock (no-op)`,
          )
          await removeWorktree(
            { path: worktreePath, branch },
            true,
            false,
            buildPhaseCtx(trace, taskId, 'merge'),
          )
          await updateTask(taskId, { status: 'done', failedPhase: null }, store)
          return { taskId, success: true, message: 'zero-commit branch — no merge needed' }
        }

        const targetStatus = await checkMergeTargetStatus({
          integrationBranch,
          taskBranch: branch,
          traceCtx: buildPhaseCtx(trace, taskId, 'merge'),
        })
        if (targetStatus.kind === 'needs-rebase') {
          console.log(
            `[merge:preflight] task ${taskId} ${targetStatus.statusOutput}; proceeding to rebase-before-ff`,
          )
        }
        if (targetStatus.kind === 'dirty') {
          const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'
          const errorMsg = `merge target ${targetStatus.targetPath} has uncommitted changes blocking fast-forward\n${targetStatus.statusOutput}`
          const dirtyPaths = targetStatus.statusOutput
            .split('\n')
            .filter((line) => /^[ MADRCU?!]{2} /.test(line))
            .map((line) => line.slice(3).trim())
            .filter(Boolean)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: DIRTY_TARGET_SIGNATURE,
              failureReasonCode: DIRTY_TARGET_SIGNATURE,
              failureSignature: DIRTY_TARGET_SIGNATURE,
            },
            store,
          )
          await raiseActionQueueItem({
            kind: 'failed',
            category: 'orchestrator',
            priority: 'high',
            title: `Merge blocked: ${integrationBranch} is dirty: ${dirtyPaths.join(', ') || 'unknown path'}`,
            body: [
              `Task \`${taskId}\` reached the merge step with committed work on branch \`${branch}\`, but the integration checkout (\`${integrationBranch}\`) has uncommitted tracked changes.`,
              '',
              `Mars stopped before any merge reset could touch those edits. The task's committed work remains intact on branch \`${branch}\`.`,
              '',
              `**To unblock:**`,
              `1. Clean \`${integrationBranch}\`: commit the uncommitted changes listed below, or restore the paths you do not want with \`git checkout <ref> -- <paths>\`. Do NOT \`git stash\` — the stash is shared by every worktree in this repo, so a later \`pop\` can hand you another task's work.`,
              `2. Run \`mars continue ${taskId}\` — this re-attempts just the merge step without re-running the coder.`,
              '',
              `Dirty paths at failure time (may be stale — re-check before acting):`,
              '```',
              targetStatus.statusOutput,
              '```',
            ].join('\n'),
            payload: {
              taskId,
              branch,
              integrationBranch,
              targetPath: targetStatus.targetPath,
              statusOutput: targetStatus.statusOutput,
              dirtyPaths,
            },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: 'merge:preflight:dirty-target',
            signature: `${taskId}:${DIRTY_TARGET_SIGNATURE}`,
            originTaskId: taskId,
            occurrence: {
              at: new Date().toISOString(),
              taskId,
              integrationBranch,
            },
          })
          throw new WorkflowTerminalError(
            'main-dirty-merge',
            `task ${taskId} merge:preflight detected dirty target ${integrationBranch}`,
          )
        }
        if (targetStatus.kind === 'error') {
          const errorMsg = `merge pre-flight git status failed: ${targetStatus.error.message}`.slice(0, 1000)
          const preflightSignature = computeFailureSignature('merge:preflight', errorMsg)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: errorMsg,
              failureSignature: preflightSignature,
              failureReasonCode: preflightSignature,
            },
            store,
          )
          throw new Error(
            `task ${taskId} merge pre-flight failed: ${targetStatus.error.message}`,
          )
        }

        const supervisorConversation: ClaudeEvent[] = []
        let m: MergeResult
        // Unconditional queue path: delegate the merge to the durable
        // single-consumer worker. Serialisation is enforced by the worker's
        // single-consumer loop and the DB `FOR UPDATE SKIP LOCKED` claim, so
        // concurrent merge primitives don't race on the file lock.
        if (!ctx.services.enqueueMergeJobAndAwait) {
          throw new Error('enqueueMergeJobAndAwait service hook is required — merge queue is always on')
        }
        const queueResult = await ctx.services.enqueueMergeJobAndAwait({
          taskId,
          branch,
          worktreePath,
          integrationBranch,
        })
        if (queueResult.status === 'failed') {
          // Let the outer crash-handler deal with this — it marks the task
          // failed and spawns a fix-task, same as a mergeBranch throw.
          throw new Error(`merge job failed (${queueResult.errorCode}): ${queueResult.error}`)
        }
        m = queueResult.result

        // Capture fast-forward SHAs from the MergeResult so the Scorer runtime
        // can reconstruct the merged diff after the worktree is removed.
        if (m.mergePreSha !== undefined && m.mergePostSha !== undefined) {
          capturedMergeShas = { mergePreSha: m.mergePreSha, mergePostSha: m.mergePostSha }
        }

        if (supervisorConversation.length > 0) {
          const supervisorUsage = summarizeUsage(supervisorConversation)
          await recordSignals(taskId, 'vcs-supervisor', supervisorUsage, store).catch(
            () => {
              // signal capture must never fail the task
            },
          )
        }

        if (m.conflictResolved) {
          vegaSpanInfo = { workerName: 'Vega', sessionId: m.vegaSessionId }
        }

        if (m.aborted) {
          const errorMsg = `merge aborted by vcs-supervisor; worktree retained at ${worktreePath}\n${m.output.slice(0, 1000)}`
          // Classify from the WRAPPED message, not the raw mergeBranch output:
          // the wrapper line is what lands in `error` and what the durable
          // recovery-spawn path re-classifies. Stamping the signature here (it
          // used to be left unset) means the abort reason — e.g. the pre-rebase
          // dirty-worktree guard's `rebase-dirty-worktree` — is on the row from
          // the first write, instead of degrading to `merge/unclassified`.
          const abortSignature = computeFailureSignature(
            'merge:vcs-supervisor-aborted',
            errorMsg,
          )
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: 'merge:vcs-supervisor-aborted',
              failureSignature: abortSignature,
              failureReasonCode: abortSignature,
            },
            store,
          )
          await handleTaskFailureWithFixTask({
            taskId,
            failingStep: 'merge:vcs-supervisor-aborted',
            errorOutput: m.output,
            branch,
            store,
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${taskId} merge abort handling errored:`,
              err,
            )
          })
          throw new Error(
            `task ${taskId} merge aborted; vcs-supervisor could not reconcile`,
          )
        }

        // Integration-tier gate failure: the fast-forward has already been
        // reverted by mergeBranch (branch is clean). Route through the standard
        // recovery path so the agent gets a fix-task seeded with the gate output.
        if (m.integrationGateFailed) {
          const gateOutput = m.integrationGateOutput ?? 'integration gates failed'
          const errorMsg = gateOutput.slice(0, 2000)
          const gateSignature = computeFailureSignature('merge:integration-gate', errorMsg)
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: 'merge:integration-gate',
              failureSignature: gateSignature,
              failureReasonCode: gateSignature,
            },
            store,
          )
          await handleTaskFailureWithFixTask({
            taskId,
            failingStep: 'merge:integration-gate',
            errorOutput: gateOutput,
            branch,
            store,
          }).catch((err) => {
            console.error(
              `[failure-handler] task ${taskId} integration-gate failure handling errored:`,
              err,
            )
          })
          throw new Error(
            `task ${taskId} merge:integration-gate failed; fast-forward reverted`,
          )
        }

        // Post-merge ancestry assertion: verify the merged SHA is actually
        // reachable from the integration branch before marking the task done.
        //
        // WHY THIS IS NEEDED. When `mergeBranch` returns `merged: true` with a
        // `mergePostSha`, the fast-forward ref update is supposed to have
        // advanced `integrationBranch` to that SHA. But silent failures can
        // produce a false positive (e.g. the remerge zero-commit short-circuit
        // fired while the branch was recreated at the integration tip, causing
        // commits on the real task branch to be forever unreferenced — observed
        // on 6 tasks on 2026-08-05). Without this check the task is marked
        // `done` and `task/<id>` is deleted, leaving the commits unreachable and
        // reclaimable by `git gc`.
        //
        // The single `merge-base --is-ancestor` probe costs ~5ms. On failure:
        // stamp the task `failed` with a named signature, do NOT remove the
        // branch (preserves the commits for investigation), throw to abort.
        if (m.mergePostSha !== undefined) {
          const tipInIntegration = await isBranchTipInIntegration(
            m.mergePostSha,
            integrationBranch,
          )
          if (!tipInIntegration) {
            const assertMsg = (
              `merge:post-merge-assertion failed: ${m.mergePostSha.slice(0, 9)} is not ` +
              `reachable from ${integrationBranch} — branch ${branch} preserved for investigation`
            )
            const assertSignature = computeFailureSignature(
              'merge:post-merge-assertion',
              assertMsg,
            )
            await updateTask(
              taskId,
              {
                status: 'failed',
                error: assertMsg,
                failedPhase: 'merge',
                failureReason: 'merge:post-merge-assertion',
                failureSignature: assertSignature,
                failureReasonCode: assertSignature,
              },
              store,
            )
            throw new Error(assertMsg)
          }
        }

        // Do NOT reclaim a worktree another live task is standing on. A
        // recovery shares its ORIGIN's directory and branch
        // (`attachToOriginWorktree`), so removing them here when the recovery
        // merged pulled the tree out from under a row that was still
        // dispatchable — the origin then re-dispatched into a deleted
        // directory (mars-a13334fd did it ten times in under a minute). Keep
        // both when anyone non-terminal still references them; the sweeper
        // (`mars worktree clean` / worktree-prune) reclaims them later, once
        // every referencing row is terminal.
        const dependents = await findLiveWorktreeDependents({
          taskId,
          worktreePath,
          branch,
          store,
        })
        if (dependents.length > 0) {
          console.log(
            `[merge] task ${taskId} merged; PRESERVING worktree ${worktreePath} and branch ${branch} — ` +
              `still referenced by ${dependents.length} non-terminal task(s): ` +
              dependents.map((d) => `${d.id}(${d.status})`).join(', '),
          )
        } else {
          await removeWorktree(
            { path: worktreePath, branch },
            true,
            false,
            buildPhaseCtx(trace, taskId, 'merge'),
          )
        }
        await updateTask(taskId, { status: 'done', failedPhase: null }, store)

        return {
          taskId,
          success: true,
          message: m.conflictResolved
            ? 'merged with vcs-supervisor conflict resolution'
            : 'merged cleanly',
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.message.includes('merge:preflight') ||
            error.message.includes('merge pre-flight failed') ||
            error.message.includes('merge aborted; vcs-supervisor could not reconcile') ||
            error.message.includes('merge:main-dirty') ||
            error.message.includes('merge:integration-gate') ||
            error.message.includes('merge:post-merge-assertion'))
        ) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[merge] task ${taskId} crashed:`, error)
        const crashMsg = `merge step crashed: ${message}`.slice(0, 1000)
        const crashSignature = computeFailureSignature('merge:crashed', crashMsg)
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: crashMsg,
            failedPhase: 'merge',
            failureReason: crashMsg,
            failureSignature: crashSignature,
            failureReasonCode: crashSignature,
          },
          store,
        )
        await handleTaskFailureWithFixTask({
          taskId,
          failingStep: 'merge:crashed',
          errorOutput: message,
          branch,
          store,
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${taskId} merge crash handling errored:`,
            err,
          )
        })
        throw error instanceof Error ? error : new Error(message)
      }
    },
  })
}

// ---------------------------------------------------------------------------
// awaitHuman
// ---------------------------------------------------------------------------

/**
 * Per-call domain options for {@link awaitHuman}. All fields default.
 */
export interface AwaitHumanOpts {
  /**
   * Human-readable note shown in the action-queue row body. Displayed to the
   * operator alongside the task id and lease holder. Default null.
   */
  note?: string | null
  /**
   * Override the task id (defaults to `ctx.runId`).
   */
  taskId?: string
  /**
   * Preview URL returned by the preview spawn for a manual-QA row. Null when
   * no preview was started. Included in the action-queue row payload.
   */
  previewUrl?: string | null
  /**
   * Log file path for the preview process for a manual-QA row. Null when no
   * preview was started. Included in the action-queue row payload.
   */
  logPath?: string | null
}

/**
 * Park the task in 'awaiting-human' and durably suspend the pipeline until
 * the operator releases the lease via `mars release <id>`.
 *
 * @deprecated **Prefer `reviewType: 'manual'` on {@link review}.**
 * `review` with `reviewType === 'manual'` uses the
 * promise-based park/resume mechanism (`onManualPark` / `resolveManualStep`)
 * registered by the daemon, which lets the workflow continue in-process after
 * `mars step done` without a re-dispatch. `awaitHuman` remains for backward
 * compatibility and as the fallback when no `onManualPark` hook is registered.
 *
 * **Behaviour:**
 *   1. Transitions the task to `'awaiting-human'` via `updateTask` (Arc
 *      funnel, ADR-0052) and raises an `'awaiting-human'` action-queue row so
 *      the operator sees it immediately.
 *   2. Throws {@link AWAIT_HUMAN_MESSAGE} — the sentinel embeds the step name
 *      so the daemon can patch the workflow_step_runs row to `'completed'`,
 *      making the park idempotent keyed on `(runId, stepName)`.
 *   3. After the daemon patches the step, no re-park or double-notify occurs
 *      on daemon restart: the engine short-circuits 'completed' steps.
 *   4. On `mars release <id>` the task re-queues and the engine re-enters the
 *      workflow past this step (already 'completed'), continuing to verify →
 *      merge.
 *
 * Lease expiry alerts are raised by the phantom-task watchdog
 * (`sweepExpiredLeases`) and never auto-fail the task (ADR-0048).
 *
 * Options precedence: `opts.field ?? ctx.input.field ?? default` (ADR-0056).
 *
 * Usage from a scaffolded workflow:
 * ```js
 * await ctx.step('await-human', () => awaitHuman(ctx, { note: 'QA your changes' }))
 * ```
 */
export const awaitHuman = async (
  ctx: MarsCtx,
  opts: AwaitHumanOpts = {},
): Promise<void> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    // A bare awaitHuman gate IS a manual step; record and return without
    // parking or throwing so the dry-run walks the rest of the pipeline.
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'awaitHuman',
      mode: 'manual',
      guide: opts.note ?? null,
    })
    return
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const note = opts.note ?? null
  // The step name is embedded in the sentinel so the daemon can complete the
  // step record and prevent double-parks on re-dispatch (idempotency).
  const stepName = ctx.currentStep?.name ?? 'await-human'
  const store: TaskStore = ctx.services.store
  const now = new Date().toISOString()

  // Auto re-lease: `mars step done` keeps the lease identity across the
  // continuation, so when the pipeline parks at the task's next manual step
  // the SAME owner gets the lease back without re-attaching — a Foreground
  // session walks a manual-heavy runbook as one continuous session. The read
  // is best-effort: if it fails, park under the workflow's own identity and
  // the operator attaches as before.
  let priorOwner: string | null = null
  try {
    priorOwner = (await getTask(taskId, store))?.leaseOwner ?? null
  } catch {
    // fall through — no re-lease
  }
  const released =
    priorOwner !== null && priorOwner !== AWAIT_HUMAN_SENTINEL
      ? priorOwner
      : null
  const leaseOwner = released ?? AWAIT_HUMAN_SENTINEL

  // Transition to 'awaiting-human' through the Arc write funnel (ADR-0052).
  // Uses the same field set as Arc.parkForHuman so the task row is consistent
  // with the server's attach/release paths. current_step_name and
  // current_step_guide are written here so the daemon's handleStepDone can
  // locate the pending promise on a promise-based park (resolveManualStep).
  await updateTask(
    taskId,
    {
      status: 'awaiting-human',
      leaseOwner,
      leasedAt: now,
      leaseNote: note,
      currentStepName: stepName,
      currentStepGuide: note,
    },
    store,
  )

  // Raise the action-queue row so the operator sees the parked task.
  // Level-triggered (ADR-0048): if the daemon restarts and re-detects, it
  // bumps seen_count rather than spawning a sibling row.
  raiseActionQueueItem({
    kind: 'awaiting-human',
    category: 'daemon',
    priority: 'normal',
    title: `Task ${taskId} parked at step '${stepName}' — awaiting human`,
    body:
      `Task ${taskId} is parked in its worktree at manual step '${stepName}'.` +
      (note ? ` Step guide: ${note}.` : '') +
      (released
        ? ` Lease re-granted to ${released} — continue in the worktree, then \`mars step done ${taskId}\`.`
        : ` Work in the worktree, then \`mars step done ${taskId}\` (or \`mars release ${taskId} --abort\` to bail).`),
    payload: {
      taskId,
      leaseOwner,
      leasedAt: now,
      leaseNote: note,
      stepName,
      ...(opts.previewUrl != null ? { previewUrl: opts.previewUrl } : {}),
      ...(opts.logPath != null ? { logPath: opts.logPath } : {}),
    },
    context: { taskId },
    raisedBy: 'primitive:await-human',
    signature: taskId,
    originTaskId: taskId,
    occurrence: {
      leaseOwner,
      leasedAt: now,
      parkedAt: now,
    },
  }).catch((err) => {
    console.error(
      `[await-human] task ${taskId} action-queue raise errored:`,
      err,
    )
  })

  // Throw the sentinel so the daemon can:
  // 1. Detect the park and suppress the failure write/emit (task is
  //    intentionally parked, not failed).
  // 2. Patch this step's workflow_step_runs record to 'completed' so the
  //    engine short-circuits it on the next re-dispatch — no double-park,
  //    no double-notify, even after a daemon restart.
  throw new WorkflowTerminalError('await-human', AWAIT_HUMAN_MESSAGE(taskId, stepName), { stepName })
}

// ---------------------------------------------------------------------------
// finalizeReport — read-only task completion (no merge, no verify)
// ---------------------------------------------------------------------------

/**
 * Options for {@link finalizeReport}. All fields are optional; the primitive
 * resolves defaults from `ctx.input` exactly like the other four primitives.
 */
export interface FinalizeReportOpts {
  /** Override the task id (defaults to `ctx.input.taskId ?? ctx.runId`). */
  taskId?: string
  /** Override the resolved worktree ref (useful in tests). */
  worktree?: WorktreeRef
}

/**
 * Finalise a read-only / report task without merging.
 *
 * This primitive:
 *   1. Removes the task's worktree directory and deletes the `task/<id>` branch.
 *   2. Transitions the task row to `status='done'`, `failedPhase=null`.
 *   3. Returns `{ taskId, success: true, message }`.
 *
 * It NEVER touches the integration branch, NEVER runs verify, and NEVER
 * invokes vcs-supervisor. Use it as the last step of a report-style workflow.
 */
export const finalizeReport = async (
  ctx: MarsCtx,
  opts: FinalizeReportOpts = {},
): Promise<{ taskId: string; success: true; message: string }> => {
  const taskId = resolveTaskId(ctx, opts.taskId)
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)

  await removeWorktree(
    { path: worktree.path, branch: worktree.branch },
    true,
    false,
    buildPhaseCtx(trace, taskId, 'merge'),
  )
  await updateTask(taskId, { status: 'done', failedPhase: null }, store)

  return { taskId, success: true, message: 'report complete' }
}
