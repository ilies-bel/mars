/**
 * Tests for CostPerMergedTaskTile — the cost-per-merged-task KPI tile
 * rendered in KpiVector.
 *
 * The tile must:
 *   - show the title "Cost / merged task"
 *   - show the current value formatted as USD
 *   - show a 7-day delta arrow (↑ when cost improved, ↓ when it regressed)
 *   - show a low-confidence placeholder when trend data is insufficient
 *
 * Link must point to #/kpi/cost-per-merged-task.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CostPerMergedTaskResponse } from '@/shared/schemas'
import { CostPerMergedTaskTile } from '../CostPerMergedTaskTile'

vi.mock('@/entities/kpi/useCostPerMergedTask')

import { useCostPerMergedTask } from '@/entities/kpi/useCostPerMergedTask'

const mockUseCost = vi.mocked(useCostPerMergedTask)

const makeTrend = (days: number, startValue: number, endValue: number): CostPerMergedTaskResponse => {
  const trend = Array.from({ length: days }, (_, i) => ({
    day: `2024-01-${String(i + 1).padStart(2, '0')}`,
    mergedCount: 3,
    avgCostPerMerge: startValue + ((endValue - startValue) * i) / Math.max(days - 1, 1),
  }))
  return { trend, excludedCostNullCount: 0 }
}

describe('CostPerMergedTaskTile — title and link', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('renders the tile title "Cost / merged task"', () => {
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 2.0, 1.5),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('Cost / merged task')
  })

  it('links to #/kpi/cost-per-merged-task', () => {
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 2.0, 1.5),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('href="#/kpi/cost-per-merged-task"')
  })
})

describe('CostPerMergedTaskTile — USD value formatting', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('shows the current value in USD', () => {
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 2.0, 1.5),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    // Last value is 1.5 → $1.50
    expect(html).toContain('$1.50')
  })

  it('formats a value with two decimal places', () => {
    mockUseCost.mockReturnValue({
      data: makeTrend(2, 3.0, 3.0),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('$3.00')
  })
})

describe('CostPerMergedTaskTile — delta arrow', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('shows ↑ arrow when cost improved (decreased)', () => {
    // cost went from $3.00 to $1.50 → improved → ↑
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 3.0, 1.5),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('↑')
    expect(html).not.toContain('↓')
  })

  it('shows ↓ arrow when cost regressed (increased)', () => {
    // cost went from $1.00 to $2.00 → regressed → ↓
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 1.0, 2.0),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('↓')
    expect(html).not.toContain('↑')
  })

  it('omits the delta arrow when cost is unchanged', () => {
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 2.0, 2.0),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).not.toContain('↑')
    expect(html).not.toContain('↓')
  })
})

describe('CostPerMergedTaskTile — loading and low-confidence states', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('renders nothing meaningful while loading (skeleton placeholder)', () => {
    mockUseCost.mockReturnValue({ data: undefined, isLoading: true, error: null })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    // No tile content while loading
    expect(html).not.toContain('Cost / merged task')
  })

  it('renders the low-confidence placeholder when data is undefined', () => {
    mockUseCost.mockReturnValue({ data: undefined, isLoading: false, error: null })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('Cost / merged task')
    expect(html).toContain('insufficient data')
  })

  it('renders the low-confidence placeholder when trend has only one point', () => {
    mockUseCost.mockReturnValue({
      data: { trend: [{ day: '2024-01-01', mergedCount: 5, avgCostPerMerge: 1.0 }], excludedCostNullCount: 0 },
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('insufficient data')
  })
})

describe('CostPerMergedTaskTile — sparkline', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('renders an SVG sparkline when trend has sufficient data', () => {
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 2.0, 1.5),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('<svg')
  })
})
