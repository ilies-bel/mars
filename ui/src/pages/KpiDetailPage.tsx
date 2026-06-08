import type { KpiKey } from '@/shared/schemas'
import { useKpis } from '@/entities/kpi/useKpis'
import { useKpiArcs } from '@/entities/kpi/useKpiArcs'
import { kpiBand } from '@/entities/kpi/bands'
import { formatKpiValue } from '@/widgets/KpiTile'
import { Sparkline } from '@/widgets/Sparkline'
import { taskHash } from '@/shared/routing'

const KPI_LABELS: Record<KpiKey, string> = {
  cost_per_arc: 'Cost per Arc',
  failure_rate: 'Failure Rate',
  autonomous_completion_rate: 'Autonomous Completion',
  recovery_success_rate: 'Recovery Success',
}

const BAND_COLOR_CLASS: Record<'good' | 'warn' | 'bad', string> = {
  good: 'text-green-600',
  warn: 'text-amber-500',
  bad: 'text-red-600',
}

const BAND_BORDER_CLASS: Record<'good' | 'warn' | 'bad', string> = {
  good: 'border-l-4 border-l-green-500',
  warn: 'border-l-4 border-l-amber-400',
  bad: 'border-l-4 border-l-red-500',
}

interface KpiDetailPageProps {
  kpiKey: KpiKey
}

export const KpiDetailPage = ({ kpiKey }: KpiDetailPageProps) => {
  const { data: kpis, isLoading: kpisLoading, error: kpisError } = useKpis()
  const { arcs, isLoading: arcsLoading, error: arcsError } = useKpiArcs(kpiKey)

  const kpi = kpis?.find((k) => k.key === kpiKey)
  const label = KPI_LABELS[kpiKey]

  const isLoading = kpisLoading || arcsLoading
  const error = kpisError ?? arcsError

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* Header bar */}
      <div className="flex shrink-0 items-center gap-3 border-b border-iron/20 px-4 py-3">
        <a
          href="#/events"
          className="text-sm text-muted hover:text-fg focus:outline-none focus:ring-2 focus:ring-iron/40"
          aria-label="Back to Events"
        >
          ← Events
        </a>
        <span className="text-iron/30">|</span>
        <span className="font-mono text-sm font-semibold text-fg">{label}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* KPI summary card */}
        {kpi && !kpi.lowConfidence ? (
          <div
            className={`mb-6 flex flex-col gap-2 rounded border border-iron/20 bg-surface p-4 ${BAND_BORDER_CLASS[kpiBand(kpiKey, kpi.currentValue)]}`}
          >
            <div className="flex items-baseline gap-4">
              <span
                className={`font-mono text-3xl font-bold ${BAND_COLOR_CLASS[kpiBand(kpiKey, kpi.currentValue)]}`}
              >
                {formatKpiValue(kpiKey, kpi.currentValue)}
              </span>
              <span className="text-sm text-muted">
                {kpi.delta >= 0 ? '+' : ''}
                {kpiKey === 'cost_per_arc'
                  ? formatKpiValue(kpiKey, kpi.delta)
                  : `${(kpi.delta * 100).toFixed(1)}pp`}{' '}
                vs prior
              </span>
              <span className="ml-auto text-xs text-muted">
                {kpi.sampleCount} sample{kpi.sampleCount !== 1 ? 's' : ''}
              </span>
            </div>
            <Sparkline points={(kpi.series ?? []).map((p) => p.value)} />
          </div>
        ) : kpi?.lowConfidence ? (
          <div className="mb-6 rounded border border-iron/20 bg-surface p-4 text-sm text-muted">
            {label}: insufficient samples
          </div>
        ) : null}

        {/* Arc list */}
        <div>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
            {kpiKey === 'cost_per_arc' ? 'Arcs (by cost)' : 'Arcs'}
          </h2>

          {isLoading && (
            <p className="text-sm text-muted">Loading…</p>
          )}

          {error && !isLoading && (
            <p className="text-sm text-red-500">
              Failed to load arcs: {error.message}
            </p>
          )}

          {!isLoading && !error && arcs.length === 0 && (
            <p className="text-sm text-muted">No arcs in this window.</p>
          )}

          {!isLoading && arcs.length > 0 && (
            <table className="w-full font-mono text-sm">
              <thead>
                <tr className="border-b border-iron/20 text-left text-[10px] uppercase tracking-wide text-muted">
                  <th className="py-1 pr-3 font-normal">Status</th>
                  {kpiKey === 'cost_per_arc' ? (
                    <th className="py-1 pr-3 font-normal">Cost</th>
                  ) : (
                    <th className="py-1 pr-3 font-normal">Result</th>
                  )}
                  <th className="py-1 font-normal">Arc</th>
                </tr>
              </thead>
              <tbody>
                {arcs.map((arc) => (
                  <tr
                    key={arc.arcId}
                    className="border-b border-iron/10 hover:bg-iron/5"
                  >
                    <td className="py-1.5 pr-3 text-muted">{arc.status}</td>
                    {kpiKey === 'cost_per_arc' ? (
                      <td className="py-1.5 pr-3 text-fg">
                        {arc.costTokens !== undefined
                          ? formatKpiValue('cost_per_arc', arc.costTokens)
                          : '—'}
                      </td>
                    ) : (
                      <td className="py-1.5 pr-3">
                        <span
                          className={arc.passed ? 'text-green-600' : 'text-red-500'}
                          title={arc.passed ? 'PASS' : 'FAIL'}
                        >
                          {arc.passed ? '✓ PASS' : '✗ FAIL'}
                        </span>
                      </td>
                    )}
                    <td className="py-1.5">
                      <a
                        href={taskHash(arc.originTaskId, 'events')}
                        className="text-muted hover:text-fg focus:outline-none focus:underline"
                        title={arc.arcId}
                      >
                        {arc.title || arc.arcId}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
