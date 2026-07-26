import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonBlock } from '@/components/Skeleton'
import { useKpis } from '@/entities/kpi/useKpis'
import { KpiTile } from './KpiTile'

export const KpiVector = () => {
  const { data: kpis, isLoading, error } = useKpis()

  if (error && !isLoading) {
    return <FallbackSurface error={error} of="KPI data" variant="inline" />
  }

  if (isLoading || !kpis) {
    return (
      <div className="flex flex-wrap gap-3" aria-busy="true" aria-label="Loading KPIs">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="w-[180px] min-h-[120px] rounded border border-iron/10" />
        ))}
      </div>
    )
  }

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
