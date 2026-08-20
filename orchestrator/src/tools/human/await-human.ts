/**
 * The `awaitHuman` primitive shell — the manual / live-step park.
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). Framework-owned:
 * the park writes `current_step_name` / `current_step_guide` through
 * `ctx.services.store` (the Arc aggregate, ADR-0052) and raises the
 * action-queue row before throwing the terminal sentinel.
 */
import { getTask, updateTask } from '../../core/queue'
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { AWAIT_HUMAN_SENTINEL } from '../../core/lib/sentinels'
import { AWAIT_HUMAN_MESSAGE } from '../../workflows/primitives/shared'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { type MarsCtx, resolveTaskId } from '../context'
import { validationRecorder } from '../validate-recorder'

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

  // ── Promise-based path (preferred) ────────────────────────────────────────
  // When the daemon injects an onManualPark hook AND no preview opts are set,
  // delegate to it so the workflow suspends in-process until `mars step done`
  // calls resolveManualStep(). The step record is then written as 'completed'
  // by runStep when the step fn returns — no sentinel throw needed, no patch.
  //
  // If the daemon restarts while parked, the in-memory promise is gone.
  // handleStepDone Path 2 and handleReleaseLease patch the step to 'completed'
  // before re-queuing, so the engine short-circuits on re-dispatch without
  // re-parking.
  //
  // Fall through to the sentinel path when previewUrl/logPath are set (the
  // local-preview QA path calls awaitHuman with those opts; onManualPark's
  // action-queue row doesn't carry them, so the richer payload below is needed).
  if (ctx.services.onManualPark != null && opts.previewUrl == null && opts.logPath == null) {
    return ctx.services.onManualPark({
      runId: ctx.runId,
      taskId,
      stepName,
      guide: note,
    })
  }

  // ── Sentinel-throw fallback ─────────────────────────────────────────────────
  // No onManualPark hook (standalone workflow, test context without daemon), or
  // preview opts are set (local-preview QA gate needs previewUrl/logPath in
  // the action-queue payload). Park manually and throw the sentinel.
  //
  // The daemon's 'await-human' result handler patches this step's record to
  // 'completed' (~server.ts:1871). handleStepDone Path 2 and handleReleaseLease
  // also patch on re-queue, covering the daemon-restart window.
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
      situation: 'lease-park',
      taskId,
      leaseOwner,
      leasedAt: now,
      leaseNote: note ?? null,
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
