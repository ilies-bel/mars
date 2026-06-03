/**
 * KPI wire format and reader for the daemon GET /kpis endpoint.
 *
 * Reads from the persisted kpi_snapshots table via readKpiWindowComparison —
 * the same function the CLI's `mars kpi show` uses — so both surfaces always
 * reflect the same numbers.
 *
 * When no snapshot exists yet, all four KPIs return sampleCount=0 and
 * lowConfidence=true (derived from the real table, not hardcoded).
 */

import { readKpiWindowComparison } from '../lib/kpi-snapshots.js'
import type { TaskStore } from '../lib/task-store.js'

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

/**
 * Return the current KPI vector by reading the most recent kpi_snapshots row
 * and comparing it against the prior window.
 *
 * Accepts an optional TaskStore for test injection; when omitted the
 * production default store is used (via readKpiWindowComparison's own
 * default).
 */
export const listKpis = async (store?: TaskStore): Promise<KpiRecord[]> => {
  const { current, prior, deltas } = await readKpiWindowComparison({
    now: new Date().toISOString(),
    store,
  })

  const lowConfidence = current === null || current.low_confidence === 1
  const sampleCount = current?.sample_count ?? 0

  return [
    {
      key: 'cost_per_arc',
      currentValue: current?.cost_per_arc_p50 ?? 0,
      priorValue: prior?.cost_per_arc_p50 ?? 0,
      delta: deltas.cost_per_arc_p50.value ?? 0,
      sampleCount,
      lowConfidence,
    },
    {
      key: 'failure_rate',
      currentValue: current?.failure_rate ?? 0,
      priorValue: prior?.failure_rate ?? 0,
      delta: deltas.failure_rate.value ?? 0,
      sampleCount,
      lowConfidence,
    },
    {
      key: 'autonomous_completion_rate',
      currentValue: current?.autonomous_completion_rate ?? 0,
      priorValue: prior?.autonomous_completion_rate ?? 0,
      delta: deltas.autonomous_completion_rate.value ?? 0,
      sampleCount,
      lowConfidence,
    },
    {
      key: 'recovery_success_rate',
      currentValue: current?.recovery_success_rate ?? 0,
      priorValue: prior?.recovery_success_rate ?? 0,
      delta: deltas.recovery_success_rate.value ?? 0,
      sampleCount,
      lowConfidence,
    },
  ]
}
