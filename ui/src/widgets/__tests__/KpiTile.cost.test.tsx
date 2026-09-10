/**
 * Tests for CostPerMergedTaskTile — the cost-per-merged-task KPI tile
 * rendered in KpiVector.
 *
 * The tile must:
 *   - show the title "Cost / merged task"
 *   - show the current value formatted as USD
 *   - show a 7-day delta arrow pointing the way the VALUE moved
 *     (↓ when cost fell, ↑ when it rose), with the verdict carried by the
 *     adjacent word and colour
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

  // The arrow is a VALUE-DIRECTION arrow: it points the way the number moved.
  //
  // It was an improvement arrow (↑ = better, per kpiDriftDirection and
  // KpiDetailPage) until the round-7 UX review. That convention made the tile
  // disagree with itself — a descending sparkline, an ascending arrow and the
  // word "cheaper", all within ~100px — and the arrow, being the boldest mark,
  // won the first read. It was also redundant: "improved" is already stated by
  // the colour and by "cheaper"/"dearer", so an improvement arrow added no
  // information while adding a way to be wrong.
  //
  // Now: cost fell → ArrowDown + "lower" + success; cost rose → ArrowUp +
  // "higher" + error. Direction from the arrow, magnitude from the figure,
  // verdict from the colour — each said once. KpiDetailPage keeps its own
  // convention; it has no sparkline beside it to contradict.
  //
  // "cheaper"/"dearer" became "lower"/"higher" when the five tiles were put on
  // one shell. Those words were a third statement of the verdict the colour
  // already carried, and only this tile — the one measuring money — could say
  // them at all, so the row read in two grammars. The unit-neutral pair says
  // the one thing the arrow says, which is what the reader needs to pair the
  // figure with the sparkline beside it.
  it('shows a down arrow when the value fell', () => {
    // cost went from $3.00 to $1.50 → the value FELL, so the arrow points down;
    // the success colour carries the verdict.
    // The arrow is a Lucide icon, not a "↓" character, so assert the icon.
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 3.0, 1.5),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('lucide-arrow-down')
    expect(html).not.toContain('lucide-arrow-up')
    expect(html).toContain('lower')
    expect(html).toContain('text-success')
  })

  it('shows an up arrow when the value rose', () => {
    // cost went from $1.00 to $2.00 → the value ROSE, so the arrow points up;
    // the error colour carries the verdict.
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 1.0, 2.0),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('lucide-arrow-up')
    expect(html).not.toContain('lucide-arrow-down')
    expect(html).toContain('higher')
    expect(html).toContain('text-error')
  })

  it('names the window it actually compared against', () => {
    // This tile compares the first and last priced day INSIDE its own window.
    // The four vector tiles compare this window against the PREVIOUS one. Both
    // were about to read "than 7d ago", which is false for the vector and
    // would have been invisible.
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 1.0, 2.0),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    expect(html).toContain('across the last 7d')
    expect(html).not.toContain('vs previous')
  })

  it('states a verdict band, the same fact its four neighbours state', () => {
    // The row is read across, not tile by tile. Four tiles saying "Bad · last
    // 7d" beside a fifth saying only "$0.79 dearer" invited a comparison the
    // row could not support: nothing said whether $4.02 was acceptable.
    mockUseCost.mockReturnValue({
      data: makeTrend(7, 1.0, 2.0),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<CostPerMergedTaskTile />)
    // $2.00 sits in the warn band (good < $1, bad > $5).
    expect(html).toContain('Near limit · target under $1.00 · last 7d')
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
