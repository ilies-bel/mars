/**
 * Unit tests for the ProgressPage proposal-filter control.
 *
 * The control is conditional on the presence of in-scope proposals and is the
 * only page-level concern for this slice.  Filtering behaviour downstream
 * (ghosting in TopologyView, card removal in BoardView) is covered by the
 * widget-level tests.
 *
 * Hooks that make network requests are mocked at the module boundary so this
 * file has no runtime dependencies on React Query or SSE.
 */

import { mock, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Cluster, ProgressProposalNode, ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Stubs — declared before the dynamic imports so hoisting is satisfied
// ---------------------------------------------------------------------------

const emptyByCluster = (): Record<Cluster, ProgressTask[]> => ({
  Queued: [],
  'In progress': [],
  Blocked: [],
  Failed: [],
})

const baseState = (proposals: ProgressProposalNode[]) => ({
  tasks: [],
  proposals,
  byCluster: emptyByCluster(),
  error: null,
  connected: true,
})

// mock.fn allows per-test overrides via mockImplementation
const mockUseProgress = mock(baseState([
  { id: 'p1', title: 'Feature Alpha', source: 'human' as const, status: 'draft' },
  { id: 'p2', title: 'Feature Beta', source: 'human' as const, status: 'draft' },
]))

mock.module('@/hooks/useProgress', () => ({
  useProgress: mockUseProgress,
}))

mock.module('@/entities/todo/useTodo', () => ({
  useTodo: () => ({ drafts: [], staleWorktrees: [], error: null, connected: true }),
}))

mock.module('@/entities/kpi/useKpis', () => ({
  useKpis: () => ({ data: undefined, isLoading: false, error: null }),
}))

const { ProgressPage } = await import('./ProgressPage')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProgressPage – proposal filter control', () => {
  it('renders the proposal-filter control when in-scope proposals are present', () => {
    const html = renderToStaticMarkup(<ProgressPage />)
    expect(html).toContain('data-testid="proposal-filter"')
  })

  it('lists each proposal title as an option in the filter dropdown', () => {
    const html = renderToStaticMarkup(<ProgressPage />)
    expect(html).toContain('Feature Alpha')
    expect(html).toContain('Feature Beta')
  })

  it('includes an "All" option so the filter can be cleared', () => {
    const html = renderToStaticMarkup(<ProgressPage />)
    expect(html).toContain('>All<')
  })

  it('hides the proposal-filter control when there are no in-scope proposals', () => {
    mockUseProgress.mockImplementation(() => baseState([]))
    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      expect(html).not.toContain('data-testid="proposal-filter"')
    } finally {
      // Restore the default implementation for subsequent tests
      mockUseProgress.mockImplementation(() =>
        baseState([
          { id: 'p1', title: 'Feature Alpha', source: 'human', status: 'draft' },
          { id: 'p2', title: 'Feature Beta', source: 'human', status: 'draft' },
        ]),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Responsive layout: nav sidebar must not squeeze content on narrow viewports.
// ---------------------------------------------------------------------------

describe('ProgressPage – responsive layout', () => {
  it('nav sidebar is hidden on mobile and visible on sm+ breakpoint', () => {
    const html = renderToStaticMarkup(<ProgressPage />)
    // hidden hides on all sizes; sm:flex reveals it at ≥640px.
    expect(html).toContain('hidden sm:flex')
  })
})

// ---------------------------------------------------------------------------
// Search input: always visible on the Progress tab.
// ---------------------------------------------------------------------------

describe('ProgressPage – search input', () => {
  it('renders a text search input on the Progress tab', () => {
    const html = renderToStaticMarkup(<ProgressPage />)
    expect(html).toContain('data-testid="search-tasks"')
  })

  it('search input is a text input element', () => {
    const html = renderToStaticMarkup(<ProgressPage />)
    expect(html).toMatch(/data-testid="search-tasks"/)
    // The element carrying data-testid must be or contain an input
    expect(html).toMatch(/type="(?:text|search)"[^>]*data-testid="search-tasks"|data-testid="search-tasks"[^>]*type="(?:text|search)"/)
  })
})
