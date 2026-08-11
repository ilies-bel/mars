/**
 * Fix route handler for the Steward's scheduled health pass.
 *
 * When a check with route='fix' returns a finding, this module decides whether
 * to enqueue a repair task or skip because one is already in flight.
 *
 * The dedup guard is application-level (SELECT before INSERT). The
 * tasks.finding_key UNIQUE partial index (status NOT IN ('done','dropped','failed'))
 * acts as a race-safe backstop: a concurrent pass that slips through the
 * application check still hits the constraint.
 */

// ── Deps ──────────────────────────────────────────────────────────────────────

/**
 * Injectable dependencies for the fix route. Both functions are bounded by the
 * caller (Steward, test) so the route handler itself is stateless and testable
 * without a live database.
 */
export interface FixRouteDeps {
  /**
   * Return true when a task with this findingKey already exists in a
   * non-terminal status (queued/running/verifying/merging/…). The check guards
   * against enqueueing a duplicate task on every scheduled pass while the first
   * fix is still in progress.
   */
  hasActiveTaskForFinding(findingKey: string): Promise<boolean>

  /**
   * Enqueue a repair task for the given finding. Called only when
   * hasActiveTaskForFinding returns false.
   *
   * Returns the new task's id so the caller can surface it in the pass summary.
   */
  enqueueFixTask(params: {
    findingKey: string
    checkId: string
    detail: string | undefined
  }): Promise<string>
}

// ── Result ────────────────────────────────────────────────────────────────────

type FixRouteAction = 'enqueued' | 'already-active' | 'no-finding-key'

export interface FixRouteResult {
  /** What the route decided to do. */
  readonly action: FixRouteAction
  /** Task id set only when action === 'enqueued'. */
  readonly taskId?: string
  /** The findingKey that was resolved (absent when action === 'no-finding-key'). */
  readonly findingKey?: string
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Route one fix-route finding.
 *
 * - When the check outcome has no findingKey, action='no-finding-key'.
 * - When a task with that findingKey is already active, action='already-active'.
 * - Otherwise, enqueues and returns action='enqueued' with the new task id.
 */
export async function routeFixFinding(params: {
  findingKey: string | undefined
  detail: string | undefined
  checkId: string
}, deps: FixRouteDeps): Promise<FixRouteResult> {
  const { findingKey, detail, checkId } = params
  if (!findingKey) {
    return { action: 'no-finding-key' }
  }
  const active = await deps.hasActiveTaskForFinding(findingKey)
  if (active) {
    return { action: 'already-active', findingKey }
  }
  const taskId = await deps.enqueueFixTask({ findingKey, checkId, detail })
  return { action: 'enqueued', taskId, findingKey }
}
