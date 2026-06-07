/**
 * Tests for KpiTile and KpiVector components.
 *
 * KpiTile receives a Kpi prop and renders the label + formatted current value
 * plus a mini sparkline SVG. KpiVector calls useKpis() and renders one KpiTile
 * per KPI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Kpi } from '@/entities/kpi/types'
import { KpiTile } from './KpiTile'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const kpi = (overrides: Partial<Kpi> & { key: Kpi['key'] }): Kpi => ({
  key: overrides.key,
  currentValue: overrides.currentValue ?? 0,
  priorValue: overrides.priorValue ?? 0,
  delta: overrides.delta ?? 0,
  sampleCount: overrides.sampleCount ?? 0,
  lowConfidence: overrides.lowConfidence ?? false,
})

// ---------------------------------------------------------------------------
// KpiTile — label and formatted value
// ---------------------------------------------------------------------------

describe('KpiTile', () => {
  it('renders the human-readable label for cost_per_arc', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5 })} />)
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('3 tok')
  })

  it('renders the human-readable label for failure_rate', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.1 })} />)
    expect(html).toContain('Failure Rate')
    expect(html).toContain('10.0%')
  })

  it('renders the human-readable label for autonomous_completion_rate', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'autonomous_completion_rate', currentValue: 0.9 })} />)
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('90.0%')
  })

  it('renders the human-readable label for recovery_success_rate', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'recovery_success_rate', currentValue: 0.75 })} />)
    expect(html).toContain('Recovery Success')
    expect(html).toContain('75.0%')
  })
})

// ---------------------------------------------------------------------------
// KpiVector — mock useKpis so renderToStaticMarkup can drive it without
// a QueryClientProvider or a live server.
// ---------------------------------------------------------------------------

const FOUR_KPIS: Kpi[] = [
  kpi({ key: 'cost_per_arc', currentValue: 1.0 }),
  kpi({ key: 'failure_rate', currentValue: 0.05 }),
  kpi({ key: 'autonomous_completion_rate', currentValue: 0.9 }),
  kpi({ key: 'recovery_success_rate', currentValue: 0.8 }),
]

const MIXED_KPIS: Kpi[] = [
  kpi({ key: 'cost_per_arc', currentValue: 1.0, lowConfidence: true }),
  kpi({ key: 'failure_rate', currentValue: 0.05, lowConfidence: false }),
  kpi({ key: 'autonomous_completion_rate', currentValue: 0.9, lowConfidence: true }),
  kpi({ key: 'recovery_success_rate', currentValue: 0.8, lowConfidence: false }),
]

vi.mock('@/entities/kpi/useKpis', () => ({
  useKpis: vi.fn(() => ({ data: FOUR_KPIS, isLoading: false, error: null })),
}))

import { useKpis } from '@/entities/kpi/useKpis'

describe('KpiVector', () => {
  beforeEach(async () => {
    vi.mocked(useKpis).mockReturnValue({ data: FOUR_KPIS, isLoading: false, error: null })
  })

  it('renders all four KPI tile labels side by side', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(<KpiVector />)
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('Failure Rate')
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('Recovery Success')
  })

  it('renders the formatted value of each KPI', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(<KpiVector />)
    // cost_per_arc: 1.0 → '1 tok'
    expect(html).toContain('1 tok')
    // failure_rate: 0.05 → '5.0%'
    expect(html).toContain('5.0%')
    // autonomous_completion_rate: 0.9 → '90.0%'
    expect(html).toContain('90.0%')
    // recovery_success_rate: 0.8 → '80.0%'
    expect(html).toContain('80.0%')
  })

  it('renders all four tiles even when some KPIs are low-confidence (layout invariant)', async () => {
    vi.mocked(useKpis).mockReturnValue({ data: MIXED_KPIS, isLoading: false, error: null })
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(<KpiVector />)
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('Failure Rate')
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('Recovery Success')
  })
})
