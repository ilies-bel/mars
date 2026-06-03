/**
 * Tests for KpiTile and KpiVector components.
 *
 * KpiTile receives a Kpi prop and renders the label + current value.
 * KpiVector calls useKpis() and renders one KpiTile per KPI plus a
 * live/offline status bar with task counts.
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
    const html = renderToStaticMarkup(
      <KpiVector connected={false} inProgress={0} blocked={0} failed={0} />,
    )
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('Failure Rate')
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('Recovery Success')
  })

  it('renders the currentValue of each KPI', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(
      <KpiVector connected={false} inProgress={0} blocked={0} failed={0} />,
    )
    expect(html).toContain('1')
    expect(html).toContain('0.05')
    expect(html).toContain('0.9')
    expect(html).toContain('0.8')
  })

  it('renders all four tiles even when some KPIs are low-confidence (layout invariant)', async () => {
    vi.mocked(useKpis).mockReturnValue({ data: MIXED_KPIS, isLoading: false, error: null })
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(
      <KpiVector connected={false} inProgress={0} blocked={0} failed={0} />,
    )
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('Failure Rate')
    expect(html).toContain('Autonomous Completion')
    expect(html).toContain('Recovery Success')
  })
})

// ---------------------------------------------------------------------------
// KpiVector status bar
// ---------------------------------------------------------------------------

describe('KpiVector status bar', () => {
  beforeEach(() => {
    vi.mocked(useKpis).mockReturnValue({ data: FOUR_KPIS, isLoading: false, error: null })
  })

  it('shows live text with animate-mars-pulse dot when connected is true', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(
      <KpiVector connected={true} inProgress={3} blocked={1} failed={2} />,
    )
    expect(html).toContain('live')
    expect(html).toContain('animate-mars-pulse')
  })

  it('shows offline text and no pulse when connected is false', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(
      <KpiVector connected={false} inProgress={0} blocked={0} failed={0} />,
    )
    expect(html).toContain('offline')
    expect(html).not.toContain('animate-mars-pulse')
  })

  it('displays running, blocked, and failed count labels', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(
      <KpiVector connected={true} inProgress={5} blocked={2} failed={1} />,
    )
    expect(html).toContain('running')
    expect(html).toContain('blocked')
    expect(html).toContain('failed')
  })

  it('displays the numeric values for each count', async () => {
    const { KpiVector } = await import('./KpiVector')
    const html = renderToStaticMarkup(
      <KpiVector connected={true} inProgress={7} blocked={3} failed={4} />,
    )
    expect(html).toContain('7')
    expect(html).toContain('3')
    expect(html).toContain('4')
  })
})
