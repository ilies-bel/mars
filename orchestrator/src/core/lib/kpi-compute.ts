import type { DomainTaskStore as TaskStore } from '../store/task-store.js'

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

export interface AutonomousCompletionRateResult {
  /** null when sampleCount === 0 (no done arcs in the window) */
  value: number | null
  /** Count of Arcs reaching done in the window (the denominator) */
  sampleCount: number
}

export interface RecoverySuccessRateResult {
  /** null when sampleCount === 0 (no recovery edges fired in window) */
  value: number | null
  /** Count of origin Tasks with a recovery Task that reached terminal status in-window */
  sampleCount: number
}

/**
 * The four token-usage fields used in the cache-weighted cost formula.
 * Matches the shape of signal rows and task totals throughout the codebase.
 */
export interface ClaudeUsage {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
}

/**
 * Compute the cache-weighted token cost for a single usage sample.
 *
 * Cache reads are priced at 0.1× because they are ~10× cheaper than other
 * token types. This is the single source-of-truth for the weighting constants
 * used across reflect-query.ts, deep-reflect-query.ts, and kpi-compute.ts.
 */
export function cacheWeightedTokens(usage: ClaudeUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreateTokens +
    usage.cacheReadTokens * 0.1
  )
}

export interface CostPerArcResult {
  /** null when sampleCount === 0 */
  p50: number | null
  /** null when sampleCount === 0 */
  p90: number | null
  /** Number of done Arcs contributing to the distribution */
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

/**
 * Return the linearly-interpolated value at fractional index `p * (n - 1)` of
 * a sorted array. Callers must ensure `sorted.length > 0`.
 */
function interpolatePercentile(sorted: readonly number[], p: number): number {
  const n = sorted.length
  const i = p * (n - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (i - lo) * (sorted[hi] - sorted[lo])
}

/**
 * Compute the p50 and p90 of the per-Arc cache-weighted token cost over the
 * given window.
 *
 * Only Arcs where at least one task reached status='done' are included (the
 * same arc-grouping logic as computeFailureRate). The window filter applies to
 * updated_at. Token signals come from the trace_events table (step_ended rows
 * with a usageSignals payload); arcs with no trace_events contribute 0 cost.
 *
 * Percentiles use linear interpolation on the sorted cost list.
 * When sampleCount === 0, both p50 and p90 are null.
 */
export async function computeCostPerArcDistribution(
  surface: TaskStore,
  window: KpiWindow,
): Promise<CostPerArcResult> {
  // One row per done Arc with the sum of all cache-weighted tokens across every
  // task in that Arc. done_arcs selects arcs where any task in the window
  // reached 'done'; the tasks join then collects ALL tasks for those arcs (not
  // just those inside the window) so the full cost is captured.
  const result = await surface.query({
    sql: `WITH done_arcs AS (
            SELECT COALESCE(origin_id, id) AS arc_id
            FROM tasks
            WHERE status IN ('done', 'failed')
              AND updated_at >= ?
              AND updated_at <= ?
            GROUP BY COALESCE(origin_id, id)
            HAVING MAX(CASE WHEN status = 'done' THEN 1 ELSE 0 END) = 1
          )
          SELECT
            da.arc_id,
            COALESCE(SUM(
              CAST(json_extract(te.payload, '$.usageSignals.inputTokens')        AS REAL) +
              CAST(json_extract(te.payload, '$.usageSignals.outputTokens')       AS REAL) +
              CAST(json_extract(te.payload, '$.usageSignals.cacheCreateTokens')  AS REAL) +
              CAST(json_extract(te.payload, '$.usageSignals.cacheReadTokens')    AS REAL) * 0.1
            ), 0) AS weighted_tokens
          FROM done_arcs da
          LEFT JOIN tasks t
            ON COALESCE(t.origin_id, t.id) = da.arc_id
          LEFT JOIN trace_events te
            ON te.task_id = t.id
           AND te.kind = 'step_ended'
           AND json_extract(te.payload, '$.usageSignals') IS NOT NULL
          GROUP BY da.arc_id`,
    args: [window.windowStart, window.windowEnd],
  })

  if (result.rows.length === 0) {
    return { p50: null, p90: null, sampleCount: 0 }
  }

  const costs = result.rows
    .map((row) => (row as unknown as { arc_id: string; weighted_tokens: number }).weighted_tokens)
    .sort((a, b) => a - b)

  return {
    p50: interpolatePercentile(costs, 0.5),
    p90: interpolatePercentile(costs, 0.9),
    sampleCount: costs.length,
  }
}

/**
 * Compute the autonomous completion rate over the given time window from the
 * queryable workflow surface (TaskStore).
 *
 * An Arc is "autonomous" iff ALL of the following hold:
 *   1. It reached done (has a task with status='done' in the window).
 *   2. No Task in its tree has a recovery edge (fix_for_task_id IS NOT NULL).
 *   3. No 'task-blocked' action-queue item was ever raised against any of its Tasks.
 *
 * autonomous_completion_rate = autonomous_done_arcs / total_done_arcs
 *
 * sampleCount = count of Arcs reaching done in the window (the denominator).
 * value is null when sampleCount === 0.
 *
 * NOTE: Condition 3 requires action_queue_items to be queryable via the same
 * TaskStore surface. In production, action_queue_items lives in state.db (a
 * separate database from queue.db). When the table is not found the inbox check
 * is silently skipped — condition 2 (recovery edge) remains fully enforced.
 */
export async function computeAutonomousCompletionRate(
  surface: TaskStore,
  window: KpiWindow,
): Promise<AutonomousCompletionRateResult> {
  // All arc IDs that reached 'done' within the window
  const doneArcsResult = await surface.query({
    sql: `SELECT COALESCE(origin_id, id) AS arc_id
          FROM tasks
          WHERE status = 'done'
            AND updated_at >= ?
            AND updated_at <= ?
          GROUP BY COALESCE(origin_id, id)`,
    args: [window.windowStart, window.windowEnd],
  })

  const sampleCount = doneArcsResult.rows.length
  if (sampleCount === 0) return { value: null, sampleCount: 0 }

  // Arc IDs disqualified by a recovery task (fix_for_task_id IS NOT NULL)
  const recoveryResult = await surface.query({
    sql: `SELECT DISTINCT COALESCE(origin_id, id) AS arc_id
          FROM tasks
          WHERE fix_for_task_id IS NOT NULL`,
    args: [],
  })
  const nonAutonomousByRecovery = new Set(
    recoveryResult.rows.map(r => (r as unknown as { arc_id: string }).arc_id),
  )

  // Arc IDs disqualified by a 'task-blocked' action-queue item
  let nonAutonomousByInbox = new Set<string>()
  try {
    const inboxResult = await surface.query({
      sql: `SELECT DISTINCT COALESCE(t.origin_id, t.id) AS arc_id
            FROM tasks t
            INNER JOIN action_queue_items a ON a.origin_task_id = t.id
            WHERE a.kind = 'task-blocked'`,
      args: [],
    })
    nonAutonomousByInbox = new Set(
      inboxResult.rows.map(r => (r as unknown as { arc_id: string }).arc_id),
    )
  } catch {
    // action_queue_items not in this store's database — inbox check skipped
  }

  const autonomousCount = doneArcsResult.rows.filter(r => {
    const arcId = (r as unknown as { arc_id: string }).arc_id
    return !nonAutonomousByRecovery.has(arcId) && !nonAutonomousByInbox.has(arcId)
  }).length

  return { value: autonomousCount / sampleCount, sampleCount }
}

/**
 * Compute the recovery success rate over the given time window.
 *
 * A "sample" is any recovery Task (fix_for_task_id IS NOT NULL) that reached
 * a terminal status (done or failed) within [windowStart, windowEnd]. Per
 * ADR-0035 there is at most one recovery attempt per origin failure.
 *
 * Success = recovery Task reached done AND its origin Task also reached done.
 * When a fix task reaches done, the daemon's markOriginDoneFromRecovery
 * propagation flips the origin row to done — so checking origin.status='done'
 * is the correct success condition.
 *
 * recovery_success_rate = successful_recoveries / total_recoveries_in_window
 *
 * value is null when sampleCount === 0.
 */
export async function computeRecoverySuccessRate(
  surface: TaskStore,
  window: KpiWindow,
): Promise<RecoverySuccessRateResult> {
  const result = await surface.query({
    sql: `SELECT
            t_origin.status AS origin_status,
            t_recovery.status AS recovery_status
          FROM tasks t_recovery
          INNER JOIN tasks t_origin
            ON t_origin.id = t_recovery.fix_for_task_id
          WHERE t_recovery.fix_for_task_id IS NOT NULL
            AND t_recovery.status IN ('done', 'failed')
            AND t_recovery.updated_at >= ?
            AND t_recovery.updated_at <= ?`,
    args: [window.windowStart, window.windowEnd],
  })

  const sampleCount = result.rows.length
  if (sampleCount === 0) return { value: null, sampleCount: 0 }

  let successCount = 0
  for (const row of result.rows) {
    const r = row as unknown as { origin_status: string; recovery_status: string }
    if (r.recovery_status === 'done' && r.origin_status === 'done') {
      successCount++
    }
  }

  return { value: successCount / sampleCount, sampleCount }
}
