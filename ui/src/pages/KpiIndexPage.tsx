import { KpiVector } from '@/widgets/KpiVector'
import { WatchtowerSection } from '@/widgets/WatchtowerSection'
import { PageHeader } from '@/widgets/primitives/DensityPrimitives'

/**
 * KPI index page — lists all KPI tiles and links to their detail pages,
 * followed by the Watchtower section with score trends and ledgers.
 *
 * Reachable at #/kpi.  Each tile navigates to #/kpi/<key>.
 */
export const KpiIndexPage = () => (
  <div className="flex flex-col gap-4 overflow-y-auto p-6">
    <PageHeader title="KPIs" />
    <KpiVector />
    <WatchtowerSection />
  </div>
)

