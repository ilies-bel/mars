import { useKpis } from '@/entities/kpi/useKpis'
import { KpiTile } from './KpiTile'

export const KpiVector = () => {
  const { data: kpis, isLoading } = useKpis()

  if (isLoading || !kpis) return null

  return (
    <div className="flex gap-3 border-b border-iron/20 bg-bg px-4 py-2">
      {kpis.map((kpi) => (
        <KpiTile key={kpi.key} kpi={kpi} />
      ))}
    </div>
  )
}
