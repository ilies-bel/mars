import { ArrowDown, ArrowUp } from 'lucide-react'
import { kpiBandCue, type KpiBand } from '@/entities/kpi/bands'
import { Sparkline } from './Sparkline'

/**
 * The one shape a KPI tile has.
 *
 * The five tiles on the KPI row used to be written twice — four from the
 * `/api/kpis` vector, one fetching its own window — and the two copies drifted
 * into mutually exclusive grammars. Four read "✕ Bad · last 7d" (a verdict and
 * a window, no movement); the fifth read "↑ $0.79 dearer" (movement, no
 * verdict and no window). Side by side in one row they answered different
 * questions, and a reader could not tell whether the fifth tile was acceptable
 * or the other four were getting worse — the row invited a comparison it did
 * not support.
 *
 * Both facts matter and both are available for all five: `kpiBand` already
 * classifies cost-per-merged-task, and every KPI in the vector already carries
 * a `delta` the tiles were discarding. So the tile states both, in one order,
 * and neither caller can choose otherwise.
 *
 * Signal assignment, unchanged from the cost tile that worked it out:
 *
 *   arrow   the direction the VALUE moved — so it agrees with the sparkline
 *           sitting beside it rather than arguing with it
 *   colour  whether that movement is good for this metric
 *   words   "higher"/"lower" — the value's direction again, in a unit-neutral
 *           phrasing every metric can use. "cheaper"/"dearer" was a third
 *           reading of the same fact and only one of the five could say it.
 *
 * Left-aligned, not centred. Five centred tiles give the eye no common edge to
 * run down, so comparing the values means five separate fixations.
 */
export interface KpiTileTrend {
  /** Signed change over the window, in the metric's native units. */
  delta: number
  /** |delta| already formatted in the metric's own unit. */
  formatted: string
  /** True when a falling value is the good direction for this metric. */
  lowerIsBetter: boolean
  /**
   * What the delta is measured against, in the reader's words — the two tiles
   * do not compare the same things and must not claim to.
   *
   * The vector's `delta` is this window minus the PREVIOUS window
   * (`readKpiWindowComparison` takes the last snapshot ending at or before the
   * current window's start), so it is "vs previous 7d". The cost tile compares
   * the first and last priced day INSIDE its own window, so it is "since 7d
   * ago". Both were about to be labelled "than 7d ago", which is false for the
   * first and would have been invisible.
   */
  comparison: string
}

interface KpiTileShellProps {
  href: string
  label: string
  /** The current value, already formatted. */
  value: string
  band: KpiBand
  windowDays: number
  points: Array<number | null>
  /** Omitted when the window holds too few comparable points to state a change. */
  trend?: KpiTileTrend | null
  ariaLabel: string
  testId?: string
}

/** Below this the movement is noise, and an arrow would overstate it. */
const FLAT_EPSILON = 1e-9

export const KpiTileShell = ({
  href,
  label,
  value,
  band,
  windowDays,
  points,
  trend,
  ariaLabel,
  testId,
}: KpiTileShellProps) => {
  const cue = kpiBandCue(band)
  const moved = trend != null && Math.abs(trend.delta) > FLAT_EPSILON
  const rose = moved && trend.delta > 0
  const Arrow = rose ? ArrowUp : ArrowDown
  const improved = moved && (trend.lowerIsBetter ? trend.delta < 0 : trend.delta > 0)

  return (
    <a
      href={href}
      className="flex w-full min-h-[132px] flex-col justify-between gap-2 rounded border border-border bg-card px-3.5 py-3 no-underline transition-colors hover:bg-foreground/5"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <span className="eyebrow text-muted-foreground">{label}</span>

      <div className="flex items-end justify-between gap-2">
        <span className="font-mono text-heading font-semibold tabular-nums text-foreground">
          {value}
        </span>
        <span className="shrink-0 text-muted-foreground">
          <Sparkline points={points} width={64} height={22} />
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        <span className={`flex items-center gap-1 text-micro ${cue.colorClass}`}>
          <cue.Icon size={11} strokeWidth={2.5} aria-hidden="true" />
          <span>
            {cue.label} · last {windowDays}d
          </span>
        </span>
        {moved && (
          <span
            className={`flex items-center gap-1 text-micro ${improved ? 'text-success' : 'text-error'}`}
            data-testid="kpi-tile-trend"
          >
            <Arrow size={11} strokeWidth={2.5} aria-hidden="true" />
            <span className="tabular-nums">
              {trend.formatted} {rose ? 'higher' : 'lower'} {trend.comparison}
            </span>
          </span>
        )}
      </div>
    </a>
  )
}
