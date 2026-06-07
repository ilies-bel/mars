interface SparklineProps {
  points: Array<number | null>
  width?: number
  height?: number
}

/**
 * Tiny hand-rolled SVG sparkline. No charting library dependency.
 *
 * - Normalises y to [min, max] of the non-null values.
 * - Null values produce gaps (separate polyline segments).
 * - Falls back to a flat baseline when fewer than 2 non-null points exist.
 */
export const Sparkline = ({ points, width = 80, height = 24 }: SparklineProps) => {
  const nonNull = points.filter((v): v is number => v !== null)

  // Flat baseline — insufficient data to show a trend
  if (nonNull.length < 2) {
    const y = (height / 2).toFixed(1)
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line
          x1={0}
          y1={y}
          x2={width}
          y2={y}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      </svg>
    )
  }

  const min = Math.min(...nonNull)
  const max = Math.max(...nonNull)
  // Avoid division by zero when every non-null value is identical
  const range = max === min ? 1 : max - min
  const n = points.length
  const pad = 1 // 1 px padding on top and bottom

  // Build segments of consecutive non-null points so nulls produce visible gaps
  const segments: string[][] = []
  let current: string[] | null = null

  points.forEach((v, i) => {
    if (v === null) {
      if (current !== null) {
        segments.push(current)
        current = null
      }
      return
    }
    const x = ((i / (n - 1)) * width).toFixed(1)
    const y = (height - pad - ((v - min) / range) * (height - 2 * pad)).toFixed(1)
    if (current === null) current = []
    current.push(`${x},${y}`)
  })
  if (current !== null) segments.push(current)

  return (
    <svg width={width} height={height} aria-hidden="true">
      {segments.map((seg, i) => (
        <polyline
          key={i}
          points={seg.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}
