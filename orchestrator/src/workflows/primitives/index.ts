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
  type WorktreeRef,
} from '../../core/lib/git/worktree'
import {
  cleanWorktreeIfNoCommitsAhead,
  verifyChanges,
  loadVerifyScopes,
  selectVerifySteps,
  getChangedFiles,
  isInfraFailureOutput,
} from '../../core/lib/git/verify'
import {
  appendEnrichmentScopes,
  recordEnrichmentShadowRuns,
} from '../../core/lib/gate-enrichment'
import { mergeBranch, checkMergeTargetStatus } from '../../core/lib/git/merge'
import { acquireLock } from '../../core/lib/git/lock'
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
} from '../../core/lib/worktree-install'
import { extractLastStreamText, type ClaudeEvent } from '../../core/lib/claude-stream'
import { getTask, hasIncompleteBlockers, updateTask } from '../../core/queue'
import { Arc } from '../../core/arc'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { resolveOriginIdForTask } from '../../core/lib/origin'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { AWAIT_HUMAN_SENTINEL } from '../../core/lib/sentinels'
import { summarizeUsage } from '../../core/lib/claude-usage'
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
import {
  resolveVerifyCwd,
  type RanVerifyStep,
} from '../../core/lib/derive-repro-command'
import {
  composePrompt,
  detectPostCoderState,
  failureExcerpt,
  recoveryAttachesToOrigin,
  resolveWorkerSystemPrompt,
  BLOCKERS_ABORT_MESSAGE,
  CODER_EXIT_NONZERO_ABORT_MESSAGE,
  CODER_UNCOMMITTED_ABORT_MESSAGE,
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  MAIN_DIRTY_VERIFY_MESSAGE,
  MAIN_DIRTY_MERGE_MESSAGE,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
  PREVIEW_GATE_MESSAGE,
  AWAIT_HUMAN_MESSAGE,
  QUOTA_REJECTED_ABORT_MESSAGE,
} from './shared'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { startDevServer } from '../../core/lib/dev-server'
import { resolveTaskCwd } from '../../core/lib/resolve-task-cwd'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

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
  resumeFromCodePhase?: boolean
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
  primitive: 'setupWorktree' | 'runAgent' | 'verify' | 'merge' | 'awaitHuman'
  /** Execution mode the workflow declares for this step. */
  mode: 'auto' | 'manual'
  /** Step guide for manual steps; null otherwise. */
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
      // state into its fresh worktree (stash push on repoRoot → pop in the
      // worktree) so the committer coder sees the files it is meant to commit.
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
        const errorOutput = isInstallErr ? error.message : String(error)

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
        const setupSignature = computeFailureSignature('setup:install', errorOutput)
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: failSummary,
            failedPhase: 'code',
            failureReason: failSummary,
            failureSignature: setupSignature,
            failureReasonCode: setupSignature,
          },
          store,
        )
        await handleTaskFailureWithFixTask({
          taskId,
          failingStep: 'setup:install',
          errorOutput: `frozen-lockfile install failed\n${errorOutput}`,
          branch: ref.branch,
          store,
          recipeContext: {
            targetPath: isInstallErr ? error.site.dir : ref.path,
            statusOutput: errorOutput,
            targetBranch: ref.branch,
            originalPrompt: '',
          },
        }).catch((err) => {
          console.error(
            `[failure-handler] task ${taskId} setup:install handling errored:`,
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
  /** True when re-dispatched after a code-phase failure (prepends a resume banner). Default false. */
  resumeFromCodePhase?: boolean
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
  /**
   * Execution mode — WHO executes this step (workflow-declared). `'auto'`
   * (default) spawns the agent. `'manual'` never spawns anything: the task
   * parks `'awaiting-human'` at this step and a Foreground session does the
   * work in the leased worktree, guided by {@link guide}; `mars step done`
   * resumes the pipeline at the next step. The park goes through the
   * awaitHuman sentinel machinery, so it is idempotent across daemon
   * restarts and constitutionally cannot be handed to an agent.
   */
  mode?: 'auto' | 'manual'
  /**
   * Step guide for a `'manual'` step — what the Foreground session should
   * accomplish here. Surfaced in the action-queue row at park, in
   * `mars attach`, and by the session hooks. Ignored when mode is `'auto'`.
   */
  guide?: string
}

export interface RunAgentResult {
  /** Claude session id (transcript key), null when the run produced none. */
  sessionId: string | null
}

/**
 * Run the coder (headless `claude -p`) inside the worktree. Mirrors the former
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
      mode: opts.mode ?? 'auto',
      guide: opts.guide ?? null,
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
  const resumeFromCodePhase =
    opts.resumeFromCodePhase ?? input(ctx).resumeFromCodePhase ?? false
  const model = opts.model
  // Manual Execution mode: park for the Foreground session instead of
  // spawning the agent. When the daemon has registered an onManualPark hook,
  // use the promise-based park/resume mechanism so the workflow continues
  // in-process after `mars step done` fires. Without the hook, fall back to
  // the awaitHuman sentinel-throw so the step is durable across restarts.
  if ((opts.mode ?? 'auto') === 'manual') {
    const stepName = ctx.currentStep?.name ?? 'code'
    const guide = opts.guide ?? `manual code step — implement the task by hand`
    if (ctx.services.onManualPark) {
      await ctx.services.onManualPark({ runId: ctx.runId, taskId, stepName, guide })
      return { sessionId: null }
    }
    await awaitHuman(ctx, { taskId, note: guide })
  }
  const store: TaskStore = ctx.services.store
  const worktree = await resolveWorktree(ctx, taskId, store, opts.worktree)
  const trace = await resolveTrace(ctx, taskId)
  const emit = (event: ClaudeEvent): void => ctx.emit('claude-event', event)
  const handle: Pick<StepHandle, 'setTranscriptKey'> | undefined =
    ctx.currentStep ?? undefined

  const worktreePath = worktree.path
  const branch = worktree.branch

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
  const basePrompt = resumeFromCodePhase
    ? `## Code-phase resume\n\nPrior progress is already in this worktree. Run \`git log -p\` first to review what was already completed, then continue from where the last coder stopped. Do NOT restart from scratch.\n\n${prompt}`
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
    },
    traceStore: spanStore(trace),
    stepName: 'run-claude-code',
    workflowInstanceId: trace.workflowInstanceId,
    originId,
    taskId,
    phase: 'code',
  })

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
    await updateTask(taskId, { status: 'queued' }, store)
    console.log(
      `[code] task ${taskId}: env-rejected by provider quota (resetsAt=${r.quotaRejected.resetsAt}); re-queued`,
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
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: `coder exited ${r.exitCode} before completing; ${diagText}`,
        failedPhase: 'code',
        failureReason: 'coder-exit-nonzero',
        failureReasonCode: 'coder-exit-nonzero',
      },
      store,
    )
    await handleTaskFailureWithFixTask({
      taskId,
      failingStep: 'code:coder-exit-nonzero',
      errorOutput: `coder process exited ${r.exitCode} without producing work. ${diagText}`,
      branch,
      store,
      recipeContext: {
        targetPath: worktreePath,
        statusOutput: `The coder exited ${r.exitCode} before doing any work (the worktree may be empty). Investigate the exit cause from the diagnostic text before retrying.`,
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
  } catch (err) {
    console.warn(
      `[post-coder] task ${taskId}: classifier threw, continuing:`,
      err,
    )
  }

  if (postState?.kind === 'dirty-no-commits') {
    const dirtyList = postState.dirtyFiles.join('\n  ')
    console.log(
      `[post-coder] task ${taskId}: dirty tree with 0 commits ahead of ${integrationBranch} — coder left ${postState.dirtyFiles.length} uncommitted path(s):\n  ${dirtyList}`,
    )
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: `coder exited cleanly but left ${postState.dirtyFiles.length} uncommitted path(s) — 0 commits ahead of ${integrationBranch}:\n  ${dirtyList}`,
        failedPhase: 'code',
        failureReason: 'coder-left-uncommitted',
        failureReasonCode: 'coder-left-uncommitted',
      },
      store,
    )
    await handleTaskFailureWithFixTask({
      taskId,
      failingStep: 'code:coder-left-uncommitted',
      errorOutput: `The coder finished but never committed. The worktree at ${worktreePath} holds completed work as uncommitted changes (${postState.dirtyFiles.length} path(s), 0 commits ahead of ${integrationBranch}). DO NOT redo the work — it is already on disk. Your job: review the uncommitted tree (\`git -C ${worktreePath} status\` / \`git -C ${worktreePath} diff\`), then \`git add -A\` and \`git commit\` it with a message describing the change, run the task's verify command, and exit. Save your work.`,
      branch,
      store,
      recipeContext: {
        targetPath: worktreePath,
        statusOutput: `The previous coder left completed work UNCOMMITTED (${postState.dirtyFiles.length} uncommitted path(s), 0 commits ahead of ${integrationBranch}):\n  ${dirtyList}\n\nThe work is done — it just was never committed. Commit it (\`git add -A && git commit\`), do not re-implement it.`,
        targetBranch: branch,
        integrationBranch,
        originalPrompt: '',
      },
    })
    console.log(
      `[post-coder] task ${taskId}: uncommitted-work recovery fix-task spawned`,
    )
    throw new WorkflowTerminalError('coder-uncommitted', CODER_UNCOMMITTED_ABORT_MESSAGE(taskId))
  }

  const usage = summarizeUsage(r.conversation)
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
// verify
// ---------------------------------------------------------------------------

/** Per-call domain options for {@link verify}. All fields default. */
export interface VerifyOpts {
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
   * Execution mode — WHO executes this step (workflow-declared). `'manual'`
   * parks the task `'awaiting-human'` so a Foreground session performs the
   * verification (e.g. visual QA) guided by {@link guide}; `mars step done`
   * resumes the pipeline. `'auto'` (default) runs scope-aware
   * typecheck/tests/lint as always.
   */
  mode?: 'auto' | 'manual'
  /** Step guide for a `'manual'` step. Ignored when mode is `'auto'`. */
  guide?: string
}

export interface VerifyResult {
  verified: true
}

/**
 * Scope-aware verify of the worktree's committed changes. Mirrors the former
 * `verify` step body:
 *
 *   - `kind:'diagnose'` short-circuits (no artefact to verify),
 *   - non-fix tasks run the verify-time dirty-main check and, if the
 *     integration branch is dirty, park behind a `main-commiter` recovery and
 *     throw the `verify:main-dirty` sentinel,
 *   - selects verify steps from the recipe scopes ∩ the files the task changed
 *     (a main-commiter recovery skips all test/typecheck/lint steps),
 *   - runs `verifyChanges` (the has-diff / commits-ahead gate always runs),
 *   - on failure stamps the task, spawns the recovery fix-task through `store`,
 *     and throws.
 *
 * Returns `{ verified: true }` on success. The throw model means reaching the
 * caller's merge step always implies verify passed.
 *
 * Usage from a scaffolded workflow:
 * ```js
 * await ctx.step('verify', () => verify(ctx, { kind }))
 * ```
 */
export const verify = async (
  ctx: MarsCtx,
  opts: VerifyOpts = {},
): Promise<VerifyResult> => {
  const recorder = validationRecorder(ctx)
  if (recorder) {
    recorder.record({
      step: ctx.currentStep?.name ?? null,
      primitive: 'verify',
      mode: opts.mode ?? 'auto',
      guide: opts.guide ?? null,
    })
    return { verified: true }
  }
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const recoveryPayload =
    opts.recoveryPayload ?? input(ctx).recoveryPayload ?? null
  // Manual Execution mode: park for the Foreground session instead of running
  // the automated gates. When the daemon has registered an onManualPark hook,
  // use the promise-based park/resume mechanism so the workflow continues
  // in-process after `mars step done` fires. Without the hook, fall back to
  // the awaitHuman sentinel-throw so the step is durable across restarts.
  if ((opts.mode ?? 'auto') === 'manual') {
    const stepName = ctx.currentStep?.name ?? 'verify'
    const guide = opts.guide ?? 'manual verify step — QA the work by hand'
    if (ctx.services.onManualPark) {
      await ctx.services.onManualPark({ runId: ctx.runId, taskId, stepName, guide })
      return { verified: true }
    }
    await awaitHuman(ctx, { taskId, note: guide })
  }
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
    fn: async (): Promise<VerifyResult> => {
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
                    ? 'spawned fresh'
                    : `attached to existing committer in status=${resolution.attachedToStatus}`
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
      // Check: `git merge-base --is-ancestor HEAD <integrationBranch>` exits 0
      // iff HEAD is already reachable from the integration branch without any
      // task-specific work on top — i.e. the branch was repointed to a commit
      // that is already on the main timeline. That is the contamination signal.
      //
      // Not applied to fix tasks (they run on the origin's branch, which is
      // expected to start on the integration timeline and then add commits).
      if (kind !== 'fix') {
        try {
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
        { status: 'verifying', failedPhase: null },
        store,
      )
      const verifyCwd = resolveVerifyCwd(worktreePath)
      const verifyCtx = resolveContext()
      const recipeScopes = await loadVerifyScopes(verifyCtx.supervisorsManifest)
      // Gate-enrichment merge (PRD 745f33e0): human-approved shadow/enforcing
      // checks from the signature-keyed registry are appended BEHIND
      // loadVerifyScopes and flow through unchanged ADR-0018 selection below
      // (path containment + always-on root floor) — no recipe schema change,
      // and the seam survives the manifest.json→verify.json migration.
      // `appendEnrichmentScopes` never throws (registry failure → recipe
      // scopes untouched).
      const scopes = await appendEnrichmentScopes(store, recipeScopes)
      const changedFiles = await getChangedFiles(
        worktreePath,
        integrationBranch,
        branch,
        buildPhaseCtx(trace, taskId, 'verify'),
      )
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE, checkIntegrationBranchDirty } = await import(
        '../../core/lib/main-dirty'
      )
      const commiterPayload =
        recoveryPayload != null
          ? parseMainCommiterPayload(recoveryPayload)
          : null
      const isMainCommitter = commiterPayload?.recipe === MAIN_COMMITER_RECIPE
      const steps = isMainCommitter ? [] : selectVerifySteps(scopes, changedFiles)

      // Serialize verify runs so DB-heavy builds (embedded-PG, Gradle) do not
      // tear down each other's database mid-suite.  This mirrors the merge
      // serialization (.merge.lock) but uses a longer timeout because
      // embedded-PG + Gradle suites can run for 30+ minutes.
      const releaseVerifyLock = await acquireLock(
        resolve(getStateDir(), '.verify.lock'),
        60 * 60 * 1000, // 60 min ceiling — generous for slow gradle/embedded-PG suites
      )
      let r = await verifyChanges({
        cwd: verifyCwd,
        steps,
        branch,
        integrationBranch,
        // Pass changedFiles for non-main-committer tasks so verifyChanges can
        // enforce the zero-gate guard: a task that changed files but has no
        // configured task-tier steps must not silently pass (verify:no-gates-configured).
        // The main-committer recipe omits changedFiles because it intentionally
        // bypasses all task-tier steps.
        changedFiles: isMainCommitter ? undefined : changedFiles,
        traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
      }).finally(() => releaseVerifyLock())

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
          const releaseRetryLock = await acquireLock(
            resolve(getStateDir(), '.verify.lock'),
            60 * 60 * 1000,
          )
          r = await verifyChanges({
            cwd: verifyCwd,
            steps,
            branch,
            integrationBranch,
            traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
          }).finally(() => releaseRetryLock())
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
      // still dirty — e.g. because git stash refused to capture ignored files,
      // or the committer exited without committing anything meaningful — the
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
          r = {
            passed: false,
            steps: [
              ...r.steps,
              {
                name: 'integration-clean',
                passed: false,
                output:
                  `verify:main-committer-still-dirty — integration branch ${integrationBranch} is still dirty after main-committer ran.\n` +
                  `The committer exited without cleaning the integration checkout (e.g. git stash refused to capture some files, or the committer did not commit).\n` +
                  `Operator action required — dirty files:\n${postClean.statusOutput}`,
                tier: 'task' as const,
              },
            ],
          }
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
      // an empty array only appears when neither has-diff nor any task steps ran
      // (should not happen in practice — the zero-gate guard catches the case
      // where changedFiles is non-empty and steps is empty).
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

      if (!r.passed) {
        const failed = r.steps.filter((s) => !s.passed)
        const summary = failed
          .map((s) => `${s.name}:\n${failureExcerpt(s.output)}`)
          .join('\n\n')
        const firstFailedName = failed[0]?.name ?? 'verify'
        const firstFailedOutput = failed[0]
          ? failureExcerpt(failed[0].output)
          : summary
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
          `verify:${firstFailedName}`,
          summary,
        )
        await updateTask(
          taskId,
          {
            status: 'failed',
            error: summary,
            failedPhase: 'verify',
            failureReason: `verify:${firstFailedName}`,
            failureSignature: verifySignature,
            failureReasonCode: verifySignature,
          },
          store,
        )
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
              failingStep: `verify:${firstFailedName}`,
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

  // ── Human-in-the-loop preview gate ────────────────────────────────────────
  // The user chose "gate BEFORE merge": when a task carries a preview command
  // and has not yet been validated, we start a live dev server off the worktree
  // and park the task in 'awaiting-validation' WITHOUT touching the integration
  // branch. Nothing merges until the operator clicks Validate (which sets
  // previewValidated and re-queues — the engine re-enters this step past the
  // gate) or Reject (which fails the task). Throwing PREVIEW_GATE_MESSAGE keeps
  // the merge step resumable; the daemon detects the sentinel and suppresses
  // failure handling.
  const gateTask = await getTask(taskId)
  const previewCmd = gateTask?.spec?.previewCmd ?? null
  if (previewCmd !== null && previewCmd.trim().length > 0 && !(gateTask?.previewValidated ?? false)) {
    const ctxResolved = resolveContext()
    const previewCwd = resolveTaskCwd(worktreePath, gateTask?.spec?.files ?? [])
    const logDir = join(ctxResolved.stateDir, 'dev-servers')
    const dev = await startDevServer({
      command: previewCmd,
      cwd: previewCwd,
      taskId,
      logDir,
    })
    await updateTask(
      taskId,
      {
        status: 'awaiting-validation',
        failedPhase: null,
        devServerUrl: dev.url,
        devServerPid: dev.pid,
      },
      store,
    )
    raiseActionQueueItem({
      kind: 'awaiting-validation',
      category: 'user',
      priority: 'high',
      title: `Validate ${taskId}: preview running at ${dev.url}`,
      body: [
        `Task \`${taskId}\` passed verify and is ready to merge into \`${integrationBranch}\`, but it carries a preview command, so it is paused for your review.`,
        '',
        `A live dev server is running off the task's worktree:`,
        '',
        `  ${dev.url}`,
        '',
        `Open it, check the change, then:`,
        `  - **Validate** to merge into \`${integrationBranch}\` and finish the task, or`,
        `  - **Reject** to stop the merge and fail the task (its worktree is kept so you can restart or drop it).`,
        '',
        `Preview command: \`${previewCmd}\``,
        `Server log: \`${dev.logPath}\``,
        '',
        `Nothing has been merged yet — \`${integrationBranch}\` is untouched until you Validate.`,
      ].join('\n'),
      payload: {
        taskId,
        devServerUrl: dev.url,
        devServerPid: dev.pid,
        previewCmd,
        integrationBranch,
        branch,
      },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: 'merge:preview-gate',
      signature: `${taskId}:awaiting-validation`,
      originTaskId: taskId,
      occurrence: {
        at: new Date().toISOString(),
        taskId,
        devServerUrl: dev.url,
      },
    }).catch((err) => {
      console.error(
        `[merge:preview-gate] task ${taskId} action-queue raise errored:`,
        err,
      )
    })
    throw new WorkflowTerminalError('preview-gate', PREVIEW_GATE_MESSAGE(taskId))
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
    const gateCtx = resolveContext()
    const gateScopes = await loadVerifyScopes(gateCtx.supervisorsManifest)

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

    // Run gates via verifyChanges, remapping tier to 'task' so the function
    // actually executes them (verifyChanges defers integration-tier steps to
    // this boundary).
    const gateResult = await verifyChanges({
      cwd: worktreePath,
      steps: integrationSteps.map((s) => ({ ...s, tier: 'task' as const })),
      // No branch/integrationBranch — skip the has-diff gate for this run.
      traceCtx: buildPhaseCtx(trace, taskId, 'merge'),
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
          // Re-probe via checkIntegrationBranchDirty to get the dedup hash
          // (checkMergeTargetStatus does not compute one). If main was cleaned
          // between the preflight and now (a race), fall through to the normal
          // merge attempt.
          const {
            checkIntegrationBranchDirty,
            MAIN_COMMITER_RECIPE,
            spawnOrAttachMainCommitter,
          } = await import('../../core/lib/main-dirty')
          const { loadRecipeCatalog } = await import('../../core/lib/recipes')
          const mergeCtx = resolveContext()
          const detection = await checkIntegrationBranchDirty({
            repoRoot: mergeCtx.repoRoot,
            integrationBranch,
            traceCtx: buildPhaseCtx(trace, taskId, 'merge'),
          })

          if (!detection.dirty) {
            // Race: main was cleaned between preflight and re-probe — proceed.
            console.log(
              `[main-dirty] merge-time: task ${taskId} re-probe found clean after preflight dirty; proceeding to merge attempt`,
            )
          } else {
            const catalog = await loadRecipeCatalog(mergeCtx.stateDir)
            const recipe = catalog.get(MAIN_COMMITER_RECIPE)
            if (recipe) {
              const resolution = await spawnOrAttachMainCommitter({
                sourceTaskId: taskId,
                detection,
                integrationBranch,
                dispatchPhase: 'merge',
                recipePrompt: recipe.prompt,
                sourceOriginId: trace.originId,
                traceStore: trace.traceStore,
                store,
              })
              console.log(
                `[main-dirty] merge-time: task ${taskId} parked blocked on main-commiter ${resolution.fixTaskId} (${
                  resolution.spawned
                    ? 'spawned fresh'
                    : `attached to existing committer in status=${resolution.attachedToStatus}`
                })`,
              )
              throw new WorkflowTerminalError(
                'main-dirty-merge',
                `task ${taskId} merge:main-dirty: ${MAIN_DIRTY_MERGE_MESSAGE}`,
              )
            } else {
              // Recipe missing from catalog — fall back to the hard-fail +
              // manual action-queue item so a broken/stripped catalog still
              // surfaces something actionable.
              const DIRTY_TARGET_SIGNATURE = 'merge:preflight/uncommitted-changes'
              const errorMsg = `merge target ${targetStatus.targetPath} has uncommitted changes blocking fast-forward\n${targetStatus.statusOutput}`
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
              raiseActionQueueItem({
                kind: 'failed',
                category: 'orchestrator',
                priority: 'high',
                title: `Merge blocked: ${integrationBranch} has uncommitted changes — clean and continue ${taskId}`,
                body: [
                  `Task \`${taskId}\` reached the merge step with committed work on branch \`${branch}\`, but the merge target (\`${integrationBranch}\`) has uncommitted tracked changes on paths that the fast-forward would update.`,
                  '',
                  `This is an operator/environment condition, not a code defect. The task's committed work is intact on branch \`${branch}\`.`,
                  '',
                  `The \`${MAIN_COMMITER_RECIPE}\` recipe is missing from the catalog, so automatic recovery could not be spawned.`,
                  '',
                  `**To unblock:**`,
                  `1. Clean \`${integrationBranch}\`: commit, stash, or discard the uncommitted changes listed below.`,
                  `2. Run \`mars continue ${taskId}\` — this re-attempts just the merge step without re-running the coder.`,
                  `   (\`mars restart ${taskId}\` also works but discards the committed branch and re-runs from scratch.)`,
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
              }).catch((err) => {
                console.error(
                  `[merge:preflight] task ${taskId} dirty-target action-queue raise errored:`,
                  err,
                )
              })
              throw new Error(
                `task ${taskId} merge:preflight detected dirty target ${integrationBranch}`,
              )
            }
          }
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
        const m = await mergeBranch({
          branch,
          worktreePath,
          integrationBranch,
          lockTimeoutMs: 5 * 60 * 1000,
          traceCtx: buildPhaseCtx(trace, taskId, 'merge'),
          onVegaStart: async () => {
            await updateTask(taskId, { status: 'vega-reconciling' }, store)
          },
          onSupervisorEvent: async (event) => {
            supervisorConversation.push(event)
            emit?.(event)
          },
          onAfterFastForward: async (info) => {
            capturedMergeShas = {
              mergePreSha: info.finalIntegrationSha,
              mergePostSha: info.finalTaskSha,
            }
            await integrationGateRunner(info)
          },
        })

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
          await updateTask(
            taskId,
            {
              status: 'failed',
              error: errorMsg,
              failedPhase: 'merge',
              failureReason: 'merge:vcs-supervisor-aborted',
              failureReasonCode: 'merge:vcs-supervisor-aborted',
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
            error.message.includes('merge:integration-gate'))
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
}

/**
 * Park the task in 'awaiting-human' and durably suspend the pipeline until
 * the operator releases the lease via `mars release <id>`.
 *
 * @deprecated **Prefer `mode: 'manual'` on {@link runAgent} or {@link verify}.**
 * When a step carries `mode === 'manual'`, the primitive uses the
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
        : ` Take the lease with \`mars attach ${taskId}\`, work in the worktree, then \`mars step done ${taskId}\` (or \`mars release ${taskId} --abort\` to bail).`),
    payload: {
      taskId,
      leaseOwner,
      leasedAt: now,
      leaseNote: note,
      stepName,
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
