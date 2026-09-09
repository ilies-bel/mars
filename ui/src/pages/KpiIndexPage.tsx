import { KpiVector } from '@/widgets/KpiVector'
import { WatchtowerSection } from '@/widgets/WatchtowerSection'
import { PageBody, PageHeader, PageShell } from '@/widgets/primitives/DensityPrimitives'

/**
 * KPI index page — lists all KPI tiles and links to their detail pages,
 * followed by the Watchtower section with score trends and ledgers.
 *
 * Reachable at #/kpi.  Each tile navigates to #/kpi/<key>.
 */
export const KpiIndexPage = () => (
  <PageShell testId="kpi-page">
    <PageHeader title="KPIs" />
    <PageBody>
      <KpiVector />
      <WatchtowerSection />
    </PageBody>
  </PageShell>
)
