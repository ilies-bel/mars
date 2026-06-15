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
} from '../../core/lib/git/verify'
import { mergeBranch, checkMergeTargetStatus } from '../../core/lib/git/merge'
import {
  createWorker,
  pickWorkerForTags,
  Workers,
  type Worker,
} from '../../core/workers'
import { isTaskTag, type TaskTag, type TaskSpec } from '../../core/queue'
import { resolveContext } from '../../core/context'
import {
  installWorktreeDeps,
  repairInstallInPlace,
  WorktreeInstallError,
} from '../../core/lib/worktree-install'
import type { ClaudeEvent } from '../../core/lib/claude-stream'
import { getTask, hasIncompleteBlockers, updateTask } from '../../core/queue'
import { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { resolveOriginIdForTask } from '../../core/lib/origin'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { summarizeUsage } from '../../core/lib/claude-usage'
import { recordSignals } from '../../core/lib/reflect-signals'
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
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  MAIN_DIRTY_VERIFY_MESSAGE,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
} from './shared'

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
 * — never passed by the caller.
 */
interface PrimitiveTraceArgs {
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
const resolveTrace = (ctx: MarsCtx, taskId: string): Promise<PrimitiveTraceArgs> => {
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

/** Resolve the worktree ref: explicit override wins, else the memoised one. */
const resolveWorktree = (ctx: MarsCtx, override?: WorktreeRef): WorktreeRef => {
  const wt = override ?? worktreeCache.get(ctx)
  if (!wt) {
    throw new Error(
      'no worktree available: call setupWorktree(ctx, ...) before verify/merge, ' +
        'or pass { worktree } explicitly.',
    )
  }
  return wt
}

/** Read the run's dispatch input (never throws; `{}` when absent). */
const input = (ctx: MarsCtx): MarsWorkflowInput => ctx.input ?? {}

/**
 * The task id a primitive operates on. Precedence: explicit `opts` override →
 * `ctx.input.taskId` (dispatch fact) → `ctx.runId` (the daemon dispatches with
 * runId === task.id, so this is the common case).
 */
const resolveTaskId = (ctx: MarsCtx, override?: string): string =>
  override ?? input(ctx).taskId ?? ctx.runId

/** Build the per-phase {@link TraceCtx} a primitive threads into git shell-outs. */
const buildPhaseCtx = (
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
const spanStore = (trace: PrimitiveTraceArgs): TraceEventStore | undefined =>
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
    throw new Error(BLOCKERS_ABORT_MESSAGE(taskId))
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
      throw new Error(ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE(taskId))
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
      const ref = attachesToOrigin
        ? await attachOriginWorktreeForFix()
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
  const worktree = resolveWorktree(ctx, opts.worktree)
  const store: TaskStore = ctx.services.store
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
  const fullPrompt = composePrompt(
    basePrompt,
    plan,
    primaryTag,
    spec ?? null,
    taskId,
    worktreePath,
    kind,
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

  // Salt the session key with retryCount so each restart attempt derives a
  // distinct Claude session id. Without the salt, toClaudeSessionId produces
  // the same UUID on every attempt (taskId is fixed), and `claude --session-id`
  // fails with "Session ID <uuid> is already in use" — killing the run before
  // it does any work. retryCount is stable for the lifetime of one attempt and
  // bumps only on restart, so the key is stable within an attempt and distinct
  // across attempts.
  //
  // retryCount === 0 keeps the key equal to taskId so first-attempt UUIDs are
  // byte-identical to their historical values (zero behaviour change for the
  // common path). Only restarts (retryCount > 0) get a fresh, non-colliding id.
  //
  // Both spawn paths normalise the key to a valid UUID via toClaudeSessionId
  // (PTY in providers.ts, headless/stream in claudeStreamArgs) before it
  // reaches `claude --session-id`, so a non-UUID task id is acceptable here.
  const taskForSession = await getTask(taskId, store)
  const retryCount = taskForSession?.retryCount ?? 0
  const sessionKey = retryCount > 0 ? `${taskId}#${retryCount}` : taskId

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
    throw new Error(CONTEXT_EXHAUSTED_ABORT_MESSAGE(taskId))
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
    await updateTask(
      taskId,
      {
        status: 'failed',
        error: `coder exited ${r.exitCode} before completing; stderr tail:\n${stderrTail}`,
        failedPhase: 'code',
        failureReason: 'coder-exit-nonzero',
        failureReasonCode: 'coder-exit-nonzero',
      },
      store,
    )
    await handleTaskFailureWithFixTask({
      taskId,
      failingStep: 'code:coder-exit-nonzero',
      errorOutput: `coder process exited ${r.exitCode} without producing work. stderr tail:\n${stderrTail}`,
      branch,
      store,
      recipeContext: {
        targetPath: worktreePath,
        statusOutput: `The coder exited ${r.exitCode} before doing any work (the worktree may be empty). Investigate the exit cause from the stderr tail before retrying.`,
        targetBranch: branch,
        originalPrompt: '',
      },
    })
    console.log(
      `[code] task ${taskId}: coder exited ${r.exitCode}; recovery fix-task spawned`,
    )
    throw new Error(CODER_EXIT_NONZERO_ABORT_MESSAGE(taskId, r.exitCode))
  }

  // Classify the worktree end-state for the run log (best-effort).
  try {
    const postState = await detectPostCoderState({
      worktreePath,
      integrationBranch,
      traceCtx: buildPhaseCtx(trace, taskId, 'code'),
    })
    if (postState.kind === 'dirty-no-commits') {
      console.log(
        `[post-coder] task ${taskId}: dirty tree with 0 commits ahead of ${integrationBranch} — ${postState.dirtyFiles.length} uncommitted path(s):\n  ${postState.dirtyFiles.join('\n  ')}`,
      )
    } else if (postState.kind === 'error') {
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
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const recoveryPayload =
    opts.recoveryPayload ?? input(ctx).recoveryPayload ?? null
  const worktree = resolveWorktree(ctx, opts.worktree)
  const store: TaskStore = ctx.services.store
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
              if (resolution.attachedToStatus === 'done') {
                console.log(
                  `[main-dirty] verify-time: task ${taskId} found done committer at same hash; falling through to standard verify`,
                )
              } else {
                console.log(
                  `[main-dirty] verify-time: task ${taskId} parked blocked on main-commiter ${resolution.fixTaskId} (${
                    resolution.spawned
                      ? 'spawned fresh'
                      : `attached to existing committer in status=${resolution.attachedToStatus}`
                  })`,
                )
                throw new Error(
                  `task ${taskId} verify:main-dirty: ${MAIN_DIRTY_VERIFY_MESSAGE}`,
                )
              }
            } else {
              console.log(
                `[main-dirty] verify-time: integration branch is dirty but recipe '${MAIN_COMMITER_RECIPE}' is missing from the catalog; falling through to standard verify`,
              )
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('verify:main-dirty')) {
            throw err
          }
          console.warn(
            `[main-dirty] verify-time check threw, continuing with verify: ${
              err instanceof Error ? err.message : String(err)
            }`,
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
      const scopes = await loadVerifyScopes(verifyCtx.supervisorsManifest)
      const changedFiles = await getChangedFiles(
        worktreePath,
        integrationBranch,
        branch,
        buildPhaseCtx(trace, taskId, 'verify'),
      )
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
        '../../core/lib/main-dirty'
      )
      const commiterPayload =
        recoveryPayload != null
          ? parseMainCommiterPayload(recoveryPayload)
          : null
      const steps =
        commiterPayload?.recipe === MAIN_COMMITER_RECIPE
          ? []
          : selectVerifySteps(scopes, changedFiles)
      const r = await verifyChanges({
        cwd: verifyCwd,
        steps,
        branch,
        integrationBranch,
        traceCtx: buildPhaseCtx(trace, taskId, 'verify'),
      })

      const verifyOutput = r.steps
        .map((s) => `=== ${s.name} (${s.passed ? 'pass' : 'fail'}) ===\n${s.output}`)
        .join('\n\n')
      capturedVerifyOutput = verifyOutput

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
  // Resolve dispatch facts: explicit opts → ctx.input → hard default.
  const taskId = resolveTaskId(ctx, opts.taskId)
  const kind = opts.kind ?? input(ctx).kind ?? 'task'
  const integrationBranch =
    opts.integrationBranch ?? input(ctx).integrationBranch ?? 'main'
  const worktree = resolveWorktree(ctx, opts.worktree)
  const store: TaskStore = ctx.services.store
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
  return await runNonLlmStepWithSpan({
    stepName: 'merge',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    taskId: taskId,
    phase: 'merge',
    traceStore: spanStore(trace),
    getVegaInfo: () => vegaSpanInfo,
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
            error.message.includes('merge aborted; vcs-supervisor could not reconcile'))
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
