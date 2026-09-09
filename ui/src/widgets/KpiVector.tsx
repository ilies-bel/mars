import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonBlock } from '@/components/Skeleton'
import { useKpis } from '@/entities/kpi/useKpis'
import { CostPerMergedTaskTile } from './CostPerMergedTaskTile'
import { KpiTile } from './KpiTile'

export const KpiVector = () => {
  const { data: kpis, isLoading, error } = useKpis()

  if (error && !isLoading) {
    return <FallbackSurface error={error} of="KPI data" variant="inline" />
  }

  if (isLoading || !kpis) {
    return (
      <div className="flex flex-wrap gap-3" aria-busy="true" aria-label="Loading KPIs">
        {[0, 1, 2, 3, 4].map((i) => (
          <SkeletonBlock key={i} className="w-[180px] min-h-[120px] rounded border border-border" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-3">
      {kpis.length === 0 ? (
        <p className="text-label text-muted-foreground">
          No data. KPIs appear after arcs complete.
        </p>
      ) : (
        kpis.map((kpi) => (
          <KpiTile key={kpi.key} kpi={kpi} />
        ))
      )}
      <CostPerMergedTaskTile />
    </div>
  )
}
