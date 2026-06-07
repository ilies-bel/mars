import { useKpis } from '@/entities/kpi/useKpis'
import { KpiTile } from './KpiTile'

export const KpiVector = () => {
  const { data: kpis, isLoading } = useKpis()

  if (isLoading || !kpis) return null

  return (
    <div className="flex flex-wrap gap-3">
      {kpis.map((kpi) => (
        <KpiTile key={kpi.key} kpi={kpi} />
      ))}
    </div>
  )
}
