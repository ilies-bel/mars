import { kpiBandCue } from '@/entities/kpi/bands'
import { spendMeterBand } from '@/entities/spendMeter/bands'
import { useSpendMeter } from '@/entities/spendMeter/useSpendMeter'

/** Compact cache-weighted token count, e.g. 1.5M tok / 42.0k tok / 12 tok. */
const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tok`
  return `${Math.round(value)} tok`
}

const formatWindow = (ms: number): string => {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1_000)}s`
}

/**
 * The Spend meter tile — observe-and-warn token-budget burn, rendered
 * ADJACENT to the KPI tiles but visually a separate concept (dashed border,
 * "Spend meter" label): it is explicitly NOT a fifth KPI. Reuses the
 * kpiBandCue glyph/label/color cues with %-of-threshold banding
 * (spendMeterBand). An unconfigured meter renders a quiet "not configured"
 * state — never a fake zero.
 */
export const SpendMeterTile = () => {
  const { data, isLoading } = useSpendMeter()

  if (isLoading || !data) return null

  if (!data.configured || data.window === null) {
    return (
      <div
        className="spend-meter-tile flex w-[180px] min-h-[120px] flex-col items-center justify-center rounded border border-dashed border-iron/30 bg-surface px-4 py-2 font-mono text-muted text-xs"
        aria-label="Spend meter not configured"
      >
        <span className="text-[10px] uppercase tracking-wide">Spend meter</span>
        <span className="mt-2">
          {data.configured ? 'window not configured' : 'not configured'}
        </span>
        <span className="mt-1 text-[10px] text-iron">mars budget set</span>
      </div>
    )
  }

  const { spendTokens, thresholdTokens, ratio, windowMs } = data.window
  const band = spendMeterBand(ratio)
  const cue = kpiBandCue(band)
  const overCeilingCount = (data.arcs?.liveArcs ?? []).filter((a) => a.overCeiling).length

  return (
    <div
      className="spend-meter-tile flex w-[180px] min-h-[120px] flex-col items-center justify-between rounded border border-dashed border-iron/30 bg-surface px-4 py-2 font-mono"
      aria-label={`Spend meter — ${cue.label}`}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted">
        Spend meter · {formatWindow(windowMs)}
      </span>
      <div className="flex flex-col items-center gap-0.5">
        <span className="text-lg font-semibold text-fg">{formatTokens(spendTokens)}</span>
        <span className="text-[10px] text-muted">
          of {formatTokens(thresholdTokens)} ({Math.round(ratio * 100)}%)
        </span>
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <span className={`flex items-center gap-1 text-[10px] ${cue.colorClass}`}>
          <span aria-hidden="true">{cue.glyph}</span>
          <span>{cue.label}</span>
        </span>
        {overCeilingCount > 0 && (
          <span className="text-[10px] text-error">
            {overCeilingCount} arc{overCeilingCount === 1 ? '' : 's'} over ceiling
          </span>
        )}
      </div>
    </div>
  )
}
