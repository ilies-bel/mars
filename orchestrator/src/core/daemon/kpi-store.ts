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
import type { DomainTaskStore as TaskStore } from '../store/task-store.js'

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

/** Column on KpiSnapshot that corresponds to each KpiKey. */
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
    const currentColValue = current[col] as number | null
    const priorColValue = prior !== null ? (prior[col] as number | null) : null

    // lowConfidence when the snapshot itself is low-confidence OR the column is NULL
    const lowConfidence = current.low_confidence === 1 || currentColValue === null

    if (currentColValue === null) {
      return ZERO_RECORD(key)
    }

    const currentValue = currentColValue

    // Only emit a meaningful prior/delta when both windows are trustworthy
    const canDelta =
      prior !== null &&
      prior.low_confidence === 0 &&
      current.low_confidence === 0 &&
      priorColValue !== null

    const priorValue = canDelta ? (priorColValue as number) : currentValue
    const delta = canDelta ? currentValue - (priorColValue as number) : 0

    return {
      key,
      currentValue,
      priorValue,
      delta,
      sampleCount: current.sample_count,
      lowConfidence,
    }
  })
}
