/**
 * The `runAgent` primitive shell (the coder step).
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). Framework-owned:
 * every task-state write below goes through `ctx.services.store` (the Arc
 * aggregate, ADR-0052). The worker itself is selected through the worker
 * registry (`core/workers`) — swapping the worker changes what the step does,
 * never whether the task row is updated.
 */
import { type StepHandle } from '@mars/workflow'
import {
  restoreWorktreeIfMissing,
  ResumeWorktreeUnrecoverable,
  type WorktreeRef,
} from '../../core/lib/git/worktree'
import { cleanWorktreeIfNoCommitsAhead, selectVerifySteps } from '../../core/ports/verifier/verify-helpers'
import { createWorker, pickWorkerForTags, Workers, type Worker } from '../../core/workers'
import { resolveContext } from '../../core/context'
import { type AgentEvent } from '../../core/lib/claude-stream'
import { isTaskTag, type TaskTag, type TaskSpec, updateTask } from '../../core/queue'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { resolveOriginIdForTask } from '../../core/lib/origin'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { summarizeUsageForSemantics, buildContextTokenSignals } from '../../core/lib/claude-usage'
import { usageSemanticsOf } from '../../core/workers/providers'
import { PROVIDER_MODELS, type ProviderModelTier } from '../../core/workers/provider-types'
import { recordSignals } from '../../core/lib/reflect-signals'
import { resolveTaskDomains, fetchLessonsForTask } from '../../core/store/memory-packet-store'
import { runWorkerWithSpan } from '../../core/lib/run-worker-with-span'
import { composePrompt, resolveWorkerSystemPrompt } from '../../workflows/primitives/shared'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { distillObservation } from '../../core/lib/distill/observation'
import {
  type MarsCtx,
  resolveTrace,
  resolveWorktree,
  readWorkflowInput as input,
  resolveTaskId,
  buildPhaseCtx,
  spanStore,
  readCachedIndexCard,
} from '../context'
import { validationRecorder } from '../validate-recorder'
import { buildSessionKey } from './session-key'
import { ensureWorktreeCurrent } from './worktree-currency'
import {
  classifyCoderExit,
  classifyCoderExitDisposition,
  enforceCoderCommitContract,
} from './coder-exit'
import {
  composeRestartCheckpoint,
  renderRestartCheckpoint,
  RESTART_CHECKPOINT_KIND,
} from '../../core/coder/restart-checkpoint'
import { startPeriodicCheckpoint } from '../../core/lib/git/checkpoint'

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
  /**
   * Model tier for this step. When set and `model` is not explicitly provided,
   * the tier is translated to a native model id via the selected Worker's
   * Provider tier map (`PROVIDER_MODELS[provider][tier]`). Precedence:
   * `opts.model` > `MARS_WORKER_MODEL` (Coder only) > `opts.modelTier` > the
   * Worker's pinned default. Mechanical steps should pass `'fast'`; coding
   * defaults to `'balanced'` per Worker policy; recovery should stay on
   * `'flagship'` unless explicitly downgraded.
   */
  modelTier?: ProviderModelTier
  /**
   * Index-card text to inject into the composed prompt. When omitted, the cache
   * stashed by `setupWorktree` is used automatically — explicit injection is only
   * needed when calling `runAgent` without a preceding `setupWorktree` step.
   * Pass `null` to suppress the card even when one is cached.
   */
  indexCard?: string | null
}

export interface RunAgentResult {
  /** Claude session id (transcript key), null when the run produced none. */
  sessionId: string | null
}

/**
 * All valid option keys for {@link runAgent}. Unknown keys indicate a mis-wired
 * template (e.g. `mode:'manual'` — use {@link awaitHuman} instead) and are
 * caught at runtime so a plain-JS workflow file cannot silently degrade a
 * manual step into a headless coder dispatch.
 */
const KNOWN_RUN_AGENT_KEYS: ReadonlySet<string> = new Set<keyof RunAgentOpts>([
  'prompt',
  'plan',
  'tags',
  'kind',
  'spec',
  'integrationBranch',
  'resumeFromPriorAttempt',
  'verifyFailureOutput',
  'taskId',
  'worktree',
  'model',
  'modelTier',
  'indexCard',
])

/**
 * Run the coder through the selected headless provider inside the worktree. Mirrors the former
 * `run-agent` step body: sweeps stray debris from a prior failed attempt
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
 * Coder progress is forwarded to `ctx.emit('agent-event', …)` internally.
 */
export const runAgent = async (
  ctx: MarsCtx,
  opts: RunAgentOpts = {},
): Promise<RunAgentResult> => {
  // Unknown option keys are silently dropped at the TypeScript type level when
  // the caller is a plain-JS workflow file. Detect them loudly here so a
  // template bug (e.g. `{ mode: 'manual', guide: '...' }`) cannot silently
  // degrade a manual step into a headless coder dispatch. Use
  // `awaitHuman(ctx, { note })` to park a step for human implementation.
  const unknownKeys = Object.keys(opts).filter(k => !KNOWN_RUN_AGENT_KEYS.has(k))
  if (unknownKeys.length > 0) {
    const badOptsMessage =
      `runAgent: unknown option(s) ${unknownKeys.map(k => `'${k}'`).join(', ')} — ` +
        `did you mean awaitHuman(ctx, { note }) for a manual step?`
    // In production, stamp the task failed in the DB before throwing so the
    // phantom-task watchdog does not re-queue a task stuck in `running` status.
    // Without this stamp the dispatch loop emits `task.completed` (not
    // `task.failed`) for a non-WorkflowTerminalError result, leaving the DB
    // status as `running`; the watchdog eventually re-queues it and the same
    // deterministic error fires again — a silent loop with no operator alert.
    // In a validation dry-run the recorder is present and the inert store is a
    // no-op, but we skip the async stamp entirely to keep validation synchronous.
    if (!validationRecorder(ctx)) {
      const taskId = resolveTaskId(ctx, opts.taskId)
      const store: TaskStore = ctx.services.store
      // Best-effort: any error (sync TypeError on a stub store, or a rejected
      // promise) must NOT mask the real error. Wrap the whole call so the throw
      // below propagates regardless of whether the DB write succeeds.
      try {
        await store.updateTask(taskId, {
          status: 'failed',
          error: badOptsMessage,
          failureReason: 'dispatch:bad-primitive-opts',
          failureReasonCode: 'dispatch:bad-primitive-opts',
        })
      } catch (_stampErr) {
        // intentionally swallowed — the throw below is the real signal
      }
    }
    throw new Error(badOptsMessage)
  }
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
  const emit = (event: AgentEvent): void => ctx.emit('agent-event', event)
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

  // Distill noisy verify output before embedding it in the resume banner.
  // Raw vitest / tsc output can exceed 200 000 chars; the distilled form
  // strips progress bars and timing lines, keeping only signal (FAIL lines,
  // Error:, TS diagnostics, diff hunks). A <verify_full_log_ref> element
  // points the coder at the persisted full log so nothing is truly lost.
  let verifyBlock = ''
  if (verifyFailureOutput !== null) {
    const verifyLogRef = `arc://task/${taskId}/verify-output`
    const distilled = distillObservation({
      text: verifyFailureOutput,
      ref: verifyLogRef,
      kind: 'verify',
    })
    verifyBlock =
      `\n\n<verify_full_log_ref>${verifyLogRef}</verify_full_log_ref>\n` +
      `The previous verification failed. Fix the task diff using this recorded output:\n\n` +
      `\`\`\`text\n${distilled.text}\n\`\`\``
    // Emit telemetry — best-effort, must never affect dispatch.
    trace.traceStore
      .record({
        kind: 'distill.applied',
        taskId,
        originId,
        phase: 'code',
        payload: {
          ref: verifyLogRef,
          originalBytes: distilled.originalBytes,
          distilledBytes: distilled.distilledBytes,
        },
      })
      .catch(() => {
        // Telemetry must never change the completion result.
      })
  }

  const fullTask = await store.getTask(taskId).catch(() => null)
  const domains = resolveTaskDomains({
    workflow: fullTask?.workflow ?? null,
    tags,
  })
  const lessons = await fetchLessonsForTask(domains).catch(() => [] as string[])
  // Load active verify gate steps so the coder's <verify> block contains the
  // exact commands the orchestrator's verify step will run (package-wide
  // typecheck included), not only what the slicer put in spec.verifyCmd.
  // This prevents narrow-test false positives where focused tests pass but the
  // package typecheck fails at the orchestrator's verify gate.
  // Best-effort: gate-load failures must never block dispatch.
  const gateSteps = await (async () => {
    try {
      const { loadVerifyGates } = await import('../../core/verify-gates')
      const scopes = await loadVerifyGates(store)
      return selectVerifySteps(scopes, spec?.files ?? [])
    } catch {
      return []
    }
  })()
  // Resolve the index card: explicit opts.indexCard wins; otherwise fall back
  // to the card stashed by setupWorktree. When opts.indexCard is explicitly
  // null, suppress the card even if one is cached.
  const indexCard =
    'indexCard' in opts ? opts.indexCard ?? null : (readCachedIndexCard(ctx) ?? null)
  // Compose the stable prefix + task-specific body. The resume banner and
  // distilled verify-failure block are appended AFTER composePrompt returns so
  // the stable prefix bytes (COMMIT_EXIT_CONDITION → CODING_DISCIPLINE →
  // COMMIT_FOOTER) are byte-identical whether or not this is a resume dispatch.
  // Prepending them (the old basePrompt approach) displaced the stable prefix
  // and prevented provider-side caching of the shared boilerplate.
  let fullPrompt = composePrompt(
    prompt,
    plan,
    primaryTag,
    spec ?? null,
    taskId,
    worktreePath,
    kind,
    lessons,
    gateSteps,
    indexCard,
    false,
    null,
    fullTask?.workflow ?? null,
  )
  // Compose and render the restart checkpoint when this is a resume dispatch.
  // Best-effort: a composition failure must never block dispatch.
  let checkpointSection = ''
  if (resumeFromPriorAttempt && fullTask !== null) {
    try {
      const cp = await composeRestartCheckpoint({
        taskId,
        worktreePath,
        task: fullTask,
        workflowState: { runId: ctx.runId, step: 'run-claude-code' },
      })
      const rendered = renderRestartCheckpoint(cp)
      if (rendered) checkpointSection = '\n\n' + rendered
      await trace.traceStore.record({
        kind: RESTART_CHECKPOINT_KIND,
        taskId,
        originId: trace.originId,
        phase: 'code',
        payload: {
          taskId,
          commitCount: cp.commits.length,
          changedPathCount: cp.changedPaths.length,
          outstandingCount: cp.outstandingCriteria.length,
          hadPriorVerify: cp.lastVerify !== null,
          renderedBytes: rendered.length,
        },
      })
    } catch (cpErr) {
      console.warn(
        `[code] task ${taskId}: restart checkpoint composition failed (non-fatal):`,
        cpErr instanceof Error ? cpErr.message : String(cpErr),
      )
    }
  }
  if (resumeFromPriorAttempt || verifyBlock !== '') {
    fullPrompt =
      fullPrompt +
      checkpointSection +
      '\n\n## Resume prior work\n\nPrior progress is already in this worktree. Run `git log -p` first to review what was already completed, then continue from where the last coder stopped. Do NOT restart from scratch.' +
      verifyBlock
  }

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
  // and pty spawn paths. Precedence: explicit `model` > tier-resolved model >
  // Worker's pinned default. `modelTier` translates to a native model id via
  // the Worker's Provider tier map; `model` always wins when both are set.
  const _tierResolvedModel =
    opts.modelTier !== undefined
      ? PROVIDER_MODELS[selectedWorker.config.provider][opts.modelTier]
      : undefined
  const _effectiveModel = model ?? _tierResolvedModel
  const worker =
    _effectiveModel !== undefined && _effectiveModel !== selectedWorker.config.model
      ? createWorker({ ...selectedWorker.config, model: _effectiveModel, modelTier: opts.modelTier ?? selectedWorker.config.modelTier })
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

  // At-most-two-attempt retry loop for retryable-transient exits (e.g. SIGKILL
  // or startup failure before provider contact). On attempt 1 a retryable exit
  // re-derives a fresh session key and re-dispatches the coder; on attempt 2 (or
  // for any terminal disposition on attempt 1) the existing recovery handlers
  // below fire unchanged. Operator stops, context-exhausted, and quota-rejected
  // are all terminal and fall straight through — the loop is a thin guard, not a
  // redesign of the error-handling below it.
  let sessionKey = buildSessionKey(taskId)
  // TypeScript cannot statically prove the loop body runs at least once (attempt
  // starts at 1, condition 1 <= 2 is always true on the first check). The
  // definite-assignment assertion `!` is correct: `r` is always assigned before
  // any post-loop read.
  let r!: Awaited<ReturnType<typeof runWorkerWithSpan>>

  // Snapshot the worktree's uncommitted state on a fixed cadence while the
  // coder subprocess runs, independent of how (or whether) it ever exits
  // cleanly. A hard kill (watchdog timeout, context exhaustion, OOM) never
  // reaches an exit-time recovery hook, so without this the only work that
  // survives is whatever the coder itself already committed — observed
  // 2026-08-20: three `code:context-exhausted` failures in a row each left
  // 100+ uncommitted lines with zero commits ahead, recoverable only because
  // an operator happened to inspect the worktree by hand. This makes that
  // recovery automatic: see `startPeriodicCheckpoint` for the full rationale
  // and the no-op-on-clean-tree guarantee that keeps a normally-committing
  // coder unaffected.
  const periodicCheckpoint = startPeriodicCheckpoint({
    cwd: worktreePath,
    key: `${taskId}-code-periodic`,
    messagePrefix: `mars: periodic code-phase checkpoint (task ${taskId})`,
    traceCtx: buildPhaseCtx(trace, taskId, 'code'),
  })
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) sessionKey = buildSessionKey(taskId)
      r = await runWorkerWithSpan({
        worker,
        prompt: fullPrompt,
        runOptions: {
          cwd: worktreePath,
          sessionId: sessionKey,
          // A Worker that pins its own `config.systemPrompt` (currently only
          // RescueOperator) must receive it verbatim — resolveWorkerSystemPrompt
          // always returns the generic Coder standing instructions (ADR-0019),
          // which would otherwise silently displace it. Without this, a
          // RescueOperator dispatch never sees RESCUE_OPERATOR_SYSTEM_PROMPT
          // (its pinned "choose one of restart/continue/supersede, emit a JSON
          // verdict, never commit" brief) and instead runs under the generic
          // deviation-rules brief, which tells it to write and commit code —
          // exactly the behaviour that brief exists to forbid.
          systemPrompt: worker.config.systemPrompt ?? resolveWorkerSystemPrompt(primaryTag),
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
        stepName: 'run-agent',
        workflowInstanceId: trace.workflowInstanceId,
        originId,
        taskId,
        phase: 'code',
        // Fix (recovery) tasks run flagship so high-risk repair has the
        // strongest model available. Regular coder tasks inherit whatever
        // modelTier the caller declared (opts.modelTier); when absent the
        // Worker's own pinned tier applies.
        modelTier: kind === 'fix' ? 'flagship' : undefined,
      })

      // A task stop is an operator decision, not a coder failure. Bail out before
      // the ordinary non-zero-exit recovery path can stamp or recover the task;
      // the daemon already marked it failed with failureReason='cancelled'.
      if (ctx.signal.aborted) throw new Error(`task ${taskId} stopped by operator`)

      // Classify the exit. Operator abort is already handled above so `aborted`
      // is always false here — pass it explicitly for clarity and purity.
      const disposition = classifyCoderExitDisposition({ r, aborted: false })
      if (disposition.kind === 'retryable-transient' && attempt === 1) {
        // Environmental kill or startup failure before any provider contact. The
        // worktree is untouched so a single re-dispatch on a fresh session key is
        // safe. Record a trace event so the action-queue and reflect signals can
        // observe the retry before it happens.
        trace.traceStore
          .record({
            kind: 'code-retry-attempt',
            taskId,
            originId,
            phase: 'code',
            payload: { reason: disposition.reason, attempt: 2, sessionKey },
          })
          .catch(() => {
            // Telemetry is best-effort — a DB hiccup must never change the result.
          })
        continue
      }

      // Any other disposition (success, terminal-recovery on attempt 1, any exit
      // on attempt 2) falls through to the existing handlers below.
      break
    }
  } finally {
    // Stop the timer and await any in-flight capture before anything below
    // reads or commits this worktree (classifyCoderExit, the commit-contract
    // enforcement) — a periodic checkpoint never touches the branch or the
    // working tree, but a still-running capture and a fast-following
    // `git status`/`git commit` should never be allowed to race regardless.
    await periodicCheckpoint.stop()
  }

  await classifyCoderExit({
    r,
    taskId,
    store,
    branch,
    worktreePath,
    integrationBranch,
    trace,
    originId,
    sessionKey,
  })

  // Post-condition on a clean exit: the coder must hand over a committed,
  // clean worktree. Both the empty-diff guard and the two-stage dirty-tree
  // escalation live in `./coder-exit`; every task-state write they make still
  // goes through the `store` this shell owns (ADR-0052).
  const commitSource = await enforceCoderCommitContract({
    ctx,
    taskId,
    store,
    branch,
    worktreePath,
    integrationBranch,
    trace,
    originId,
    fullTask,
    worker,
    primaryTag,
    emit,
  })


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
  await recordSignals(taskId, 'run-agent', usage, store).catch(() => {
    // signal capture must never fail the task
  })

  return { sessionId: r.sessionId ?? null }
}
