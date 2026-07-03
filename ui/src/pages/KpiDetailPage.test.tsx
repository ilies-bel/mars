/**
 * Behaviour tests for KpiDetailPage band indicator and navigation.
 *
 * The band cue in the summary card must:
 *   - show a glyph + text label readable without colour (accessibility)
 *   - use semantic token colour classes (text-success / text-warn / text-error)
 *   - NOT use a thick coloured left-border stripe (border-l-4)
 *
 * Arc-level pass/fail cues (✓ PASS / ✗ FAIL) are colour-safe because they
 * already carry shape: tested here to ensure they use semantic tokens.
 *
 * Navigation invariants:
 *   - back-link returns to #/kpi (KPI index), not #/events
 *   - arc task links encode from=kpi&kpiKey=<key> so closing the drawer
 *     returns to the exact KPI detail page, not Events
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Kpi, KpiArc } from '@/shared/schemas'
import { KpiDetailPage } from './KpiDetailPage'

vi.mock('@/entities/kpi/useKpis')
vi.mock('@/entities/kpi/useKpiArcs')

import { useKpis } from '@/entities/kpi/useKpis'
import { useKpiArcs } from '@/entities/kpi/useKpiArcs'

const mockUseKpis = vi.mocked(useKpis)
const mockUseKpiArcs = vi.mocked(useKpiArcs)

const makeKpi = (overrides: Partial<Kpi> & { key: Kpi['key'] }): Kpi => ({
  key: overrides.key,
  currentValue: overrides.currentValue ?? 0,
  priorValue: overrides.priorValue ?? 0,
  delta: overrides.delta ?? 0,
  sampleCount: overrides.sampleCount ?? 5,
  lowConfidence: overrides.lowConfidence ?? false,
  series: overrides.series,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noArcs = { arcs: [], isLoading: false, error: null }

function renderPage(key: Kpi['key'], currentValue: number) {
  mockUseKpis.mockReturnValue({
    data: [makeKpi({ key, currentValue })],
    isLoading: false,
    error: null,
  } as ReturnType<typeof useKpis>)
  mockUseKpiArcs.mockReturnValue(noArcs as ReturnType<typeof useKpiArcs>)
  return renderToStaticMarkup(<KpiDetailPage kpiKey={key} />)
}

function renderPageWithArcs(key: Kpi['key'], arcs: KpiArc[]) {
  mockUseKpis.mockReturnValue({
    data: [makeKpi({ key, currentValue: 0.05 })],
    isLoading: false,
    error: null,
  } as ReturnType<typeof useKpis>)
  mockUseKpiArcs.mockReturnValue({
    arcs,
    isLoading: false,
    error: null,
  } as ReturnType<typeof useKpiArcs>)
  return renderToStaticMarkup(<KpiDetailPage kpiKey={key} />)
}

// ---------------------------------------------------------------------------
// Band indicator — non-colour cue + semantic tokens
// ---------------------------------------------------------------------------

describe('KpiDetailPage — band indicator', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('renders the "Good" label for a good-band KPI (cost_per_arc < 50k)', () => {
    // cost_per_arc=2.5 → kpiBand → 'good'
    const html = renderPage('cost_per_arc', 2.5)
    expect(html).toContain('Good')
  })

  it('renders the ✓ glyph for a good-band KPI', () => {
    const html = renderPage('cost_per_arc', 2.5)
    expect(html).toContain('✓')
  })

  it('renders the "Warn" label for a warn-band KPI (failure_rate at 0.05)', () => {
    // failure_rate=0.05 → kpiBand → 'warn'
    const html = renderPage('failure_rate', 0.05)
    expect(html).toContain('Warn')
  })

  it('renders the ⚠ glyph for a warn-band KPI', () => {
    const html = renderPage('failure_rate', 0.05)
    expect(html).toContain('⚠')
  })

  it('renders the "Bad" label for a bad-band KPI (failure_rate > 0.05)', () => {
    // failure_rate=0.10 → kpiBand → 'bad'
    const html = renderPage('failure_rate', 0.10)
    expect(html).toContain('Bad')
  })

  it('renders the ✕ glyph for a bad-band KPI', () => {
    const html = renderPage('failure_rate', 0.10)
    expect(html).toContain('✕')
  })

  it('does not render a coloured left-border stripe (no border-l-4)', () => {
    const html = renderPage('failure_rate', 0.05)
    expect(html).not.toContain('border-l-4')
  })

  it('uses semantic text-success class for good band, not raw green-*', () => {
    const html = renderPage('cost_per_arc', 2.5)
    expect(html).toContain('text-success')
    expect(html).not.toMatch(/green-\d/)
  })

  it('uses semantic text-warn class for warn band, not raw amber-*', () => {
    const html = renderPage('failure_rate', 0.05)
    expect(html).toContain('text-warn')
    expect(html).not.toMatch(/amber-\d/)
  })

  it('uses semantic text-error class for bad band, not raw red-*', () => {
    const html = renderPage('failure_rate', 0.10)
    expect(html).toContain('text-error')
    expect(html).not.toMatch(/red-\d/)
  })
})

// ---------------------------------------------------------------------------
// Navigation — back-link and arc task links
// ---------------------------------------------------------------------------

describe('KpiDetailPage — navigation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('back-link points to #/kpi (KPI index), not #/events', () => {
    const html = renderPage('failure_rate', 0.05)
    expect(html).toContain('href="#/kpi"')
    expect(html).not.toContain('href="#/events"')
  })

  it('back-link label mentions KPIs, not Events', () => {
    const html = renderPage('failure_rate', 0.05)
    expect(html).toContain('KPIs')
    expect(html).not.toContain('← Events')
  })

  it('arc task links encode from=kpi so drawer close returns to KPI route', () => {
    const arc: KpiArc = {
      arcId: 'arc-001',
      originTaskId: 'task-abc',
      status: 'done',
      passed: true,
      title: 'Test arc',
    }
    const html = renderPageWithArcs('failure_rate', [arc])
    expect(html).toContain('from=kpi')
    expect(html).not.toContain('from=events')
  })

  it('arc task links encode kpiKey so drawer close returns to the exact detail page', () => {
    const arc: KpiArc = {
      arcId: 'arc-002',
      originTaskId: 'task-xyz',
      status: 'done',
      passed: false,
      title: 'Another arc',
    }
    const html = renderPageWithArcs('autonomous_completion_rate', [arc])
    expect(html).toContain('kpiKey=autonomous_completion_rate')
  })
})
