import type { TaskStore } from './task-store.js'

/**
 * The time window over which KPI metrics are computed.
 * Both bounds are ISO-8601 timestamp strings.
 */
export interface KpiWindow {
  windowStart: string
  windowEnd: string
}

export interface FailureRateResult {
  /** null when sampleCount === 0 (no arcs to compute over) */
  value: number | null
  /** Total arcs (done + failed) in the window */
  sampleCount: number
}

/**
 * Compute the failure rate over the given time window from the queryable
 * workflow surface (TaskStore).
 *
 * An "Arc" is the group of tasks sharing the same COALESCE(origin_id, id).
 * An arc is "done" if any task in it reached status='done'; "failed" if all
 * terminal tasks are in status='failed'.
 *
 * failure_rate = failed_arcs / (done_arcs + failed_arcs)
 *
 * The window filter applies to updated_at (when the arc reached terminal
 * status), not created_at (when it was enqueued).
 */
export async function computeFailureRate(
  surface: TaskStore,
  window: KpiWindow,
): Promise<FailureRateResult> {
  // Aggregate per arc: has any task in the arc reached 'done'?
  const result = await surface.query({
    sql: `SELECT
            COALESCE(origin_id, id) AS arc_id,
            MAX(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS has_done
          FROM tasks
          WHERE status IN ('done', 'failed')
            AND updated_at >= ?
            AND updated_at <= ?
          GROUP BY COALESCE(origin_id, id)`,
    args: [window.windowStart, window.windowEnd],
  })

  let doneArcs = 0
  let failedArcs = 0

  for (const row of result.rows) {
    const r = row as unknown as { arc_id: string; has_done: number }
    if (r.has_done === 1) {
      doneArcs++
    } else {
      failedArcs++
    }
  }

  const sampleCount = doneArcs + failedArcs
  const value = sampleCount === 0 ? null : failedArcs / sampleCount

  return { value, sampleCount }
}
