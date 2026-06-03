/**
 * Tests for KpiTile drift arrow rendering.
 *
 * Each KPI has an improvement direction:
 *   - cost_per_arc, failure_rate: lower-is-better
 *   - autonomous_completion_rate, recovery_success_rate: higher-is-better
 *
 * Regressions always render as ↑ with kpi-drift--regressed,
 * improvements as ↓ with kpi-drift--improved,
 * flat (|delta| < 1e-6) as → with kpi-drift--flat.
 */

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Kpi } from '@/entities/kpi/types'
import { KpiTile } from './KpiTile'

const kpi = (overrides: Partial<Kpi> & { key: Kpi['key'] }): Kpi => ({
  key: overrides.key,
  currentValue: overrides.currentValue ?? 0,
  priorValue: overrides.priorValue ?? 0,
  delta: overrides.delta ?? 0,
  sampleCount: overrides.sampleCount ?? 0,
  lowConfidence: overrides.lowConfidence ?? false,
})

// ---------------------------------------------------------------------------
// cost_per_arc — lower-is-better
// ---------------------------------------------------------------------------

describe('KpiTile drift: cost_per_arc (lower-is-better)', () => {
  it('renders ↓ improved when delta is negative', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 1.5, delta: -0.5 })} />,
    )
    expect(html).toContain('↓')
    expect(html).toContain('kpi-drift--improved')
    expect(html).toContain('-0.5')
  })

  it('renders ↑ regressed when delta is positive', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, delta: 0.5 })} />,
    )
    expect(html).toContain('↑')
    expect(html).toContain('kpi-drift--regressed')
    expect(html).toContain('+0.5')
  })

  it('renders → flat when delta is zero', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, delta: 0 })} />,
    )
    expect(html).toContain('→')
    expect(html).toContain('kpi-drift--flat')
  })
})

// ---------------------------------------------------------------------------
// failure_rate — lower-is-better
// ---------------------------------------------------------------------------

describe('KpiTile drift: failure_rate (lower-is-better)', () => {
  it('renders ↓ improved when delta is negative', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.05, delta: -0.02 })} />,
    )
    expect(html).toContain('↓')
    expect(html).toContain('kpi-drift--improved')
  })

  it('renders ↑ regressed when delta is positive', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.08, delta: 0.03 })} />,
    )
    expect(html).toContain('↑')
    expect(html).toContain('kpi-drift--regressed')
  })

  it('renders → flat when |delta| < epsilon (5e-7)', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'failure_rate', delta: 5e-7 })} />,
    )
    expect(html).toContain('→')
    expect(html).toContain('kpi-drift--flat')
  })
})

// ---------------------------------------------------------------------------
// autonomous_completion_rate — higher-is-better
// ---------------------------------------------------------------------------

describe('KpiTile drift: autonomous_completion_rate (higher-is-better)', () => {
  it('renders ↓ improved when delta is positive', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'autonomous_completion_rate', currentValue: 0.9, delta: 0.1 })} />,
    )
    expect(html).toContain('↓')
    expect(html).toContain('kpi-drift--improved')
  })

  it('renders ↑ regressed when delta is negative', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'autonomous_completion_rate', currentValue: 0.7, delta: -0.1 })} />,
    )
    expect(html).toContain('↑')
    expect(html).toContain('kpi-drift--regressed')
  })

  it('renders → flat when delta is zero', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'autonomous_completion_rate', delta: 0 })} />,
    )
    expect(html).toContain('→')
    expect(html).toContain('kpi-drift--flat')
  })
})

// ---------------------------------------------------------------------------
// recovery_success_rate — higher-is-better
// ---------------------------------------------------------------------------

describe('KpiTile drift: recovery_success_rate (higher-is-better)', () => {
  it('renders ↓ improved when delta is positive', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'recovery_success_rate', currentValue: 0.85, delta: 0.05 })} />,
    )
    expect(html).toContain('↓')
    expect(html).toContain('kpi-drift--improved')
  })

  it('renders ↑ regressed when delta is negative', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'recovery_success_rate', currentValue: 0.75, delta: -0.05 })} />,
    )
    expect(html).toContain('↑')
    expect(html).toContain('kpi-drift--regressed')
  })

  it('renders → flat when delta is zero', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'recovery_success_rate', delta: 0 })} />,
    )
    expect(html).toContain('→')
    expect(html).toContain('kpi-drift--flat')
  })
})

// ---------------------------------------------------------------------------
// Signed delta display
// ---------------------------------------------------------------------------

describe('KpiTile delta display', () => {
  it('prefixes positive delta with +', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', delta: 0.12 })} />,
    )
    expect(html).toContain('+0.12')
  })

  it('shows negative delta without modification', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', delta: -3.4 })} />,
    )
    expect(html).toContain('-3.4')
  })

  it('shows zero delta as 0 for flat case', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', delta: 0 })} />,
    )
    expect(html).toContain('→')
    // delta of 0 renders without + prefix
    expect(html).toContain('0')
  })
})

// ---------------------------------------------------------------------------
// Low-confidence rendering
// ---------------------------------------------------------------------------

describe('KpiTile low-confidence', () => {
  it('renders the label and "insufficient samples" when lowConfidence is true', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, delta: -0.5, lowConfidence: true })} />,
    )
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('insufficient samples')
    expect(html).toContain('kpi-tile--low-confidence')
  })

  it('suppresses currentValue, delta, and drift arrow when lowConfidence is true', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, delta: -0.5, lowConfidence: true })} />,
    )
    expect(html).not.toContain('2.5')
    expect(html).not.toContain('-0.5')
    expect(html).not.toContain('↓')
    expect(html).not.toContain('↑')
    expect(html).not.toContain('→')
  })

  it('renders the full numeric tile when lowConfidence is false', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, delta: -0.5, lowConfidence: false })} />,
    )
    expect(html).toContain('2.5')
    expect(html).toContain('↓')
    expect(html).toContain('-0.5')
    expect(html).not.toContain('insufficient samples')
    expect(html).not.toContain('kpi-tile--low-confidence')
  })
})
