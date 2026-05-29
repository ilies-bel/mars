import type { Kpi, KpiKey } from '@/entities/kpi/types'

const KPI_LABELS: Record<KpiKey, string> = {
  cost_per_arc: 'Cost per Arc',
  failure_rate: 'Failure Rate',
  autonomous_completion_rate: 'Autonomous Completion',
  recovery_success_rate: 'Recovery Success',
}

interface KpiTileProps {
  kpi: Kpi
}

export const KpiTile = ({ kpi }: KpiTileProps) => {
  const label = KPI_LABELS[kpi.key]
  return (
    <div className="flex flex-col items-center rounded border border-iron/20 bg-surface px-4 py-2 font-mono">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-lg font-semibold text-fg">{kpi.currentValue}</span>
    </div>
  )
}
