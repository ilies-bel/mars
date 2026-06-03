import { useKpis } from '@/entities/kpi/useKpis'
import { KpiTile } from './KpiTile'

interface KpiVectorProps {
  connected: boolean
  inProgress: number
  blocked: number
  failed: number
}

export const KpiVector = ({ connected, inProgress, blocked, failed }: KpiVectorProps) => {
  const { data: kpis, isLoading } = useKpis()

  if (isLoading || !kpis) return null

  return (
    <div className="flex items-center gap-3 border-b border-iron/20 bg-bg px-4 py-2">
      <div className="flex flex-1 gap-3">
        {kpis.map((kpi) => (
          <KpiTile key={kpi.key} kpi={kpi} />
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2 font-mono text-[11px]">
        <span
          className={`h-2 w-2 rounded-full bg-flame ${connected ? 'animate-mars-pulse' : 'opacity-30'}`}
        />
        <span className="font-medium text-fg">{connected ? 'live' : 'offline'}</span>
        <span className="text-muted">·</span>
        <span className="text-flame">{inProgress} running</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{blocked} blocked</span>
        <span className="text-muted">·</span>
        <span className="text-muted">{failed} failed</span>
      </div>
    </div>
  )
}
