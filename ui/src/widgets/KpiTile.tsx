import type { Kpi, KpiKey } from '@/entities/kpi/types'
import { Sparkline } from './Sparkline'

const KPI_LABELS: Record<KpiKey, string> = {
  cost_per_arc: 'Cost per Arc',
  failure_rate: 'Failure Rate',
  autonomous_completion_rate: 'Autonomous Completion',
  recovery_success_rate: 'Recovery Success',
}

/**
 * Format a KPI's numeric value for human display.
 *
 * - failure_rate, autonomous_completion_rate, recovery_success_rate:
 *   percent, one decimal place. E.g. 0.006211 becomes '0.6%', 0.85625 becomes '85.6%'.
 * - cost_per_arc: compact token count. E.g. 0 becomes '0 tok', 1234 becomes
 *   '1.2k tok', 1500000 becomes '1.5M tok'. The stored value is the p50 cost
 *   in cache-weighted tokens (see orchestrator/src/core/lib/kpi-compute.ts).
 */
export function formatKpiValue(key: KpiKey, value: number): string {
  if (key === 'cost_per_arc') {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k tok`
    return `${Math.round(value)} tok`
  }
  return `${(value * 100).toFixed(1)}%`
}

interface KpiTileProps {
  kpi: Kpi
}

export const KpiTile = ({ kpi }: KpiTileProps) => {
  const label = KPI_LABELS[kpi.key]
  if (kpi.lowConfidence) {
    return (
      <div className="kpi-tile kpi-tile--low-confidence">
        {label}: insufficient samples
      </div>
    )
  }
  const seriesPoints = (kpi.series ?? []).map((p) => p.value)
  return (
    <div className="flex flex-col items-center rounded border border-iron/20 bg-surface px-4 py-2 font-mono">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <Sparkline points={seriesPoints} />
      <span className="text-lg font-semibold text-fg">{formatKpiValue(kpi.key, kpi.currentValue)}</span>
    </div>
  )
}
