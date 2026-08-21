/**
 * The `awaitHuman` primitive shell — the manual / live-step park.
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). Framework-owned:
 * the park writes `current_step_name` / `current_step_guide` through
 * `ctx.services.store` (the Arc aggregate, ADR-0052) and raises the
 * action-queue row before throwing the terminal sentinel.
 */
import { type DomainTaskStore as TaskStore } from '../../core/store/task-store'
import { parkTaskForHuman } from '../../core/lib/park-for-human'
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
 * **The two park paths are being collapsed into one.** PRD
 * ae17340a-modular-core-program-make-every-mars-mod slice 27 requires that a
 * task needing a human parks through exactly one mechanism. That work is
 * sequenced as three bounded tasks, in order:
 *
 *   1. `mars-f19f0ecd` — extract the duplicated `updateTask` +
 *      `raiseActionQueueItem` park body shared by the sentinel branch below
 *      and the daemon's `onManualPark` hook into one helper. No behaviour
 *      change, no dispatch change.
 *   2. `mars-18e6e0b5` — carry `previewUrl`/`logPath` through `onManualPark`
 *      so the guard at the promise-path branch below can collapse to a bare
 *      `ctx.services.onManualPark != null`. The preview payload gap is the
 *      only reason a daemon-backed run still takes the sentinel path.
 *   3. `mars-9dd152c7` — delete the sentinel-throw fallback and
 *      `AWAIT_HUMAN_MESSAGE`, and make `onManualPark` required (test and
 *      scaffolded contexts get a default implementation rather than an
 *      escape hatch).
 *
 * Note for step 3: `AWAIT_HUMAN_SENTINEL` is NOT the throw sentinel despite
 * the name — it is the *lease-owner* value both paths write, and it survives
 * the unification. `AWAIT_HUMAN_MESSAGE` is the one that goes away.
 *
 * The "exactly one action-queue row + exactly one durable event" invariant all
 * three steps must preserve is pinned by
 * `core/lib/__tests__/unified-park.test.ts`.
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

  // Auto re-lease + updateTask + raise the action-queue row — the body
  // shared with server.ts's onManualPark hook (core/lib/park-for-human.ts).
  await parkTaskForHuman(taskId, stepName, note, store, {
    variant: 'sentinel',
    raisedBy: 'primitive:await-human',
    previewUrl: opts.previewUrl,
    logPath: opts.logPath,
  })

  // Throw the sentinel so the daemon can:
  // 1. Detect the park and suppress the failure write/emit (task is
  //    intentionally parked, not failed).
  // 2. Patch this step's workflow_step_runs record to 'completed' so the
  //    engine short-circuits it on the next re-dispatch — no double-park,
  //    no double-notify, even after a daemon restart.
  throw new WorkflowTerminalError('await-human', AWAIT_HUMAN_MESSAGE(taskId, stepName), { stepName })
}
