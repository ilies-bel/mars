import { SkeletonBlock } from '@/components/Skeleton'
import { kpiBand, kpiTarget } from '@/entities/kpi/bands'
import { useCostPerMergedTask } from '@/entities/kpi/useCostPerMergedTask'
import { kpiHash } from '@/shared/routing'
import { KpiTileShell } from './KpiTileShell'

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** The window this tile fetches, and the window its copy has to name. */
const WINDOW_DAYS = 7

/**
 * KPI tile for cost-per-merged-task. Fetches its own window independently of
 * the main /api/kpis vector because the data shape (daily trend + USD values)
 * differs from the existing four KPIs.
 *
 * Fetching separately is the reason this tile drifted into its own grammar —
 * it stated a delta where the other four stated a verdict, so a row of five
 * tiles answered two different questions. The presentation now comes from
 * KpiTileShell, which both callers share and neither can opt out of; only the
 * fetch stays separate.
 */
export const CostPerMergedTaskTile = () => {
  const { data, isLoading, error } = useCostPerMergedTask(WINDOW_DAYS)

  if (isLoading) {
    return (
      <SkeletonBlock className="w-full min-h-[132px] rounded border border-border" />
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
        className="flex w-full min-h-[132px] flex-col items-center justify-center rounded border border-error/40 bg-card px-4 py-2 text-center font-mono text-body text-error no-underline hover:bg-error/5"
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
  // Compare against the earliest PRICED day, so the delta measures a real
  // change rather than the boundary between "no pricing" and "pricing".
  const priorValue = priced.length >= 2 ? priced[0].avgCostPerMerge : null
  const delta = priorValue !== null ? currentValue - priorValue : 0

  const sparklinePoints = trend.map((p) => p.avgCostPerMerge)

  return (
    <KpiTileShell
      href={kpiHash('cost-per-merged-task')}
      label="Cost / merged task"
      value={usdFormatter.format(currentValue)}
      band={kpiBand('cost-per-merged-task', currentValue)}
      target={kpiTarget('cost-per-merged-task')}
      windowDays={WINDOW_DAYS}
      points={sparklinePoints}
      trend={
        priorValue === null
          ? null
          : {
              delta,
              formatted: usdFormatter.format(Math.abs(delta)),
              lowerIsBetter: true,
              // NOT "vs previous 7d" — this tile compares the first and last
              // priced day INSIDE its own window, where the other four compare
              // this window against the one before it. The two phrasings used
              // to differ by three words ("since 7d ago" vs "vs previous 7d"),
              // which read as an inconsistency rather than as the different
              // measurement it is. "across" says the movement happened within
              // the window.
              comparison: `across the last ${WINDOW_DAYS}d`,
            }
      }
      ariaLabel="View Cost / merged task details"
    />
  )
}
