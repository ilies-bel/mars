import { FallbackSurface } from '@/components/FallbackSurface'
import { useKpis } from '@/entities/kpi/useKpis'
import { KpiTile } from './KpiTile'

export const KpiVector = () => {
  const { data: kpis, isLoading, error } = useKpis()

  if (error && !isLoading) {
    return <FallbackSurface error={error} of="KPI data" variant="inline" />
  }

  if (isLoading || !kpis) return null

  if (kpis.length === 0) {
    return (
      <p className="text-[11px] text-muted">
        No KPI data yet — KPIs appear after arcs complete.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-3">
      {kpis.map((kpi) => (
        <KpiTile key={kpi.key} kpi={kpi} />
      ))}
    </div>
  )
}
