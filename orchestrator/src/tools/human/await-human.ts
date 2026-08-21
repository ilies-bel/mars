/**
 * The `awaitHuman` primitive shell — the manual / live-step park.
 *
 * Split out of `workflows/primitives/index.ts` (TARGET §2.1). Framework-owned:
 * the park writes `current_step_name` / `current_step_guide` through
 * `ctx.services.store` (the Arc aggregate, ADR-0052) and raises the
 * action-queue row. Since slice 27 this is a thin delegation to
 * `ctx.services.onManualPark` — the single park mechanism.
 */
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
 * **One park mechanism.** PRD ae17340a-modular-core-program-make-every-mars-mod
 * slice 27 collapsed the two park paths into one: `awaitHuman` delegates to
 * `ctx.services.onManualPark`, which is required and always present (the
 * daemon injects its lease/re-dispatch-wired version; every other services bag
 * gets `createDefaultManualPark(store)`). The sentinel-throw fallback and its
 * `AWAIT_HUMAN_MESSAGE` are deleted.
 *
 * Note: `AWAIT_HUMAN_SENTINEL` is NOT that throw sentinel despite the name —
 * it is the *lease-owner* value the park writes, and it survives.
 *
 * The "exactly one action-queue row + exactly one durable event" invariant is
 * pinned by `core/lib/__tests__/unified-park.test.ts`.
 *
 * **Behaviour:**
 *   1. Transitions the task to `'awaiting-human'` via `updateTask` (Arc
 *      funnel, ADR-0052) and raises an `'awaiting-human'` action-queue row so
 *      the operator sees it immediately.
 *   2. Suspends in-process on `awaitManualDone(runId, stepName)` until the
 *      operator runs `mars step done`, which calls `resolveManualStep`. The
 *      step then returns normally and `runStep` checkpoints it `'completed'`
 *      itself — no sentinel throw, no step-record patch.
 *   3. If the daemon restarts while parked the in-memory promise is gone;
 *      `handleStepDone` Path 2 and `handleReleaseLease` patch the step to
 *      `'completed'` before re-queuing, so the engine short-circuits it on
 *      re-dispatch without re-parking or double-notifying.
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
  // The step name is half the resume key: `mars step done` resolves the
  // pending promise by (runId, stepName), which makes the park idempotent.
  const stepName = ctx.currentStep?.name ?? 'await-human'

  // The single park path. onManualPark parks the task and suspends until the
  // operator signals completion; previewUrl/logPath (the local-preview QA
  // gate) ride along into the raised row's payload — see
  // `LeaseParkPayload.previewUrl` / `.logPath`.
  return ctx.services.onManualPark({
    runId: ctx.runId,
    taskId,
    stepName,
    guide: note,
    previewUrl: opts.previewUrl ?? null,
    logPath: opts.logPath ?? null,
  })
}
