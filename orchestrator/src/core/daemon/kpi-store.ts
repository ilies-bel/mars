/**
 * KPI persistence and computation stub.
 *
 * This module provides the four-KPI vector defined in ADR-0038 (harness health
 * as a four-KPI vector). The real computation layer (proposal 9a2ab5f8) will
 * replace this stub with reads from the persisted KPI table.
 *
 * Until proposal 9a2ab5f8 lands, every KPI returns zero values with
 * `lowConfidence: true` and `sampleCount: 0` — the UI renders them in a
 * low-confidence state and no drift arrows are displayed.
 */

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

/**
 * Return the current KPI vector. Each entry carries the four ADR-0038 KPIs.
 * When no data has been computed yet (stub state), all values are 0 and
 * `lowConfidence` is `true`.
 */
export const listKpis = async (): Promise<KpiRecord[]> =>
  KPI_KEYS.map((key) => ({
    key,
    currentValue: 0,
    priorValue: 0,
    delta: 0,
    sampleCount: 0,
    lowConfidence: true,
  }))
