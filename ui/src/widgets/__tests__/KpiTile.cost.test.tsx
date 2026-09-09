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
  return {
    trend,
    current: {
      costUsd: 0,
      tokens: 0,
      mergedCount: days * 3,
      avgCostPerMerge: endValue,
      excludedNullCostCount: 0,
    },
  }
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

  // The arrow is an IMPROVEMENT arrow (↑ = better, matching kpiDriftDirection
  // and KpiDetailPage's ↑ Improved / ↓ Regressed convention), not a
  // value-direction arrow — for a lower-is-better metric like cost, a falling
  // value is an *improvement* and gets ↑ even while the sparkline visibly
  // descends. That reading is only legible if the tile also says the word
  // ("cheaper"/"dearer") next to the arrow; a bare glyph reads as the
  // literal-but-wrong "cost went up".
  it('shows an up arrow with "cheaper" when cost improved (decreased)', () => {
    // cost went from $3.00 to $1.50 → improved → up, $1.50 cheaper.
    // The arrow is a Lucide icon now, not a "↑" character, so assert the icon.
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 3.0, 1.5),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('lucide-arrow-up')
    expect(html).not.toContain('lucide-arrow-down')
    expect(html).toContain('cheaper')
  })

  it('shows a down arrow with "dearer" when cost regressed (increased)', () => {
    // cost went from $1.00 to $2.00 → regressed → down, $1.00 dearer.
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 1.0, 2.0),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('lucide-arrow-down')
    expect(html).not.toContain('lucide-arrow-up')
    expect(html).toContain('dearer')
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

  it('shows the value from a single priced day, with no delta', () => {
    // One priced day is a real measurement. Suppressing it was the same
    // over-caution that let a broken response read as thin data.
    mockUseCost.mockReturnValue({
      data: {
        trend: [{ day: '2024-01-01', mergedCount: 5, avgCostPerMerge: 1.0 }],
        current: { costUsd: 5, tokens: 0, mergedCount: 5, avgCostPerMerge: 1.0, excludedNullCostCount: 0 },
      },
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('$1.00')
    expect(html).not.toContain('insufficient data')
    // No second priced day to compare against, so no delta arrow.
    expect(html).not.toContain('↑')
    expect(html).not.toContain('↓')
  })

  it('reads the freshest PRICED day, not simply the last entry', () => {
    // Older tasks predate usage signals, so the head of the window is null
    // while the tail is populated — and a day with no priced task yet must not
    // blank a tile that has real numbers behind it.
    mockUseCost.mockReturnValue({
      data: {
        trend: [
          { day: '2024-01-01', mergedCount: 2, avgCostPerMerge: null },
          { day: '2024-01-02', mergedCount: 5, avgCostPerMerge: 2.5 },
          { day: '2024-01-03', mergedCount: 0, avgCostPerMerge: null },
        ],
        current: { costUsd: 12.5, tokens: 0, mergedCount: 7, avgCostPerMerge: 2.5, excludedNullCostCount: 2 },
      },
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('$2.50')
    expect(html).not.toContain('insufficient data')
  })

  it('says it failed to load rather than blaming the data', () => {
    // The schema declared a field the daemon never sent, so every response
    // failed validation and the tile reported "insufficient data" — a
    // statement about the repo, for what was a contract bug.
    mockUseCost.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('GET /api/kpi/cost-per-merged-task → schema mismatch'),
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('failed to load')
    expect(html).not.toContain('insufficient data')
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
