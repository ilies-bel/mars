/**
 * Tests for KpiTile and KpiVector components.
 *
 * KpiTile receives a Kpi prop and renders the label + current value.
 * KpiVector calls useKpis() and renders one KpiTile per KPI.
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
  lowConfidence: overrides.lowConfidence ?? true,
})

// ---------------------------------------------------------------------------
// KpiTile
// ---------------------------------------------------------------------------

describe('KpiTile', () => {
  it('renders the human-readable label for cost_per_arc', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5 })} />)
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('2.5')
  })

  it('renders the human-readable label for failure_rate', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.1 })} />)
    expect(html).toContain('Failure Rate')
    expect(html).toContain('0.1')
  })

  it('renders the human-readable label for autonomous_completion_rate', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'autonomous_completion_rate', currentValue: 0.9 })} />)
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('0.9')
  })

  it('renders the human-readable label for recovery_success_rate', () => {
    const html = renderToStaticMarkup(<KpiTile kpi={kpi({ key: 'recovery_success_rate', currentValue: 0.75 })} />)
    expect(html).toContain('Recovery Success')
    expect(html).toContain('0.75')
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

vi.mock('@/entities/kpi/useKpis', () => ({
  useKpis: () => ({ data: FOUR_KPIS, isLoading: false, error: null }),
}))

describe('KpiVector', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
  })

  it('renders all four KPI tile labels side by side', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(<KpiVector />)
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('Failure Rate')
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('Recovery Success')
  })

  it('renders the currentValue of each KPI', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(<KpiVector />)
    expect(html).toContain('1')
    expect(html).toContain('0.05')
    expect(html).toContain('0.9')
    expect(html).toContain('0.8')
  })
})
