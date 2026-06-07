/**
 * Tests for KpiTile and formatKpiValue.
 *
 * Each tile shows:
 *   - The human-readable label
 *   - A mini sparkline SVG (polyline when series >= 2 non-null points,
 *     flat baseline otherwise)
 *   - A cleanly formatted current value
 *
 * The old drift-arrow / raw-number rendering has been removed.
 *
 * Value formatting rules:
 *   - cost_per_arc   → compact token count: 0 tok / 1.2k tok / 1.5M tok
 *   - failure_rate, autonomous_completion_rate, recovery_success_rate
 *                    → percent with one decimal: '0.6%', '85.6%', '98.6%'
 *
 * Low-confidence path: shows '<label>: insufficient samples' and
 * kpi-tile--low-confidence class; does NOT render sparkline or formatted value.
 */

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Kpi, KpiSeriesPoint } from '@/shared/schemas'
import { KpiTile, formatKpiValue } from './KpiTile'

const kpi = (overrides: Partial<Kpi> & { key: Kpi['key'] }): Kpi => ({
  key: overrides.key,
  currentValue: overrides.currentValue ?? 0,
  priorValue: overrides.priorValue ?? 0,
  delta: overrides.delta ?? 0,
  sampleCount: overrides.sampleCount ?? 0,
  lowConfidence: overrides.lowConfidence ?? false,
  series: overrides.series,
})

const point = (value: number | null): KpiSeriesPoint => ({
  takenAt: '2024-01-01T00:00:00Z',
  value,
})

// ---------------------------------------------------------------------------
// formatKpiValue — pure helper
// ---------------------------------------------------------------------------

describe('formatKpiValue', () => {
  // percent keys
  it('formats failure_rate as percent with one decimal', () => {
    expect(formatKpiValue('failure_rate', 0.00621118)).toBe('0.6%')
  })

  it('formats autonomous_completion_rate as percent with one decimal', () => {
    expect(formatKpiValue('autonomous_completion_rate', 0.85625)).toBe('85.6%')
  })

  it('formats recovery_success_rate as percent with one decimal', () => {
    expect(formatKpiValue('recovery_success_rate', 0.98648)).toBe('98.6%')
  })

  it('formats a zero percent correctly', () => {
    expect(formatKpiValue('failure_rate', 0)).toBe('0.0%')
  })

  // cost_per_arc — token count
  it('formats cost_per_arc zero as "0 tok"', () => {
    expect(formatKpiValue('cost_per_arc', 0)).toBe('0 tok')
  })

  it('formats cost_per_arc values < 1000 as integer tok', () => {
    expect(formatKpiValue('cost_per_arc', 999)).toBe('999 tok')
  })

  it('formats cost_per_arc values >= 1000 with k suffix', () => {
    expect(formatKpiValue('cost_per_arc', 1234)).toBe('1.2k tok')
  })

  it('formats cost_per_arc values at exactly 1000 as 1.0k tok', () => {
    expect(formatKpiValue('cost_per_arc', 1000)).toBe('1.0k tok')
  })

  it('formats cost_per_arc values >= 1000000 with M suffix', () => {
    expect(formatKpiValue('cost_per_arc', 1_500_000)).toBe('1.5M tok')
  })

  it('formats cost_per_arc at exactly 1000000 as 1.0M tok', () => {
    expect(formatKpiValue('cost_per_arc', 1_000_000)).toBe('1.0M tok')
  })
})

// ---------------------------------------------------------------------------
// KpiTile rendering — normal (non-low-confidence) path
// ---------------------------------------------------------------------------

describe('KpiTile — label and formatted value', () => {
  it('renders the label for cost_per_arc', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5 })} />,
    )
    expect(html).toContain('Cost per Arc')
  })

  it('renders formatted value for cost_per_arc', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5 })} />,
    )
    expect(html).toContain('3 tok')
  })

  it('renders the label for failure_rate', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.05 })} />,
    )
    expect(html).toContain('Failure Rate')
  })

  it('renders formatted percent value for failure_rate', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.05 })} />,
    )
    expect(html).toContain('5.0%')
  })

  it('renders formatted percent value for autonomous_completion_rate', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'autonomous_completion_rate', currentValue: 0.9 })} />,
    )
    expect(html).toContain('90.0%')
  })

  it('renders formatted percent value for recovery_success_rate', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'recovery_success_rate', currentValue: 0.75 })} />,
    )
    expect(html).toContain('75.0%')
  })
})

describe('KpiTile — sparkline rendering', () => {
  it('renders an svg element regardless of series data', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.05 })} />,
    )
    expect(html).toContain('<svg')
  })

  it('renders a polyline when series has >= 2 non-null points', () => {
    const html = renderToStaticMarkup(
      <KpiTile
        kpi={kpi({
          key: 'failure_rate',
          currentValue: 0.05,
          series: [point(0.04), point(0.05), point(0.06)],
        })}
      />,
    )
    expect(html).toContain('<polyline')
  })

  it('does NOT render a polyline when series is empty (flat baseline)', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'failure_rate', currentValue: 0.05, series: [] })} />,
    )
    expect(html).not.toContain('<polyline')
  })

  it('does NOT render a polyline when series has only 1 non-null point', () => {
    const html = renderToStaticMarkup(
      <KpiTile
        kpi={kpi({
          key: 'failure_rate',
          currentValue: 0.05,
          series: [point(0.05)],
        })}
      />,
    )
    expect(html).not.toContain('<polyline')
  })

  it('does NOT render a polyline when all series points are null', () => {
    const html = renderToStaticMarkup(
      <KpiTile
        kpi={kpi({
          key: 'failure_rate',
          currentValue: 0.05,
          series: [point(null), point(null)],
        })}
      />,
    )
    expect(html).not.toContain('<polyline')
  })
})

// ---------------------------------------------------------------------------
// Low-confidence path
// ---------------------------------------------------------------------------

describe('KpiTile low-confidence', () => {
  it('renders the label and "insufficient samples" when lowConfidence is true', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, lowConfidence: true })} />,
    )
    expect(html).toContain('Cost per Arc')
    expect(html).toContain('insufficient samples')
    expect(html).toContain('kpi-tile--low-confidence')
  })

  it('suppresses sparkline and formatted value when lowConfidence is true', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, lowConfidence: true })} />,
    )
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('3 tok')
  })

  it('renders the full tile (sparkline + formatted value) when lowConfidence is false', () => {
    const html = renderToStaticMarkup(
      <KpiTile kpi={kpi({ key: 'cost_per_arc', currentValue: 2.5, lowConfidence: false })} />,
    )
    expect(html).toContain('<svg')
    expect(html).toContain('3 tok')
    expect(html).not.toContain('insufficient samples')
    expect(html).not.toContain('kpi-tile--low-confidence')
  })
})
