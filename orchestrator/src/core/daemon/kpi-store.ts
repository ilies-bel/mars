/**
 * KPI read layer for the daemon's GET /kpis route.
 *
 * Reads the latest persisted window comparison from the kpi_snapshots table
 * (written by the periodic KPI snapshot job) and maps it to the four-KPI
 * vector defined in ADR-0040 (harness health as a four-KPI vector).
 *
 * When no snapshot has been taken yet (empty table), all KPIs are returned
 * with currentValue:0, delta:0, sampleCount:0, lowConfidence:true — the UI
 * renders them in a low-confidence state with no drift arrows.
 *
 * Mapping from snapshot columns:
 *   cost_per_arc              ← cost_per_arc_p50 (median; p90 is persisted but not surfaced here)
 *   failure_rate              ← failure_rate
 *   autonomous_completion_rate ← autonomous_completion_rate
 *   recovery_success_rate     ← recovery_success_rate
 *
 * lowConfidence is true when low_confidence === 1 OR when the column is NULL.
 * delta is only emitted when both windows are high-confidence and non-null.
 */

import { readKpiWindowComparison, type KpiSnapshot } from '../lib/kpi-snapshots.js'
import {
  listAutonomousArcs,
  listCostPerArcArcs,
  listFailureRateArcs,
  listRecoveryArcs,
  type KpiArcRow,
  type KpiWindow,
} from '../lib/kpi-compute.js'
import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from '../store/task-store.js'

export type { KpiArcRow }

export type KpiKey =
  | 'cost_per_arc'
  | 'failure_rate'
  | 'autonomous_completion_rate'
  | 'recovery_success_rate'

export interface KpiRecord {
  key: KpiKey
  currentValue: number
  priorValue: number
  delta: number
  sampleCount: number
  lowConfidence: boolean
}

const KPI_KEYS: KpiKey[] = [
  'cost_per_arc',
  'failure_rate',
  'autonomous_completion_rate',
  'recovery_success_rate',
]

/** Column on KpiSnapshot that corresponds to each KpiKey's value. */
type SnapshotCol = keyof Pick<
  KpiSnapshot,
  | 'cost_per_arc_p50'
  | 'failure_rate'
  | 'autonomous_completion_rate'
  | 'recovery_success_rate'
>

const KPI_SNAPSHOT_COL: Record<KpiKey, SnapshotCol> = {
  cost_per_arc: 'cost_per_arc_p50',
  failure_rate: 'failure_rate',
  autonomous_completion_rate: 'autonomous_completion_rate',
  recovery_success_rate: 'recovery_success_rate',
}

/** Column on KpiSnapshot that carries each KpiKey's low_confidence flag. */
type SnapshotConfidenceCol = keyof Pick<
  KpiSnapshot,
  | 'cost_per_arc_low_confidence'
  | 'failure_rate_low_confidence'
  | 'autonomous_completion_rate_low_confidence'
  | 'recovery_success_rate_low_confidence'
>

const KPI_CONFIDENCE_COL: Record<KpiKey, SnapshotConfidenceCol> = {
  cost_per_arc: 'cost_per_arc_low_confidence',
  failure_rate: 'failure_rate_low_confidence',
  autonomous_completion_rate: 'autonomous_completion_rate_low_confidence',
  recovery_success_rate: 'recovery_success_rate_low_confidence',
}

/** Column on KpiSnapshot that carries each KpiKey's sample count. */
type SnapshotSampleCol = keyof Pick<
  KpiSnapshot,
  | 'cost_per_arc_sample_count'
  | 'failure_rate_sample_count'
  | 'autonomous_completion_rate_sample_count'
  | 'recovery_success_rate_sample_count'
>

const KPI_SAMPLE_COL: Record<KpiKey, SnapshotSampleCol> = {
  cost_per_arc: 'cost_per_arc_sample_count',
  failure_rate: 'failure_rate_sample_count',
  autonomous_completion_rate: 'autonomous_completion_rate_sample_count',
  recovery_success_rate: 'recovery_success_rate_sample_count',
}

const ZERO_RECORD = (key: KpiKey): KpiRecord => ({
  key,
  currentValue: 0,
  priorValue: 0,
  delta: 0,
  sampleCount: 0,
  lowConfidence: true,
})

/**
 * Return the current KPI vector.
 *
 * Reads from the kpi_snapshots table via readKpiWindowComparison. When the
 * table is empty, falls back to the all-zero low-confidence vector so the UI
 * shows "insufficient samples" rather than an error.
 *
 * An optional `store` can be injected for tests; production callers omit it
 * and get the default task store.
 */
export const listKpis = async (store?: TaskStore): Promise<KpiRecord[]> => {
  const now = new Date().toISOString()
  const { current, prior } = await readKpiWindowComparison({ now, store })

  if (current === null) {
    return KPI_KEYS.map(ZERO_RECORD)
  }

  return KPI_KEYS.map((key) => {
    const col = KPI_SNAPSHOT_COL[key]
    const confCol = KPI_CONFIDENCE_COL[key]
    const sampleCol = KPI_SAMPLE_COL[key]
    const currentColValue = current[col] as number | null
    const priorColValue = prior !== null ? (prior[col] as number | null) : null

    // lowConfidence when the KPI's own low_confidence flag is set OR the column is NULL
    const lowConfidence = current[confCol] === 1 || currentColValue === null

    if (currentColValue === null) {
      return ZERO_RECORD(key)
    }

    const currentValue = currentColValue

    // Only emit a meaningful prior/delta when both windows are trustworthy for this KPI
    const canDelta =
      prior !== null &&
      prior[confCol] === 0 &&
      current[confCol] === 0 &&
      priorColValue !== null

    const priorValue = canDelta ? (priorColValue as number) : currentValue
    const delta = canDelta ? currentValue - (priorColValue as number) : 0

    return {
      key,
      currentValue,
      priorValue,
      delta,
      sampleCount: current[sampleCol],
      lowConfidence,
    }
  })
}

export interface KpiArcsResult {
  key: KpiKey
  window: KpiWindow
  arcs: KpiArcRow[]
}

/**
 * Return the per-arc breakdown for a single KPI key.
 *
 * Uses the same window as the latest persisted snapshot so the arc list
 * reconciles with the headline KPI value. Falls back to a fresh 7-day window
 * when no snapshot has been taken yet.
 *
 * An optional `store` can be injected for tests; production callers omit it
 * and get the default task store.
 */
export const listKpiArcs = async (key: KpiKey, store?: TaskStore): Promise<KpiArcsResult> => {
  const now = new Date().toISOString()
  const s = store ?? (await getDefaultTaskStore())

  // Reuse the window from the latest persisted snapshot so arcs reconcile
  // with the headline number. Fall back to a fresh 7-day window when no
  // snapshot exists yet.
  const { current } = await readKpiWindowComparison({ now, store: s })
  const window: KpiWindow =
    current !== null
      ? { windowStart: current.window_start, windowEnd: current.window_end }
      : {
          windowStart: new Date(
            new Date(now).getTime() - 7 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          windowEnd: now,
        }

  let arcs: KpiArcRow[]
  switch (key) {
    case 'failure_rate':
      arcs = await listFailureRateArcs(s, window)
      break
    case 'autonomous_completion_rate':
      arcs = await listAutonomousArcs(s, window)
      break
    case 'recovery_success_rate':
      arcs = await listRecoveryArcs(s, window)
      break
    case 'cost_per_arc':
      arcs = await listCostPerArcArcs(s, window)
      break
  }

  return { key, window, arcs }
}

// ---------------------------------------------------------------------------
// Rescue-operator event counters
//
// Two monotonically-increasing counters stored in the `kpi_counters` table:
//   rescue_attempts_total — incremented each time a rescue-operator task is
//                           dispatched (in maybeSpawnRescueOperator).
//   rescue_success_total  — incremented when an arc that had a rescue attempt
//                           reaches 'arc-done' (in the arc-verifier subscriber).
//
// Both are queryable via getRescueCounters. The ratio rescue_success_total /
// rescue_attempts_total gives the rescue operator's success rate.
// ---------------------------------------------------------------------------

export interface RescueCounters {
  rescue_attempts_total: number
  rescue_success_total: number
}

/**
 * Return the current rescue-operator counter pair.
 * Both default to 0 when no row has been written yet.
 */
export const getRescueCounters = async (store: TaskStore): Promise<RescueCounters> => {
  const result = await store.query({
    sql: `SELECT key, value FROM kpi_counters WHERE key IN ('rescue_attempts_total', 'rescue_success_total')`,
    args: [],
  })
  let rescue_attempts_total = 0
  let rescue_success_total = 0
  for (const row of result.rows) {
    const r = row as unknown as { key: string; value: number }
    if (r.key === 'rescue_attempts_total') rescue_attempts_total = r.value
    if (r.key === 'rescue_success_total') rescue_success_total = r.value
  }
  return { rescue_attempts_total, rescue_success_total }
}

/**
 * Increment rescue_attempts_total by 1. Creates the counter row if absent.
 * Call immediately after incrementArcRescueAttempts in maybeSpawnRescueOperator.
 */
export const incrementRescueAttempts = async (store: TaskStore): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO kpi_counters (key, value) VALUES ('rescue_attempts_total', 1)
          ON CONFLICT (key) DO UPDATE SET value = kpi_counters.value + 1`,
    args: [],
  })
}

/**
 * Increment rescue_success_total by 1. Creates the counter row if absent.
 * Call when an arc that had arc_rescue_attempts > 0 reaches 'arc-done'.
 */
export const incrementRescueSuccess = async (store: TaskStore): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO kpi_counters (key, value) VALUES ('rescue_success_total', 1)
          ON CONFLICT (key) DO UPDATE SET value = kpi_counters.value + 1`,
    args: [],
  })
}
