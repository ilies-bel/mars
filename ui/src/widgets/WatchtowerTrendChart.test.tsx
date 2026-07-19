/**
 * Tests for WatchtowerTrendChart and the WatchtowerSection Score trends
 * subsection.
 *
 * Both hooks are mocked so the tests run without a QueryClientProvider or
 * a live server — matching the pattern established by KpiVector.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ScorerTrendState } from '@/entities/watchtower/useScorerTrend'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POINTS = [
  { createdAt: '2024-01-01T00:00:00.000Z', score: 0.6 },
  { createdAt: '2024-01-02T00:00:00.000Z', score: 0.7 },
  { createdAt: '2024-01-03T00:00:00.000Z', score: 0.8 },
]

const trendState = (overrides?: Partial<ScorerTrendState>): ScorerTrendState => ({
  points: POINTS,
  median: 0.7,
  p90: 0.85,
  isLoading: false,
  error: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('@/entities/watchtower/useScorerTrend', () => ({
  useScorerTrend: vi.fn(() => trendState()),
}))

vi.mock('@/entities/watchtower/useScorerWorkflows', () => ({
  useScorerWorkflows: vi.fn(() => ({
    data: ['implement', 'triage'],
    isLoading: false,
    error: null,
  })),
}))

import { useScorerTrend } from '@/entities/watchtower/useScorerTrend'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'

// ---------------------------------------------------------------------------
// WatchtowerTrendChart
// ---------------------------------------------------------------------------

describe('WatchtowerTrendChart', () => {
  beforeEach(() => {
    vi.mocked(useScorerTrend).mockReturnValue(trendState())
  })

  it('renders an <svg> when there are score points', async () => {
    const { WatchtowerTrendChart } = await import('./WatchtowerTrendChart')
    const html = renderToStaticMarkup(
      <WatchtowerTrendChart workflow="implement" />,
    )
    expect(html).toContain('<svg')
  })

  it('renders the workflow name as a label', async () => {
    const { WatchtowerTrendChart } = await import('./WatchtowerTrendChart')
    const html = renderToStaticMarkup(
      <WatchtowerTrendChart workflow="implement" />,
    )
    expect(html).toContain('implement')
  })

  it('renders "No scores yet" when points array is empty', async () => {
    vi.mocked(useScorerTrend).mockReturnValue(
      trendState({ points: [], median: null, p90: null }),
    )
    const { WatchtowerTrendChart } = await import('./WatchtowerTrendChart')
    const html = renderToStaticMarkup(
      <WatchtowerTrendChart workflow="triage" />,
    )
    expect(html).toContain('No scores yet')
    expect(html).not.toContain('<svg')
  })

  it('includes a p90 reference line when p90 is non-null', async () => {
    vi.mocked(useScorerTrend).mockReturnValue(trendState({ p90: 0.9 }))
    const { WatchtowerTrendChart } = await import('./WatchtowerTrendChart')
    const html = renderToStaticMarkup(
      <WatchtowerTrendChart workflow="implement" />,
    )
    // The p90 line is rendered as a <line> element inside the SVG
    expect(html).toContain('<line')
  })

  it('omits the p90 reference line when p90 is null', async () => {
    vi.mocked(useScorerTrend).mockReturnValue(trendState({ p90: null }))
    const { WatchtowerTrendChart } = await import('./WatchtowerTrendChart')
    const html = renderToStaticMarkup(
      <WatchtowerTrendChart workflow="implement" />,
    )
    expect(html).not.toContain('<line')
  })
})

// ---------------------------------------------------------------------------
// WatchtowerSection — Score trends subsection
// Asserts one <svg> per workflow kind and that labels appear in output.
// ---------------------------------------------------------------------------

describe('WatchtowerSection Score trends', () => {
  beforeEach(() => {
    vi.mocked(useScorerWorkflows).mockReturnValue({
      data: ['implement', 'triage'],
      isLoading: false,
      error: null,
    })
    vi.mocked(useScorerTrend).mockReturnValue(trendState())
  })

  it('renders one <svg> per mocked workflow kind', async () => {
    const { WatchtowerSection } = await import('./WatchtowerSection')
    const html = renderToStaticMarkup(<WatchtowerSection />)
    // Two workflow kinds → two SVGs
    const svgCount = (html.match(/<svg/g) ?? []).length
    expect(svgCount).toBe(2)
  })

  it('renders all workflow kind labels in the output', async () => {
    const { WatchtowerSection } = await import('./WatchtowerSection')
    const html = renderToStaticMarkup(<WatchtowerSection />)
    expect(html).toContain('implement')
    expect(html).toContain('triage')
  })

  it('renders "No scores yet" in Score trends when workflow list is empty', async () => {
    vi.mocked(useScorerWorkflows).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    })
    const { WatchtowerSection } = await import('./WatchtowerSection')
    const html = renderToStaticMarkup(<WatchtowerSection />)
    expect(html).toContain('No scores yet')
  })
})
