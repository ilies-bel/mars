import { useScorerTrend } from '@/entities/watchtower/useScorerTrend'
import { useWorkflowConfigs } from '@/entities/watchtower/useWorkflowConfigs'

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
 * - Faint horizontal dashed line: p90 reference.
 * - Vertical dashed rules: config-version boundaries within the visible window.
 * - Version chips above the chart: `v<n>` with `±delta` relative to the
 *   previous version's median score.
 * - Falls back to "No scores yet" when there is no data.
 */
export const WatchtowerTrendChart = ({
  workflow,
  window = 20,
}: WatchtowerTrendChartProps) => {
  const { points, p90 } = useScorerTrend(workflow, window)
  const { configs } = useWorkflowConfigs(workflow)

  // Points from the API are newest-first; reverse so the chart reads left→right.
  const chronological = [...points].reverse()
  const scores = chronological.map((p) => p.score)

  // Sort configs ascending by createdAt for boundary calculations.
  const sortedConfigs = [...configs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  // ---------------------------------------------------------------------------
  // Assign each visible point to a config version.
  // A point belongs to the latest config whose createdAt ≤ point.createdAt.
  // ---------------------------------------------------------------------------
  const versionScores = new Map<number, number[]>()
  for (const point of chronological) {
    const pointTime = new Date(point.createdAt).getTime()
    let version: number | null = null
    for (const cfg of sortedConfigs) {
      if (pointTime >= new Date(cfg.createdAt).getTime()) {
        version = cfg.version
      }
    }
    if (version !== null) {
      const bucket = versionScores.get(version) ?? []
      bucket.push(point.score)
      versionScores.set(version, bucket)
    }
  }

  // Sorted unique versions visible in the current window.
  const versionsInWindow = [...versionScores.keys()].sort((a, b) => a - b)

  // Median per version and chip descriptors.
  const medians = new Map<number, number>()
  for (const v of versionsInWindow) {
    const bucket = versionScores.get(v)!
    const sorted = [...bucket].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    medians.set(
      v,
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid],
    )
  }

  const chips = versionsInWindow.map((version, idx) => {
    const prevVersion = versionsInWindow[idx - 1]
    const delta =
      prevVersion !== undefined
        ? medians.get(version)! - medians.get(prevVersion)!
        : null
    return { version, delta }
  })

  // ---------------------------------------------------------------------------
  // Config-boundary x-positions for vertical dashed rules inside the SVG.
  // A boundary sits at the index of the first point ≥ the config's createdAt.
  // ---------------------------------------------------------------------------
  const boundaryXs: Array<{ version: number; x: number }> = []
  if (sortedConfigs.length > 1 && chronological.length > 1) {
    for (let ci = 1; ci < sortedConfigs.length; ci++) {
      const cfgTime = new Date(sortedConfigs[ci].createdAt).getTime()
      const ptIdx = chronological.findIndex(
        (p) => new Date(p.createdAt).getTime() >= cfgTime,
      )
      if (ptIdx > 0) {
        boundaryXs.push({
          version: sortedConfigs[ci].version,
          x: (ptIdx / (chronological.length - 1)) * CHART_W,
        })
      }
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[11px] text-iron">{workflow}</span>

      {/* Version chips — one per version visible in the window */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map(({ version, delta }) => {
            const deltaStr =
              delta !== null
                ? ` ${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}`
                : ''
            return (
              <span
                key={version}
                className="inline-flex items-center rounded px-1 py-0.5 font-mono text-[10px]"
              >
                {`v${version}${deltaStr}`}
              </span>
            )
          })}
        </div>
      )}

      {scores.length === 0 ? (
        <p className="text-xs text-muted">No scores yet</p>
      ) : (
        <svg
          width={CHART_W}
          height={CHART_H}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          aria-label={`Score trend for ${workflow}`}
        >
          {/* Version-boundary vertical dashed rules */}
          {boundaryXs.map(({ version, x }) => (
            <line
              key={`boundary-v${version}`}
              x1={x.toFixed(1)}
              y1={0}
              x2={x.toFixed(1)}
              y2={CHART_H}
              stroke="currentColor"
              strokeWidth={1}
              strokeOpacity={0.35}
              strokeDasharray="2 2"
            />
          ))}

          {/* p90 reference line — rendered before the main line so it sits behind */}
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
