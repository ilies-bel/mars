/**
 * RecencySlider — controls how far back the Failed cluster looks on the
 * Progress tab. The slider has six stops: 1h, 6h, 24h (default), 7d, 30d,
 * and "all" (no cutoff). Moving the slider causes the parent to re-query
 * /api/progress with an updated ?failedWindow parameter so Failed tasks
 * outside the chosen window are removed from both the board and DAG views.
 *
 * The component is controlled: the parent owns `value` and handles changes
 * via `onChange`.
 */

export type { RecencyStop } from '@/shared/recencyStop'
export { RECENCY_STOPS, RECENCY_STOP_DEFAULT, recencyStopToMs } from '@/shared/recencyStop'

import {
  RECENCY_STOPS,
  type RecencyStop,
} from '@/shared/recencyStop'

interface RecencySliderProps {
  value: RecencyStop
  onChange: (stop: RecencyStop) => void
}

export const RecencySlider = ({ value, onChange }: RecencySliderProps) => {
  const idx = RECENCY_STOPS.indexOf(value)
  return (
    <div
      role="group"
      aria-label="Failed tasks recency window"
      className="flex items-center gap-1.5"
    >
      <span className="font-mono text-[10px] uppercase tracking-wide text-muted select-none">
        failed
      </span>
      <input
        type="range"
        min={0}
        max={RECENCY_STOPS.length - 1}
        step={1}
        value={idx}
        onChange={(e) => onChange(RECENCY_STOPS[Number(e.target.value)]!)}
        aria-label="Recency window for failed tasks"
        data-testid="recency-slider"
        className="w-20 accent-iron"
      />
      <span
        className="w-8 font-mono text-[10px] text-fg"
        data-testid="recency-slider-value"
      >
        {value}
      </span>
    </div>
  )
}
