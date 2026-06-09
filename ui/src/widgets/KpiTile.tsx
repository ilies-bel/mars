import type { Kpi, KpiKey } from '@/entities/kpi/types'
import { kpiBand, kpiBandCue } from '@/entities/kpi/bands'
import { kpiHash } from '@/shared/routing'
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
      <a
        href={kpiHash(kpi.key)}
        className="kpi-tile kpi-tile--low-confidence flex w-[180px] min-h-[120px] flex-col items-center justify-center rounded border border-iron/20 bg-surface px-4 py-2 font-mono text-muted text-xs no-underline hover:bg-iron/5 focus:outline-none focus:ring-2 focus:ring-iron/40"
        aria-label={`View ${label} details`}
      >
        {label}: insufficient samples
      </a>
    )
  }

  const band = kpiBand(kpi.key, kpi.currentValue)
  const cue = kpiBandCue(band)
  const seriesPoints = (kpi.series ?? []).map((p) => p.value)

  return (
    <a
      href={kpiHash(kpi.key)}
      className="flex w-[180px] min-h-[120px] flex-col items-center justify-between rounded border border-iron/20 bg-surface px-4 py-2 font-mono no-underline hover:bg-iron/5 focus:outline-none focus:ring-2 focus:ring-iron/40"
      aria-label={`View ${label} details — ${cue.label}`}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <Sparkline points={seriesPoints} />
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-lg font-semibold text-fg">{formatKpiValue(kpi.key, kpi.currentValue)}</span>
        <span className={`flex items-center gap-1 text-[10px] ${cue.colorClass}`}>
          <span aria-hidden="true">{cue.glyph}</span>
          <span>{cue.label}</span>
        </span>
      </div>
    </a>
  )
}
