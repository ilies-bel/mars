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

/**
 * The same points closed down to the baseline, so the line can carry a wash.
 * A bare 1px polyline on an empty box reads as a debug artefact; the fill is
 * what makes it read as a chart.
 */
const toAreaPoints = (scores: number[]): string =>
  `0,${CHART_H} ${toPolylinePoints(scores)} ${CHART_W},${CHART_H}`

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

  const latest = scores.length > 0 ? scores[scores.length - 1] : null
  // One phrase, used by both the visible header and the aria-label. Written
  // twice, they drifted immediately: the header singularised and the label
  // did not, so a screen reader heard "over 1 runs".
  const runCount = `${scores.length} run${scores.length === 1 ? '' : 's'}`

  return (
    <div className="flex flex-col gap-1 min-h-[104px]">
      {/* A line on an unlabelled box is decoration: it shows movement but not
       * magnitude, and a reader cannot tell 0.82 from 0.28. The header carries
       * the reading the chart cannot — the current score, stated as a fraction
       * so the 0..1 scale is legible without axis ticks, plus the sample count
       * so a two-point "trend" is not mistaken for a trend. */}
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-label text-muted-foreground">{workflow}</span>
        {latest !== null && (
          <span className="flex items-baseline gap-1">
            <span className="tabular-nums text-title font-semibold text-foreground">
              {latest.toFixed(2)}
            </span>
            <span className="text-micro tabular-nums text-muted-foreground">
              {`/ 1.00 · ${runCount}`}
            </span>
          </span>
        )}
      </div>

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
                className="inline-flex items-center rounded px-1 py-0.5 font-mono text-micro"
              >
                {`v${version}${deltaStr}`}
              </span>
            )
          })}
        </div>
      )}

      {scores.length === 0 ? (
        <p className="text-body text-muted-foreground">No scores yet</p>
      ) : (
        <div className="flex items-stretch gap-1.5">
        <div className="relative min-w-0 flex-1">
        <svg
          width="100%"
          height={CHART_H}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          /* The card is ~1000px and the chart was a fixed 240px sitting in it,
           * so the panel read as ~90% empty. It stretches to the card now.
           * preserveAspectRatio="none" would normally thin the vertical parts
           * of a stroke under that stretch; vector-effect pins stroke width to
           * device pixels, so the line stays 1.5px in every direction. */
          preserveAspectRatio="none"
          aria-label={`Score trend for ${workflow}: latest ${latest?.toFixed(2) ?? "none"} of 1.00 over ${runCount}${p90 !== null ? `, p90 ${p90.toFixed(2)}` : ""}`}
        >
          <defs>
            <linearGradient id={`trendfill-${workflow}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
              <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          {/* Baseline — the chart had no floor, so a low score and an empty
              chart looked the same. */}
          <line
            x1={0} y1={CHART_H} x2={CHART_W} y2={CHART_H}
            stroke="currentColor" strokeWidth={1} strokeOpacity={0.2}
            vectorEffect="non-scaling-stroke"
          />
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
              vectorEffect="non-scaling-stroke"
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
              vectorEffect="non-scaling-stroke"
            />
          )}

          <polygon points={toAreaPoints(scores)} fill={`url(#trendfill-${workflow})`} stroke="none" />
          {/* main score trend — solid */}
          <polyline
            points={toPolylinePoints(scores)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {/* Last value marker, drawn in HTML rather than SVG: the chart is
            stretched non-uniformly, so an SVG <circle> would render as an
            ellipse. The final sample is always at the right edge. */}
        <span
          aria-hidden="true"
          data-testid="trend-last-marker"
          className="pointer-events-none absolute right-0 h-1.5 w-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-current"
          style={{ bottom: `${(scores[scores.length - 1] ?? 0) * 100}%` }}
        />
        </div>
        {/* The dashed p90 rule was the one mark on the chart whose meaning was
         * unrecoverable from the picture. Labelling it in a right gutter (HTML,
         * not SVG — the chart is stretched non-uniformly, so SVG text would
         * shear) turns it from a stray line into a reference the eye can use. */}
        <div className="relative w-16 shrink-0" aria-hidden="true">
          {p90 !== null && (
            <span
              className="absolute right-0 translate-y-1/2 whitespace-nowrap text-micro tabular-nums text-muted-foreground"
              style={{ bottom: `${p90 * 100}%` }}
            >
              {`p90 ${p90.toFixed(2)}`}
            </span>
          )}
        </div>
        </div>
      )}
    </div>
  )
}
