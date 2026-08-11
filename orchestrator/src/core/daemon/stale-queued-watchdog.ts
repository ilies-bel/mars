/**
 * Stale-queued watchdog — raises an action-queue alert when a task has been
 * sitting in `status='queued'` past a configurable threshold (default 10 min)
 * despite the daemon being healthy.
 *
 * This catches a dispatcher stall: a bug or deadlock means `drain()` is not
 * being called even though an implement slot is available. A saturated pool is
 * healthy throttling and must not create action-queue noise.
 *
 * The alert payload carries `activeWorkerCount`, `queueDepth`, and
 * `dispatchDecisionSummary` so the operator can distinguish between the two
 * cases at a glance.
 *
 * Duplicate suppression: `raiseActionQueueItem` deduplicates on the fingerprint
 * `sha1('stale-queued:<taskId>')`, so repeated sweeps while the task remains
 * queued bump `seen_count` on the existing row rather than spawning siblings.
 *
 * Dispatch-pause awareness: when the dispatcher is deliberately paused (operator,
 * storm, quota, or baseline), queued tasks are expected — the alert is suppressed
 * entirely. The staleness clock restarts from the moment dispatch resumes, so
 * tasks do not immediately alert for time spent legitimately parked.
 */

import type { DispatchPauseState } from './pause-state'

/** Default stale-queued threshold: 10 minutes. */
export const DEFAULT_STALE_QUEUED_MS = 10 * 60_000

export interface StaleQueuedSweepDeps {
  /** Number of worker slots currently occupied (from tracker.inFlightCount()). */
  activeWorkerCount: number
  /** Current implement semaphore limit, including steward runtime adjustments. */
  implementCap: number
  /** Total number of tasks currently in 'queued' status. */
  queueDepth: number
  /**
   * Recent dispatch-decision log entries (e.g. the last 5 skip/select messages
   * from the dispatcher). Pass an empty array when no ring buffer is wired up.
   */
  dispatchDecisionSummary: string[]
  /**
   * Current dispatch pause state. When paused for any reason (operator, storm,
   * quota, baseline), queued tasks are expected — no stale-queued alert is raised.
   * Omit or leave undefined to treat dispatch as running.
   */
  dispatchPauseState?: DispatchPauseState
  /**
   * Unix timestamp (ms) of the most recent dispatch resume. When provided,
   * the staleness clock starts from `max(task.updatedAt, dispatchResumedAt)`,
   * so tasks that spent time legitimately parked during a pause are not
   * immediately flagged as stale when dispatch resumes.
   */
  dispatchResumedAt?: number
  /** Override current timestamp for testing. */
  nowMs?: number
}

/**
 * Sweep for tasks that have been in `status='queued'` longer than
 * `MARS_STALE_QUEUED_MS` (default 10 min) and raise a `stale-queued`
 * action-queue alert for each one not already alerted-on. The twenty oldest
 * alerts are raised individually; a separate summary makes any remainder
 * visible without flooding the human-facing queue.
 *
 * @returns IDs of tasks for which a new or bumped alert was raised.
 */
/**
 * No-op sweep: stale-queued rows are now derived on read from
 * `tasks WHERE status='queued' AND age > threshold`.  This function is kept
 * as a stub so call sites in server.ts compile without change.
 */
export const runStaleQueuedSweep = async (
  _deps: StaleQueuedSweepDeps,
): Promise<{ alerted: string[] }> => {
  return { alerted: [] }
}
