import { randomUUID } from 'node:crypto'
import { computeFailureRate, computeCostPerArcDistribution, type KpiWindow } from './kpi-compute.js'
import { getDefaultTaskStore, type TaskStore } from './task-store.js'

/**
 * One persisted row in the kpi_snapshots table. Columns for KPIs not yet
 * implemented (cost_per_arc_*, autonomous_completion_rate,
 * recovery_success_rate) are NULL in this slice and will be filled by later
 * slices.
 *
 * ADR-0038 explicitly forbids a composite/rollup health-score column —
 * this interface has none.
 */
export interface KpiSnapshot {
  id: string
  taken_at: string
  window_start: string
  window_end: string
  sample_count: number
  /** 1 when sample_count < sampleFloor; 0 otherwise */
  low_confidence: number
  cost_per_arc_p50: number | null
  cost_per_arc_p90: number | null
  failure_rate: number | null
  autonomous_completion_rate: number | null
  recovery_success_rate: number | null
}

interface TakeKpiSnapshotOpts {
  /** The queryable workflow surface to read Arc data from */
  surface: TaskStore
  /** ISO-8601 timestamp marking the end of the window (and taken_at) */
  now: string
  /** Window length in days; defaults to 7 */
  windowDays?: number
  /** Minimum sample count before low_confidence is set; defaults to 5 */
  sampleFloor?: number
}

/**
 * Compute a KPI window snapshot, persist exactly one row to kpi_snapshots,
 * and return the persisted row.
 *
 * Only failure_rate is populated in this slice; all other KPI columns are NULL.
 */
export async function takeKpiSnapshot(
  opts: TakeKpiSnapshotOpts,
): Promise<KpiSnapshot> {
  const { surface, now, windowDays = 7, sampleFloor = 5 } = opts

  const windowEnd = now
  const windowStartMs =
    new Date(now).getTime() - windowDays * 24 * 60 * 60 * 1000
  const windowStart = new Date(windowStartMs).toISOString()

  const window: KpiWindow = { windowStart, windowEnd }
  const { value: failureRate, sampleCount } = await computeFailureRate(
    surface,
    window,
  )
  const { p50: costP50, p90: costP90 } = await computeCostPerArcDistribution(
    surface,
    window,
  )

  const snapshot: KpiSnapshot = {
    id: randomUUID(),
    taken_at: now,
    window_start: windowStart,
    window_end: windowEnd,
    sample_count: sampleCount,
    low_confidence: sampleCount < sampleFloor ? 1 : 0,
    cost_per_arc_p50: costP50,
    cost_per_arc_p90: costP90,
    failure_rate: failureRate,
    autonomous_completion_rate: null,
    recovery_success_rate: null,
  }

  await surface.execute({
    sql: `INSERT INTO kpi_snapshots (
            id, taken_at, window_start, window_end,
            sample_count, low_confidence,
            cost_per_arc_p50, cost_per_arc_p90,
            failure_rate, autonomous_completion_rate, recovery_success_rate
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      snapshot.id,
      snapshot.taken_at,
      snapshot.window_start,
      snapshot.window_end,
      snapshot.sample_count,
      snapshot.low_confidence,
      snapshot.cost_per_arc_p50,
      snapshot.cost_per_arc_p90,
      snapshot.failure_rate,
      snapshot.autonomous_completion_rate,
      snapshot.recovery_success_rate,
    ],
  })

  return snapshot
}

/**
 * Return the most-recently-taken kpi_snapshots row, or null if none exists.
 * Accepts an optional TaskStore for test injection; defaults to the
 * production default store.
 */
export async function readLatestKpiSnapshot(
  store?: TaskStore,
): Promise<KpiSnapshot | null> {
  const s = store ?? (await getDefaultTaskStore())
  const result = await s.query({
    sql: `SELECT id, taken_at, window_start, window_end,
                 sample_count, low_confidence,
                 cost_per_arc_p50, cost_per_arc_p90,
                 failure_rate, autonomous_completion_rate, recovery_success_rate
          FROM kpi_snapshots
          ORDER BY taken_at DESC
          LIMIT 1`,
    args: [],
  })

  if (result.rows.length === 0) return null

  const row = result.rows[0] as unknown as {
    id: string
    taken_at: string
    window_start: string
    window_end: string
    sample_count: number
    low_confidence: number
    cost_per_arc_p50: number | null
    cost_per_arc_p90: number | null
    failure_rate: number | null
    autonomous_completion_rate: number | null
    recovery_success_rate: number | null
  }

  return {
    id: row.id,
    taken_at: row.taken_at,
    window_start: row.window_start,
    window_end: row.window_end,
    sample_count: row.sample_count,
    low_confidence: row.low_confidence,
    cost_per_arc_p50: row.cost_per_arc_p50,
    cost_per_arc_p90: row.cost_per_arc_p90,
    failure_rate: row.failure_rate,
    autonomous_completion_rate: row.autonomous_completion_rate,
    recovery_success_rate: row.recovery_success_rate,
  }
}
