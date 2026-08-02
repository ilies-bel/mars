// @vitest-environment happy-dom
/**
 * Tests for LoopLedgerPanel.
 *
 * Both useLoopLedger and useScorerWorkflows are mocked so tests run without a
 * QueryClientProvider or live server — matching the pattern established by
 * PromotionLedgerTable.test.tsx. Selector interaction is verified via
 * createRoot + act, following NavBar.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LoopLedgerEntry } from '@/entities/watchtower/useLoopLedger'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEntry = (
  runId: string,
  hasSuggestion: boolean,
  hasReview: boolean,
): LoopLedgerEntry => ({
  runId,
  scoredAt: 1700000000000,
  score: 0.85,
  recordedAt: 1700000001000,
  suggestion: hasSuggestion ? { version: 'v1.2.3' } : null,
  review: hasReview ? { decision: 'accepted' } : null,
})

const WORKFLOWS = ['implement', 'review']

const ENTRIES: LoopLedgerEntry[] = [
  makeEntry('run-001', true, true),
  makeEntry('run-002', false, false),
]

// ---------------------------------------------------------------------------
// Module mocks — declared before any dynamic import of the component
// ---------------------------------------------------------------------------

vi.mock('@/entities/watchtower/useScorerWorkflows', () => ({
  useScorerWorkflows: vi.fn(() => ({
    data: WORKFLOWS,
    isLoading: false,
    error: null,
  })),
}))

vi.mock('@/entities/watchtower/useLoopLedger', () => ({
  useLoopLedger: vi.fn(() => ({
    entries: ENTRIES,
    isLoading: false,
    error: null,
  })),
}))

import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useLoopLedger } from '@/entities/watchtower/useLoopLedger'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LoopLedgerPanel', () => {
  beforeEach(() => {
    vi.mocked(useScorerWorkflows).mockReturnValue({
      data: WORKFLOWS,
      isLoading: false,
      error: null,
    })
    vi.mocked(useLoopLedger).mockReturnValue({
      entries: ENTRIES,
      isLoading: false,
      error: null,
    })
  })

  it('renders all six column headers', async () => {
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    for (const col of ['Run', 'Scored at', 'Score', 'Recorded', 'Suggest', 'Review']) {
      expect(html, `column header "${col}" missing`).toContain(col)
    }
  })

  it('renders one data row per entry (2 entries → 2 data rows plus header)', async () => {
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    // 1 header row + 2 data rows = 3 <tr> elements
    const trCount = (html.match(/<tr/g) ?? []).length
    expect(trCount).toBe(3)
  })

  it('shows a fetch failure instead of claiming there are no loop runs', async () => {
    vi.mocked(useLoopLedger).mockReturnValue({
      entries: [],
      isLoading: false,
      error: new Error('daemon unreachable'),
    })

    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    expect(html).toContain('Couldn&#x27;t load loop ledger')
    expect(html).not.toContain('No loop runs yet')
  })

  it('renders entry values and — for missing suggestion/review', async () => {
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    // Both run IDs appear
    expect(html).toContain('run-001')
    expect(html).toContain('run-002')

    // Entry with suggestion/review shows them
    expect(html).toContain('v1.2.3')
    expect(html).toContain('accepted')

    // Entry without suggestion/review shows — (at least 2 dashes)
    const dashCount = (html.match(/—/g) ?? []).length
    expect(dashCount).toBeGreaterThanOrEqual(2)
  })

  it('selector onChange causes useLoopLedger to be called with the new workflow', async () => {
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')

    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)

    await act(async () => {
      root.render(<LoopLedgerPanel />)
    })

    const select = div.querySelector('select')!
    expect(select).not.toBeNull()

    // Verify initial workflow is passed (first workflow from the list)
    const callsBefore = vi.mocked(useLoopLedger).mock.calls
    expect(callsBefore[callsBefore.length - 1][0]).toBe(WORKFLOWS[0])

    // Change selection to the second workflow
    await act(async () => {
      select.value = WORKFLOWS[1]
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // After the change, useLoopLedger must have been called with the new workflow
    const callsAfter = vi.mocked(useLoopLedger).mock.calls
    expect(callsAfter[callsAfter.length - 1][0]).toBe(WORKFLOWS[1])

    await act(async () => {
      root.unmount()
    })
    document.body.removeChild(div)
  })
})
