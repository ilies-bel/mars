/**
 * Arc-alert resting-state predicate (ADR-0054 follow-up).
 *
 * The action queue is a level-triggered projection of arc state: an arc
 * raises EXACTLY ONE alert iff it is in a human-action-required RESTING
 * state. This module is the single pure derivation that decides that.
 *
 * Operator-confirmed invariant
 * ----------------------------
 * An arc raises an alert iff:
 *   - some task in the arc is `failed` AND no recovery task for that arc
 *     is currently in-flight (queued/triaging/running/verifying/merging), OR
 *   - some task in the arc is `blocked` on a DEAD blocker — the blocker's
 *     status is `failed` or `dropped` AND the blocker itself has no
 *     in-flight recovery on its own arc (the wedged "no recovery is
 *     coming" case, even when the dead blocker lives in a different arc).
 *
 * Every other arc-resting state suppresses the alert:
 *   - blocked-on-LIVE-recovery (a recovery is genuinely working it)
 *   - ongoing (running / verifying / merging / triaging)
 *   - any fix task itself queued/running/verifying/merging for the arc
 *     (recovery on the way)
 *   - resolved (done / dropped)
 *
 * Clear-by-mutation (ADR-0048): there is no dismiss gesture. An alert
 * clears only by construction — the underlying entity is mutated so this
 * predicate stops returning `true` for the arc. Re-failure re-derives.
 *
 * This module is pure: data in → boolean out. It performs no I/O and is
 * the single source of truth for the alert invariant. Callers wire it
 * to a data fetcher (the daemon: real stores; the test: literal rows).
 */

import type { TaskStatus, TaskKind } from '../queue'

/**
 * The statuses that count as "in-flight" — a worker is doing something on
 * this task right now. A recovery (fix) task in any of these statuses
 * means recovery is coming; the arc should NOT alert.
 *
 * NB: `under_investigation` is intentionally excluded — it is an operator
 * parking status, not a worker-running status. A task under investigation
 * is awaiting operator action, not awaiting a recovery worker.
 */
export const IN_FLIGHT_STATUSES: readonly TaskStatus[] = [
  'queued',
  'triaging',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
]

const IN_FLIGHT_SET = new Set<TaskStatus>(IN_FLIGHT_STATUSES)

/** A task in `failed` or `dropped` is DEAD — terminal-without-success. */
export const DEAD_STATUSES: readonly TaskStatus[] = ['failed', 'dropped']
const DEAD_SET = new Set<TaskStatus>(DEAD_STATUSES)

/**
 * One task in an arc, with the minimum fields the predicate needs to
 * decide alert vs. suppress. Callers populate this from their task store
 * (the daemon) or from literal rows (tests).
 */
export interface ArcTaskRow {
  id: string
  status: TaskStatus
  kind: TaskKind
  /**
   * For recovery tasks (`kind === 'fix'`): the origin task this recovery
   * is fixing. Null for origin / non-recovery rows. A recovery task is
   * considered "in-flight on the arc" iff its `fixForTaskId` matches a
   * task in the arc AND its `status` is in {@link IN_FLIGHT_STATUSES}.
   */
  fixForTaskId: string | null
}

/**
 * One blocker edge originating from a task in the arc. `blockedTaskId` is
 * a task in THIS arc (always blocked-status). `blockerTaskId` is the task
 * it is waiting on — which may live in this arc OR in a different arc.
 *
 * `blockerHasInFlightRecovery` answers the cross-arc question: "is a fix
 * task currently in-flight that targets the blocker?" — supplied by the
 * caller because the predicate is pure and the cross-arc lookup needs
 * the world view (every fix-task row, not just this arc's rows).
 */
export interface ArcBlockerEdge {
  blockedTaskId: string
  blockerTaskId: string
  blockerStatus: TaskStatus
  blockerHasInFlightRecovery: boolean
}

/**
 * The minimum slice of arc state the alert predicate needs. Constructed
 * by the daemon from the task store; constructed by tests as literals.
 */
export interface ArcRestingState {
  arcId: string
  /** Every task in the arc — origin first, then recovery descendants. */
  tasks: readonly ArcTaskRow[]
  /** Blocker edges out of any task in the arc. */
  blockerEdges: readonly ArcBlockerEdge[]
}

/**
 * Does the arc have any recovery task currently in-flight? This is the
 * "recovery is coming" gate — suppresses the alert when true.
 *
 * A recovery task counts iff its `fixForTaskId` matches one of the arc's
 * task ids AND its status is in {@link IN_FLIGHT_STATUSES}.
 */
const hasInFlightRecovery = (state: ArcRestingState): boolean => {
  const arcTaskIds = new Set(state.tasks.map((t) => t.id))
  return state.tasks.some(
    (t) =>
      t.kind === 'fix' &&
      t.fixForTaskId !== null &&
      arcTaskIds.has(t.fixForTaskId) &&
      IN_FLIGHT_SET.has(t.status),
  )
}

/**
 * Does the arc have any `failed` task? Includes origin failures AND
 * failed recovery tasks (a failed fix is terminal — ADR-0061 — so its
 * arc must alert).
 */
const hasFailedTask = (state: ArcRestingState): boolean =>
  state.tasks.some((t) => t.status === 'failed')

/**
 * Does the arc have at least one `blocked` task waiting on a DEAD blocker
 * whose own arc has no recovery coming? This is the wedged / "no recovery
 * is coming" case, possibly cross-arc.
 *
 * A blocker edge counts as dead-wedged iff:
 *   - the blocked task is currently in `blocked` status, AND
 *   - the blocker's status is in {@link DEAD_STATUSES}, AND
 *   - the blocker does NOT have an in-flight recovery of its own
 *     (`blockerHasInFlightRecovery === false`).
 */
const hasDeadBlockedEdge = (state: ArcRestingState): boolean => {
  const blockedTaskIds = new Set(
    state.tasks.filter((t) => t.status === 'blocked').map((t) => t.id),
  )
  return state.blockerEdges.some(
    (e) =>
      blockedTaskIds.has(e.blockedTaskId) &&
      DEAD_SET.has(e.blockerStatus) &&
      !e.blockerHasInFlightRecovery,
  )
}

/**
 * The single PURE Alert-invariant derivation. Returns `true` iff the arc
 * is in a human-action-required resting state per the invariant above.
 *
 * Conjuncts (alert iff at least one of):
 *   - failed-without-recovery: some task is `failed` AND no fix is in-flight.
 *   - dead-blocker-wedged: some task is `blocked` on a dead blocker whose
 *     own arc has no in-flight recovery (cross-arc included).
 *
 * Otherwise: no alert (transient, ongoing, or resolved).
 */
export const arcRaisesAlert = (state: ArcRestingState): boolean => {
  // Empty arc (no tasks at all) cannot alert — there is nothing to be
  // failed or blocked.
  if (state.tasks.length === 0) return false

  const recoveryComing = hasInFlightRecovery(state)

  // Failed-without-recovery: if any task in the arc is `failed` and no
  // fix is currently in-flight for the arc, the arc alerts. (A failed
  // fix that has its own follow-up in-flight is suppressed; a fix that
  // succeeded should have flipped its origin to `done` via
  // Arc.propagateRecoveryDone, so the origin would no longer be `failed`.)
  if (hasFailedTask(state) && !recoveryComing) return true

  // Dead-blocker-wedged: a task waiting on a dead blocker that itself
  // has no recovery coming. This holds even cross-arc — the blocked arc
  // raises ITS OWN single card because nobody is fixing the upstream.
  if (hasDeadBlockedEdge(state)) return true

  return false
}
