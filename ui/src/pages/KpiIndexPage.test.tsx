/**
 * Behaviour tests for KpiIndexPage (#/kpi).
 *
 * The index page must:
 *   - always show the "KPIs" section heading
 *   - show an explanatory empty-state message when the API returns an empty list
 *   - render a FallbackSurface alert (not nothing) when the fetch fails
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Kpi } from '@/shared/schemas'
import { KpiIndexPage } from './KpiIndexPage'

vi.mock('@/entities/kpi/useKpis', () => ({
  useKpis: vi.fn(() => ({ data: [], isLoading: false, error: null })),
}))

// WatchtowerSection renders LoopLedgerPanel, PromotionLedgerTable, and ScoreTrends
// — mock all three hooks so this test doesn't need a QueryClientProvider.
vi.mock('@/entities/watchtower/useLoopLedger', () => ({
  useLoopLedger: vi.fn(() => ({ entries: [], isLoading: false, error: null })),
}))

vi.mock('@/entities/watchtower/usePromotionLedger', () => ({
  usePromotionLedger: vi.fn(() => ({ entries: [], isLoading: false, error: null })),
}))

vi.mock('@/entities/watchtower/useScorerWorkflows', () => ({
  useScorerWorkflows: vi.fn(() => ({ data: [], isLoading: false, error: null })),
}))

vi.mock('@/entities/watchtower/useScorerSuggestions', () => ({
  useScorerSuggestions: vi.fn(() => ({ scorers: [], isLoading: false, error: null })),
}))

vi.mock('@/entities/watchtower/useAcceptScorer', () => ({
  useAcceptScorer: vi.fn(() => ({ accept: () => {}, isPending: false, error: null })),
}))

import { useKpis } from '@/entities/kpi/useKpis'

const makeKpi = (overrides: Partial<Kpi> & { key: Kpi['key'] }): Kpi => ({
  key: overrides.key,
  currentValue: overrides.currentValue ?? 0,
  priorValue: overrides.priorValue ?? 0,
  delta: overrides.delta ?? 0,
  sampleCount: overrides.sampleCount ?? 5,
  lowConfidence: overrides.lowConfidence ?? false,
})

describe('KpiIndexPage', () => {
  beforeEach(() => {
    vi.mocked(useKpis).mockReturnValue({ data: [], isLoading: false, error: null })
  })

  it('renders the "KPIs" section heading', () => {
    const html = renderToStaticMarkup(<KpiIndexPage />)
    expect(html).toContain('KPIs')
  })

  it('shows an explanatory empty-state message when there are no KPIs', () => {
    vi.mocked(useKpis).mockReturnValue({ data: [], isLoading: false, error: null })
    const html = renderToStaticMarkup(<KpiIndexPage />)
    expect(html).toContain('No KPI data yet')
    expect(html).toContain('arcs complete')
  })

  it('renders a fallback alert instead of a blank page when the fetch fails', () => {
    vi.mocked(useKpis).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('daemon unreachable'),
    })
    const html = renderToStaticMarkup(<KpiIndexPage />)
    expect(html).toContain('role="alert"')
  })

  it('renders the three Watchtower subsection titles', () => {
    const html = renderToStaticMarkup(<KpiIndexPage />)
    expect(html).toContain('Score trends')
    expect(html).toContain('Promotion ledger')
    expect(html).toContain('Loop ledger')
  })

  it('renders all KPI tiles when data is populated', () => {
    vi.mocked(useKpis).mockReturnValue({
      data: [
        makeKpi({ key: 'cost_per_arc', currentValue: 1.0 }),
        makeKpi({ key: 'failure_rate', currentValue: 0.02 }),
        makeKpi({ key: 'autonomous_completion_rate', currentValue: 0.9 }),
        makeKpi({ key: 'recovery_success_rate', currentValue: 0.8 }),
      ],
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<KpiIndexPage />)
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('Failure Rate')
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('Recovery Success')
  })
})
