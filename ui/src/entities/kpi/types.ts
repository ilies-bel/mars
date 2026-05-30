import type { Kpi, KpiKey } from '@/shared/schemas'

export type { Kpi, KpiKey }

export const KPI_IMPROVEMENT_DIRECTION: Record<KpiKey, 'lower-is-better' | 'higher-is-better'> = {
  cost_per_arc: 'lower-is-better',
  failure_rate: 'lower-is-better',
  autonomous_completion_rate: 'higher-is-better',
  recovery_success_rate: 'higher-is-better',
}

/**
 * Values whose absolute distance from zero falls below this threshold
 * are treated as flat (no measurable drift).
 */
const DRIFT_EPSILON = 1e-6

/**
 * Returns the drift direction for a KPI relative to its improvement direction.
 *
 * - 'improved': delta moved in the desired direction for this KPI
 * - 'regressed': delta moved against the desired direction
 * - 'flat': |delta| < DRIFT_EPSILON (numerically indistinguishable from zero)
 */
export function kpiDriftDirection(kpi: Kpi): 'improved' | 'regressed' | 'flat' {
  if (Math.abs(kpi.delta) < DRIFT_EPSILON) return 'flat'
  const dir = KPI_IMPROVEMENT_DIRECTION[kpi.key]
  if (dir === 'lower-is-better') {
    return kpi.delta < 0 ? 'improved' : 'regressed'
  }
  return kpi.delta > 0 ? 'improved' : 'regressed'
}
