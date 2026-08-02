// @vitest-environment happy-dom
/**
 * Tests for PromotionLedgerTable.
 *
 * usePromotionLedger is mocked so tests run without a QueryClientProvider or
 * live server — matching the pattern established by WatchtowerTrendChart.test.tsx.
 * Click-driven row expansion is verified via createRoot + act in the happy-dom
 * environment, following NavBar.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PromotionLedgerEntry } from '@/entities/watchtower/usePromotionLedger'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEntry = (
  id: string,
  decision: PromotionLedgerEntry['decision'],
): PromotionLedgerEntry => ({
  id,
  workflow: 'implement',
  candidateVersionId: 'cfg-abc123',
  incumbentVersionId: 'cfg-def456',
  candidateScore: 0.85,
  incumbentScore: 0.7,
  candidateN: 10,
  incumbentN: 10,
  decision,
  decidedAt: 1700000000000,
  createdAt: 1700000001000,
})

const ENTRIES: PromotionLedgerEntry[] = [
  makeEntry('pl-0001', 'promoted'),
  makeEntry('pl-0002', 'retired'),
]

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any dynamic import of the component
// ---------------------------------------------------------------------------

vi.mock('@/entities/watchtower/usePromotionLedger', () => ({
  usePromotionLedger: vi.fn(() => ({
    entries: ENTRIES,
    isLoading: false,
    error: null,
  })),
}))

import { usePromotionLedger } from '@/entities/watchtower/usePromotionLedger'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromotionLedgerTable', () => {
  beforeEach(() => {
    vi.mocked(usePromotionLedger).mockReturnValue({
      entries: ENTRIES,
      isLoading: false,
      error: null,
    })
  })

  it('renders one <tr> per entry (2 entries → 2 data rows plus 1 header)', async () => {
    const { PromotionLedgerTable } = await import('./PromotionLedgerTable')
    const html = renderToStaticMarkup(<PromotionLedgerTable />)

    // 1 header row + 2 data rows = 3 <tr> elements
    const trCount = (html.match(/<tr/g) ?? []).length
    expect(trCount).toBe(3)

    // Both decisions appear in the output
    expect(html).toContain('promoted')
    expect(html).toContain('retired')
  })

  it('shows a fetch failure instead of claiming there are no promotions', async () => {
    vi.mocked(usePromotionLedger).mockReturnValue({
      entries: [],
      isLoading: false,
      error: new Error('daemon unreachable'),
    })

    const { PromotionLedgerTable } = await import('./PromotionLedgerTable')
    const html = renderToStaticMarkup(<PromotionLedgerTable />)

    expect(html).toContain('Couldn&#x27;t load promotions')
    expect(html).not.toContain('No promotions yet')
  })

  it('clicking a row expands a sibling <tr> revealing the evidence JSON', async () => {
    const { PromotionLedgerTable } = await import('./PromotionLedgerTable')

    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)

    await act(async () => {
      root.render(<PromotionLedgerTable />)
    })

    // Before any click: no evidence panel
    expect(div.querySelector('pre')).toBeNull()

    // tbody should have exactly 2 data rows
    expect(div.querySelectorAll('tbody tr').length).toBe(2)

    // Click the first data row to expand it
    await act(async () => {
      div
        .querySelector('tbody tr')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Evidence <pre> should now be visible and contain the entry's id
    const pre = div.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('pl-0001')

    // Click the first data row again to collapse
    await act(async () => {
      div
        .querySelector('tbody tr')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Evidence panel collapses
    expect(div.querySelector('pre')).toBeNull()

    await act(async () => {
      root.unmount()
    })
    document.body.removeChild(div)
  })
})
