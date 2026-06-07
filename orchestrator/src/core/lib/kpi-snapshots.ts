import { randomUUID } from 'node:crypto'
import {
  computeAutonomousCompletionRate,
  computeCostPerArcDistribution,
  computeFailureRate,
  computeRecoverySuccessRate,
  type KpiWindow,
} from './kpi-compute.js'
import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from '../store/task-store.js'

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

export type KpiDeltaEntry = { value: number | null; lowConfidenceSuppressed: boolean }

/**
 * Per-KPI deltas between a current and prior window snapshot.
 * A delta is suppressed (value=null, lowConfidenceSuppressed=true) when either
 * window's low_confidence flag is set. When prior is absent,
 * lowConfidenceSuppressed is false — there is simply no comparison to make.
 *
 * ADR-0038: no composite/rollup field is emitted here.
 */
export interface KpiDeltas {
  failure_rate: KpiDeltaEntry
  autonomous_completion_rate: KpiDeltaEntry
  recovery_success_rate: KpiDeltaEntry
  cost_per_arc_p50: KpiDeltaEntry
  cost_per_arc_p90: KpiDeltaEntry
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
 * Populates failure_rate and autonomous_completion_rate; cost_per_arc_* and
 * recovery_success_rate are NULL and will be filled by later slices.
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
  const { value: autonomousCompletionRate } = await computeAutonomousCompletionRate(
    surface,
    window,
  )
  const { value: recoverySuccessRate } = await computeRecoverySuccessRate(surface, window)

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
    autonomous_completion_rate: autonomousCompletionRate,
    recovery_success_rate: recoverySuccessRate,
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

function rowToSnapshot(raw: unknown): KpiSnapshot {
  const r = raw as {
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
    id: r.id,
    taken_at: r.taken_at,
    window_start: r.window_start,
    window_end: r.window_end,
    sample_count: r.sample_count,
    low_confidence: r.low_confidence,
    cost_per_arc_p50: r.cost_per_arc_p50,
    cost_per_arc_p90: r.cost_per_arc_p90,
    failure_rate: r.failure_rate,
    autonomous_completion_rate: r.autonomous_completion_rate,
    recovery_success_rate: r.recovery_success_rate,
  }
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
  return rowToSnapshot(result.rows[0])
}

export interface KpiSeriesPoint {
  takenAt: string
  value: number | null
}

export interface KpiSeries {
  failure_rate: KpiSeriesPoint[]
  autonomous_completion_rate: KpiSeriesPoint[]
  recovery_success_rate: KpiSeriesPoint[]
  cost_per_arc_p50: KpiSeriesPoint[]
}

/**
 * Return the last `limit` kpi_snapshots rows ordered oldest-first as per-column
 * time-series arrays. Accepts an optional store for test injection; defaults to
 * the production default store.
 *
 * Uses a subquery to select the most-recent N rows (ORDER BY taken_at DESC
 * LIMIT ?) then re-orders them ascending so callers always receive
 * oldest-first data.
 */
export async function readKpiSeries(opts: {
  limit?: number
  store?: TaskStore
}): Promise<KpiSeries> {
  const { limit = 90, store: injectedStore } = opts
  const s = injectedStore ?? (await getDefaultTaskStore())

  const result = await s.query({
    sql: `SELECT taken_at, failure_rate, autonomous_completion_rate,
                 recovery_success_rate, cost_per_arc_p50
          FROM (
            SELECT taken_at, failure_rate, autonomous_completion_rate,
                   recovery_success_rate, cost_per_arc_p50
            FROM kpi_snapshots
            ORDER BY taken_at DESC
            LIMIT ?
          )
          ORDER BY taken_at ASC`,
    args: [limit],
  })

  const series: KpiSeries = {
    failure_rate: [],
    autonomous_completion_rate: [],
    recovery_success_rate: [],
    cost_per_arc_p50: [],
  }

  for (const raw of result.rows) {
    const r = raw as unknown as {
      taken_at: string
      failure_rate: number | null
      autonomous_completion_rate: number | null
      recovery_success_rate: number | null
      cost_per_arc_p50: number | null
    }
    series.failure_rate.push({ takenAt: r.taken_at, value: r.failure_rate })
    series.autonomous_completion_rate.push({ takenAt: r.taken_at, value: r.autonomous_completion_rate })
    series.recovery_success_rate.push({ takenAt: r.taken_at, value: r.recovery_success_rate })
    series.cost_per_arc_p50.push({ takenAt: r.taken_at, value: r.cost_per_arc_p50 })
  }

  return series
}

const KPI_KEYS: ReadonlyArray<keyof KpiDeltas> = [
  'failure_rate',
  'autonomous_completion_rate',
  'recovery_success_rate',
  'cost_per_arc_p50',
  'cost_per_arc_p90',
]

function buildDeltas(
  current: KpiSnapshot | null,
  prior: KpiSnapshot | null,
): KpiDeltas {
  const deltas = {} as KpiDeltas
  for (const key of KPI_KEYS) {
    if (current === null || prior === null) {
      deltas[key] = { value: null, lowConfidenceSuppressed: false }
    } else if (current.low_confidence === 1 || prior.low_confidence === 1) {
      deltas[key] = { value: null, lowConfidenceSuppressed: true }
    } else {
      const cv = current[key] as number | null
      const pv = prior[key] as number | null
      deltas[key] = {
        value: cv !== null && pv !== null ? cv - pv : null,
        lowConfidenceSuppressed: false,
      }
    }
  }
  return deltas
}

const SNAPSHOT_COLS = `id, taken_at, window_start, window_end,
               sample_count, low_confidence,
               cost_per_arc_p50, cost_per_arc_p90,
               failure_rate, autonomous_completion_rate, recovery_success_rate`

/**
 * Return the current and immediately preceding KPI window snapshots, plus
 * per-KPI deltas (current - prior).
 *
 * • current: latest snapshot whose window_end <= now
 * • prior:   latest snapshot whose window_end <= current.window_start
 *
 * A delta is suppressed (value=null, lowConfidenceSuppressed=true) when either
 * side has low_confidence=1. When prior is absent, all deltas are
 * value=null, lowConfidenceSuppressed=false.
 */
export async function readKpiWindowComparison(opts: {
  now: string
  windowDays?: number
  store?: TaskStore
}): Promise<{ current: KpiSnapshot | null; prior: KpiSnapshot | null; deltas: KpiDeltas }> {
  const { now, store: injectedStore } = opts
  const s = injectedStore ?? (await getDefaultTaskStore())

  const currentResult = await s.query({
    sql: `SELECT ${SNAPSHOT_COLS} FROM kpi_snapshots
          WHERE window_end <= ?
          ORDER BY window_end DESC, taken_at DESC
          LIMIT 1`,
    args: [now],
  })

  const current =
    currentResult.rows.length === 0 ? null : rowToSnapshot(currentResult.rows[0])

  if (current === null) {
    return { current: null, prior: null, deltas: buildDeltas(null, null) }
  }

  const priorResult = await s.query({
    sql: `SELECT ${SNAPSHOT_COLS} FROM kpi_snapshots
          WHERE window_end <= ?
          ORDER BY window_end DESC, taken_at DESC
          LIMIT 1`,
    args: [current.window_start],
  })

  const prior =
    priorResult.rows.length === 0 ? null : rowToSnapshot(priorResult.rows[0])

  return { current, prior, deltas: buildDeltas(current, prior) }
}
