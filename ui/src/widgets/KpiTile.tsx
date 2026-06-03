import { kpiDriftDirection, type Kpi, type KpiKey } from '@/entities/kpi/types'

const KPI_LABELS: Record<KpiKey, string> = {
  cost_per_arc: 'Cost per Arc',
  failure_rate: 'Failure Rate',
  autonomous_completion_rate: 'Autonomous Completion',
  recovery_success_rate: 'Recovery Success',
}

const SPARKLINE_W = 80
const SPARKLINE_H = 24

function buildSparklinePoints(series: NonNullable<Kpi['series']>): string | null {
  const pts = series.map((p) => p.value).filter((v): v is number => v !== null)
  if (pts.length < 2) return null

  const minV = Math.min(...pts)
  const maxV = Math.max(...pts)
  const xStep = SPARKLINE_W / (pts.length - 1)
  const yRange = maxV - minV

  return pts
    .map((v, i) => {
      const x = i * xStep
      const y = yRange === 0 ? SPARKLINE_H / 2 : SPARKLINE_H - ((v - minV) / yRange) * SPARKLINE_H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

interface KpiTileProps {
  kpi: Kpi
}

export const KpiTile = ({ kpi }: KpiTileProps) => {
  const label = KPI_LABELS[kpi.key]
  if (kpi.lowConfidence) {
    return (
      <div className="kpi-tile kpi-tile--low-confidence">
        {label}: insufficient samples
      </div>
    )
  }
  const drift = kpiDriftDirection(kpi)
  const arrow = drift === 'improved' ? '↓' : drift === 'regressed' ? '↑' : '→'
  const signedDelta = kpi.delta > 0 ? `+${kpi.delta}` : String(kpi.delta)
  const sparklinePoints = kpi.series ? buildSparklinePoints(kpi.series) : null
  return (
    <div className="flex flex-col items-center rounded border border-iron/20 bg-surface px-4 py-2 font-mono">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-lg font-semibold text-fg">{kpi.currentValue}</span>
      <span className={`kpi-drift--${drift}`}>{arrow} {signedDelta}</span>
      {sparklinePoints !== null && (
        <svg
          width={SPARKLINE_W}
          height={SPARKLINE_H}
          viewBox={`0 0 ${SPARKLINE_W} ${SPARKLINE_H}`}
          className="mt-1 text-iron/60"
        >
          <polyline
            points={sparklinePoints}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  )
}
