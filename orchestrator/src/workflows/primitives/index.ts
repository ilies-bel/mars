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
 * Each primitive takes an explicit args object — NOT the raw `ctx` — so a
 * plain-JS scaffolded workflow can call it with values it already has in hand
 * (`ctx.services.store`, `ctx.runId`, `ctx.emit`, the resolved worktree ref,
 * the integration branch, a trace store). This keeps the primitives runnable
 * outside the bundled workflow without dragging the engine's `WorkflowCtx`
 * shape into their signatures.
 *
 * CRITICAL — no-stranded-entity invariant (ADR-0052). Every primitive that
 * mutates task state routes that mutation through the injected `store`
 * (the Arc-backed `DomainTaskStore`) and the failure handler's `store` arg,
 * exactly as the former inline step bodies did. A custom workflow that calls
 * these primitives therefore CANNOT bypass Arc — the write funnel is baked into
 * the primitive, not left to the caller.
 */
import type { StepHandle } from '@mars/workflow'

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
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  MAIN_DIRTY_VERIFY_MESSAGE,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
} from './shared'

// ---------------------------------------------------------------------------
// Shared primitive args
// ---------------------------------------------------------------------------

/**
 * Trace/identity context every primitive needs to wrap its work in a span and
 * attribute its shell-outs. The bundled workflow fills these from `ctx` and the
 * resolved origin id; a scaffolded workflow fills them from `ctx.runId` plus a
 * trace store it opened (or `nullTraceStore`).
 */
export interface PrimitiveTraceArgs {
  /** Engine run id (`ctx.runId`); used as `workflowInstanceId` on spans. */
  workflowInstanceId: string
  /** Stable origin attribution for every trace event. */
  originId: string
  /** Workflow-level trace store; `nullTraceStore` disables span/event capture. */
  traceStore: TraceEventStore
}

/**
 * Build a {@link PrimitiveTraceArgs} from a workflow run id, opening the shared
 * workflow trace store best-effort and resolving a stable origin id. This is
 * the one-liner a scaffolded `.mars/workflows/*.js` calls to get the same
 * tracing the bundled implement pipeline wires by hand:
 *
 * ```js
 * const trace = await buildPrimitiveTrace(ctx.runId, input.taskId)
 * const wt = await setupWorktree({ ..., trace, store: ctx.services.store })
 * ```
 *
 * Failure to open the trace store collapses to `nullTraceStore` (spans/events
 * are silently dropped) so a custom workflow never fails on observability.
 */
export const buildPrimitiveTrace = async (
  workflowInstanceId: string,
  taskId: string,
): Promise<PrimitiveTraceArgs> => {
  const { openTraceEventStore } = await import('../../core/lib/trace-events-store')
  const traceStore: TraceEventStore =
    (await openTraceEventStore(resolveContext().stateDbPath).catch(() => undefined)) ??
    nullTraceStore
  const originId = await resolveOriginIdForTask(taskId).catch(() => taskId)
  return { workflowInstanceId, originId, traceStore }
}

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

export interface SetupWorktreeArgs {
  taskId: string
  integrationBranch: string
  kind: 'task' | 'fix' | 'diagnose'
  /** Serialised recovery payload (`tasks.recovery_payload`); only on `kind:'fix'`. */
  recoveryPayload: string | null
  /** The origin task a recovery recovers (`tasks.fix_for_task_id`). */
  fixForTaskId: string | null
  /** Arc-backed task store — ALL task-state writes route through this. */
  store: TaskStore
  trace: PrimitiveTraceArgs
  /**
   * Optional engine step handle. When supplied the primitive records the
   * integration HEAD sha on the step record (`handle.setSha`); a scaffolded
   * workflow that has no handle can omit it.
   */
  handle?: Pick<StepHandle, 'setSha'>
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
 * Every task-state write goes through `args.store` (the Arc funnel), so a
 * custom workflow composing this primitive cannot strand a task.
 */
export const setupWorktree = async (
  args: SetupWorktreeArgs,
): Promise<SetupWorktreeResult> => {
  const { taskId, integrationBranch, store, trace, handle } = args

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
    const originTaskId = args.fixForTaskId
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
    phase: 'setup',
    traceStore: spanStore(trace),
    fn: async (): Promise<SetupWorktreeResult> => {
      await updateTask(taskId, { status: 'running' }, store)

      // Ordinary recovery (kind=fix) tasks attach to the origin's worktree;
      // a main-commiter recovery (also kind=fix) carves its own fresh worktree.
      let isMainCommiterFix = false
      if (args.kind === 'fix' && args.recoveryPayload != null) {
        const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
          '../../core/lib/main-dirty'
        )
        isMainCommiterFix =
          parseMainCommiterPayload(args.recoveryPayload)?.recipe ===
          MAIN_COMMITER_RECIPE
      }
      const attachesToOrigin = recoveryAttachesToOrigin(
        args.kind,
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

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

export interface RunAgentArgs {
  taskId: string
  prompt: string
  plan: { functional: string; technical: string } | null
  tags: TaskTag[]
  kind: 'task' | 'fix' | 'diagnose'
  spec: TaskSpec | null
  integrationBranch: string
  /** True when re-dispatched after a code-phase failure (prepends a resume banner). */
  resumeFromCodePhase: boolean
  /** Resolved worktree ref from {@link setupWorktree}. */
  worktree: WorktreeRef
  store: TaskStore
  trace: PrimitiveTraceArgs
  /** Forward fine-grained coder progress (`ctx.emit('claude-event', …)`). */
  emit?: (event: ClaudeEvent) => void
  handle?: Pick<StepHandle, 'setTranscriptKey'>
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
 */
export const runAgent = async (args: RunAgentArgs): Promise<RunAgentResult> => {
  const { taskId, integrationBranch, worktree, store, trace, emit, handle } = args
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
  const primaryTag: TaskTag = args.tags.find(isTaskTag) ?? 'coder'
  const basePrompt = args.resumeFromCodePhase
    ? `## Code-phase resume\n\nPrior progress is already in this worktree. Run \`git log -p\` first to review what was already completed, then continue from where the last coder stopped. Do NOT restart from scratch.\n\n${args.prompt}`
    : args.prompt
  const fullPrompt = composePrompt(
    basePrompt,
    args.plan,
    primaryTag,
    args.spec ?? null,
    taskId,
    worktreePath,
    args.kind,
  )

  // Registry workers: merge operator-declared Workers so their tag sets are
  // visible to pickWorkerForTags.
  const { listMergedWorkers } = await import('../../core/workers/persisted-registry')
  const declarations = listMergedWorkers(resolveContext().stateDir)
  const allWorkers: Record<string, Worker> = { ...Workers }
  for (const decl of declarations) {
    if (!(decl.name in allWorkers)) {
      allWorkers[decl.name] = createWorker({
        name: decl.name,
        model: decl.model,
        ...(decl.fallbackModel !== undefined ? { fallbackModel: decl.fallbackModel } : {}),
        effort: decl.effort,
        permissionMode: decl.permissionMode,
        bare: decl.bare,
        disallowedTools: decl.disallowedTools,
        outputFormat: decl.outputFormat,
        maxMessages: decl.maxMessages,
        maxContextTokens: 0,
        runtime: decl.runtime,
        provider: 'claude',
        ...(decl.tags !== undefined ? { tags: decl.tags } : {}),
      })
    }
  }
  const worker =
    args.kind === 'fix' ? Workers.Fixer : pickWorkerForTags(args.tags, allWorkers)

  const r = await runWorkerWithSpan({
    worker,
    prompt: fullPrompt,
    runOptions: {
      cwd: worktreePath,
      systemPrompt: resolveWorkerSystemPrompt(primaryTag),
      onEvent: async (event) => {
        emit?.(event)
      },
    },
    traceStore: spanStore(trace),
    stepName: 'run-claude-code',
    workflowInstanceId: trace.workflowInstanceId,
    originId,
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

export interface VerifyArgs {
  taskId: string
  kind: 'task' | 'fix' | 'diagnose'
  integrationBranch: string
  recoveryPayload: string | null
  worktree: WorktreeRef
  store: TaskStore
  trace: PrimitiveTraceArgs
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
 */
export const verify = async (args: VerifyArgs): Promise<VerifyResult> => {
  const { taskId, integrationBranch, worktree, store, trace } = args
  const worktreePath = worktree.path
  const branch = worktree.branch

  if (args.kind === 'diagnose') {
    return { verified: true }
  }

  let capturedVerifyOutput: string | undefined
  return await runNonLlmStepWithSpan({
    stepName: 'verify',
    workflowInstanceId: trace.workflowInstanceId,
    originId: trace.originId,
    phase: 'verify',
    traceStore: spanStore(trace),
    getCommandOutput: () => capturedVerifyOutput,
    fn: async (): Promise<VerifyResult> => {
      // Verify-time dirty-main check (non-fix only).
      if (args.kind !== 'fix') {
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
        args.recoveryPayload != null
          ? parseMainCommiterPayload(args.recoveryPayload)
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

export interface MergeArgs {
  taskId: string
  kind: 'task' | 'fix' | 'diagnose'
  integrationBranch: string
  worktree: WorktreeRef
  store: TaskStore
  trace: PrimitiveTraceArgs
  /** Forward Vega conflict-resolution events (`ctx.emit('vcs-supervisor-event', …)`). */
  emit?: (event: ClaudeEvent) => void
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
 * All task-state writes route through `store`.
 */
export const merge = async (args: MergeArgs): Promise<MergeOutput> => {
  const { taskId, integrationBranch, worktree, store, trace, emit } = args
  const worktreePath = worktree.path
  const branch = worktree.branch

  if (args.kind === 'diagnose') {
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
