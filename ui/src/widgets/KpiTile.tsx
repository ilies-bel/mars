import type { Kpi, KpiKey } from '@/entities/kpi/types'
import { KPI_IMPROVEMENT_DIRECTION } from '@/entities/kpi/types'
import { kpiBand, kpiBandCue } from '@/entities/kpi/bands'
import { kpiHash } from '@/shared/routing'
import { KpiTileShell } from './KpiTileShell'

const KPI_LABELS: Record<KpiKey, string> = {
  cost_per_arc: 'Cost per Arc',
  failure_rate: 'Failure Rate',
  autonomous_completion_rate: 'Autonomous Completion',
  recovery_success_rate: 'Recovery Success',
  'cost-per-merged-task': 'Cost / merged task',
}

export const KPI_DESCRIPTIONS: Record<KpiKey, string> = {
  failure_rate:
    'Percentage of arcs that failed without ever completing. Lower is better. Target: < 2%.',
  autonomous_completion_rate:
    'Percentage of completed arcs that needed no human intervention (no recovery task, no manual unblock). Higher is better. Target: > 85%.',
  recovery_success_rate:
    'Percentage of recovery attempts where both the recovery and its origin task completed successfully. Higher is better. Target: > 90%.',
  cost_per_arc:
    'Median cache-weighted token cost across completed arcs (p50). Lower is better. Target: < 50k tokens.',
  'cost-per-merged-task':
    'Average USD cost per merged task over the selected window. Lower is better. Tasks with no cost data are excluded from the average.',
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
const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatKpiValue(key: KpiKey, value: number): string {
  if (key === 'cost-per-merged-task') {
    return usdFormatter.format(value)
  }
  if (key === 'cost_per_arc') {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k tok`
    return `${Math.round(value)} tok`
  }
  return `${(value * 100).toFixed(1)}%`
}


/**
 * Format a CHANGE in a KPI, unsigned, in the metric's own unit.
 *
 * A rate's change is stated in percentage points, not percent: failure rate
 * moving 3.6% → 5.1% is "1.5 pts", never "1.5%", which would read as a
 * relative change of a different size.
 */
export function formatKpiDelta(key: KpiKey, delta: number): string {
  const magnitude = Math.abs(delta)
  if (key === 'cost-per-merged-task') return usdFormatter.format(magnitude)
  if (key === 'cost_per_arc') {
    if (magnitude >= 1_000_000) return `${(magnitude / 1_000_000).toFixed(1)}M tok`
    if (magnitude >= 1000) return `${(magnitude / 1000).toFixed(1)}k tok`
    return `${Math.round(magnitude)} tok`
  }
  return `${(magnitude * 100).toFixed(1)} pts`
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
        className="kpi-tile kpi-tile--low-confidence flex w-full min-h-[132px] flex-col items-center justify-center rounded border border-border bg-card px-4 py-2 font-mono text-muted-foreground text-body no-underline hover:bg-foreground/5"
        aria-label={`View ${label} details`}
      >
        {label}: insufficient samples
      </a>
    )
  }

  const band = kpiBand(kpi.key, kpi.currentValue)
  const windowDays = kpi.windowDays ?? 7

  return (
    <KpiTileShell
      href={kpiHash(kpi.key)}
      label={label}
      value={formatKpiValue(kpi.key, kpi.currentValue)}
      band={band}
      windowDays={windowDays}
      points={(kpi.series ?? []).map((p) => p.value)}
      trend={{
        delta: kpi.delta,
        formatted: formatKpiDelta(kpi.key, kpi.delta),
        lowerIsBetter: KPI_IMPROVEMENT_DIRECTION[kpi.key] === 'lower-is-better',
        comparison: `vs previous ${windowDays}d`,
      }}
      ariaLabel={`View ${label} details — ${kpiBandCue(band).label}`}
    />
  )
}
