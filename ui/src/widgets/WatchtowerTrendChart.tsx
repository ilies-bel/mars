import { useScorerTrend } from '@/entities/watchtower/useScorerTrend'

// ---------------------------------------------------------------------------
// SVG geometry helpers
// ---------------------------------------------------------------------------

const CHART_W = 240
const CHART_H = 60

/** Map an array of 0..1 scores to an SVG polyline `points` attribute string. */
const toPolylinePoints = (scores: number[]): string => {
  if (scores.length === 1) {
    // Single point: draw it centred horizontally.
    const y = (CHART_H - scores[0] * CHART_H).toFixed(1)
    return `0,${y} ${CHART_W},${y}`
  }
  return scores
    .map((s, i) => {
      const x = ((i / (scores.length - 1)) * CHART_W).toFixed(1)
      const y = (CHART_H - s * CHART_H).toFixed(1)
      return `${x},${y}`
    })
    .join(' ')
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface WatchtowerTrendChartProps {
  workflow: string
  window?: number
}

/**
 * Renders a 240×60 SVG line chart for a single workflow's scorer trend.
 *
 * - Solid polyline: the per-point score history (most-recent on the right).
 * - Faint overlay polyline: p90 reference line (horizontal at the p90 value).
 * - Falls back to "No scores yet" when there is no data.
 */
export const WatchtowerTrendChart = ({
  workflow,
  window = 20,
}: WatchtowerTrendChartProps) => {
  const { points, p90 } = useScorerTrend(workflow, window)

  // Points from the API are newest-first; reverse so the chart reads left→right.
  const chronological = [...points].reverse()
  const scores = chronological.map((p) => p.score)

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] text-iron">{workflow}</span>
      {scores.length === 0 ? (
        <p className="text-xs text-muted">No scores yet</p>
      ) : (
        <svg
          width={CHART_W}
          height={CHART_H}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          aria-label={`Score trend for ${workflow}`}
        >
          {/* p90 reference line — rendered first so it sits behind the main line */}
          {p90 !== null && (
            <line
              x1={0}
              y1={(CHART_H - p90 * CHART_H).toFixed(1)}
              x2={CHART_W}
              y2={(CHART_H - p90 * CHART_H).toFixed(1)}
              stroke="currentColor"
              strokeWidth={1}
              strokeOpacity={0.25}
              strokeDasharray="3 3"
            />
          )}
          {/* main score trend — solid */}
          <polyline
            points={toPolylinePoints(scores)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  )
}
