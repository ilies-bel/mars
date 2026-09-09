import { ArrowDown, ArrowUp } from 'lucide-react'
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
  const { data, isLoading, error } = useCostPerMergedTask(7)

  if (isLoading) {
    return (
      <SkeletonBlock className="w-full min-h-[120px] rounded border border-border" />
    )
  }

  // A failed fetch is not thin data. Reporting "insufficient data" for a broken
  // request is how a schema mismatch went unnoticed: the tile looked like an
  // honest statement about the repo instead of a bug.
  if (error) {
    return (
      <a
        href={kpiHash('cost-per-merged-task')}
        data-testid="cost-per-merged-task-error"
        className="flex w-full min-h-[120px] flex-col items-center justify-center rounded border border-error/40 bg-card px-4 py-2 text-center font-mono text-body text-error no-underline hover:bg-error/5"
        aria-label="Cost / merged task failed to load"
      >
        Cost / merged task: failed to load
      </a>
    )
  }

  const trend = data?.trend ?? []
  // The freshest day that actually has pricing — not simply the last entry.
  // Older tasks predate usage signals, so the tail of the window is populated
  // while the head is null; keying off `trend[last]` alone blanked the tile
  // whenever the most recent day had no priced task yet.
  const priced = trend.filter((p) => p.avgCostPerMerge !== null)
  const currentValue = priced[priced.length - 1]?.avgCostPerMerge ?? null

  if (currentValue === null) {
    return (
      <a
        href={kpiHash('cost-per-merged-task')}
        className="kpi-tile--low-confidence flex w-full min-h-[120px] flex-col items-center justify-center rounded border border-border bg-card px-4 py-2 font-mono text-muted-foreground text-body no-underline hover:bg-foreground/5"
        aria-label="View Cost / merged task details"
      >
        Cost / merged task: insufficient data
      </a>
    )
  }

  // Compare against the earliest PRICED day, so the delta measures a real
  // change rather than the boundary between "no pricing" and "pricing".
  const priorValue = priced.length >= 2 ? priced[0].avgCostPerMerge : null
  const delta = priorValue !== null ? currentValue - priorValue : 0
  // The arrow points the way the VALUE moved, not the way the verdict moved.
  //
  // It used to be an improvement arrow, borrowed from kpiDriftDirection /
  // KpiDetailPage (up = Improved for a lower-is-better metric). That put three
  // signals in one tile pointing two ways: a sparkline visibly descending, an
  // up arrow, and the word "cheaper" — and the arrow was the loudest of the
  // three. The old comment here conceded the clash and hoped the adjacent word
  // would resolve it; on screen it does not, because the arrow is rendered
  // inside the same span as a dollar amount, and "↑ $1.41" reads as "up $1.41"
  // before any word arrives to undo it.
  //
  // Note also what the improvement reading cost: it made the arrow redundant.
  // Improvement is already carried twice, by the colour and by
  // "cheaper"/"dearer". Only a value-direction arrow contributes something the
  // tile does not otherwise state, and it agrees with the sparkline 8px above.
  // So: improved (cost fell) = ArrowDown + "cheaper" + success; regressed =
  // ArrowUp + "dearer" + error. Direction, magnitude and verdict, each said
  // once, none contradicting another.
  //
  // This deliberately diverges from KpiDetailPage's arrow convention. That
  // convention is fine where it lives — there is no sparkline beside it to
  // argue with.
  const showArrow = Math.abs(delta) >= 0.001
  const isImproved = delta < 0
  const DeltaArrow = isImproved ? ArrowDown : ArrowUp
  const deltaWord = isImproved ? 'cheaper' : 'dearer'
  const deltaClass = isImproved ? 'text-success' : 'text-error'

  const sparklinePoints = trend.map((p) => p.avgCostPerMerge)

  return (
    <a
      href={kpiHash('cost-per-merged-task')}
      className="flex w-full min-h-[120px] flex-col items-center justify-between rounded border border-border bg-card px-4 py-2 font-mono no-underline hover:bg-foreground/5"
      aria-label="View Cost / merged task details"
    >
      <span className="eyebrow flex h-6 items-center text-center text-muted-foreground">
        Cost / merged task
      </span>
      <Sparkline points={sparklinePoints} />
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-heading font-semibold text-foreground">
          {usdFormatter.format(currentValue)}
        </span>
        {showArrow && (
          <span className={`flex items-center gap-1 text-micro ${deltaClass}`}>
            <DeltaArrow size={11} strokeWidth={2.5} aria-hidden="true" />
            <span>
              {usdFormatter.format(Math.abs(delta))} {deltaWord}
            </span>
          </span>
        )}
      </div>
    </a>
  )
}
