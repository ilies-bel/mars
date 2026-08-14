import { SkeletonBlock } from '@/components/Skeleton'
import { useCostPerMergedTask } from '@/entities/kpi/useCostPerMergedTask'
import { kpiHash } from '@/shared/routing'
import { Sparkline } from './Sparkline'

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/**
 * KPI tile for cost-per-merged-task. Fetches its own 7-day window independently
 * of the main /api/kpis vector because the data shape (daily trend + USD values)
 * differs from the existing four KPIs.
 *
 * Shows: title, mini sparkline, current $/merge, and a 7-day delta arrow.
 */
export const CostPerMergedTaskTile = () => {
  const { data, isLoading } = useCostPerMergedTask(7)

  if (isLoading) {
    return (
      <SkeletonBlock className="w-[180px] min-h-[120px] rounded border border-primary/10" />
    )
  }

  const trend = data?.trend ?? []
  const currentPoint = trend[trend.length - 1]
  const firstPoint = trend[0]
  const currentValue = currentPoint?.avgCostPerMerge ?? null

  if (currentValue === null || trend.length < 2) {
    return (
      <a
        href={kpiHash('cost-per-merged-task')}
        className="kpi-tile--low-confidence flex w-[180px] min-h-[120px] flex-col items-center justify-center rounded border border-primary/20 bg-card px-4 py-2 font-mono text-muted-foreground text-xs no-underline hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary/40"
        aria-label="View Cost / merged task details"
      >
        Cost / merged task: insufficient data
      </a>
    )
  }

  const priorValue = firstPoint?.avgCostPerMerge ?? null
  const delta = priorValue !== null ? currentValue - priorValue : 0
  // lower cost = improved → ↑ arrow (matches kpiDriftDirection for lower-is-better)
  const showArrow = Math.abs(delta) >= 0.001
  const isImproved = delta < 0
  const deltaArrow = isImproved ? '↑' : '↓'
  const deltaClass = isImproved ? 'text-success' : 'text-error'

  const sparklinePoints = trend.map((p) => p.avgCostPerMerge)

  return (
    <a
      href={kpiHash('cost-per-merged-task')}
      className="flex w-[180px] min-h-[120px] flex-col items-center justify-between rounded border border-primary/20 bg-card px-4 py-2 font-mono no-underline hover:bg-primary/5 focus:outline-none focus:ring-2 focus:ring-primary/40"
      aria-label="View Cost / merged task details"
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Cost / merged task
      </span>
      <Sparkline points={sparklinePoints} />
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-lg font-semibold text-foreground">
          {usdFormatter.format(currentValue)}
        </span>
        {showArrow && (
          <span className={`flex items-center gap-1 text-[10px] ${deltaClass}`}>
            <span aria-hidden="true">{deltaArrow}</span>
            <span>{usdFormatter.format(Math.abs(delta))}</span>
          </span>
        )}
      </div>
    </a>
  )
}
