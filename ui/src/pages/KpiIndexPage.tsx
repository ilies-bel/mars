import { KpiVector } from '@/widgets/KpiVector'

/**
 * KPI index page — lists all KPI tiles and links to their detail pages.
 *
 * Reachable at #/kpi.  Each tile navigates to #/kpi/<key>.
 */
export const KpiIndexPage = () => (
  <div className="flex flex-col gap-4 overflow-y-auto p-6">
    <h2 className="font-mono text-[11px] uppercase tracking-wide text-iron">KPIs</h2>
    <KpiVector />
  </div>
)
