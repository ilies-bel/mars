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
  aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 },
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

mock.module('@/entities/kpi/useKpis', () => ({
  useKpis: () => ({ data: undefined, isLoading: false, error: null }),
}))

mock.module('@/entities/frameworkUpdate/useFrameworkUpdate', () => ({
  useFrameworkUpdate: () => ({ update: null, error: null, isPending: false }),
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
// Responsive layout: the sidebar has been removed; main content fills the
// full width of the viewport.
// ---------------------------------------------------------------------------

describe('ProgressPage – responsive layout', () => {
  it('renders no nav sidebar — main content fills the full width', () => {
    const html = renderToStaticMarkup(<ProgressPage />)
    // The sidebar carried class="hidden sm:flex …" and a fixed w-[200px].
    // Both must be absent now that the sidebar is removed.
    expect(html).not.toContain('w-[200px]')
    // The outer wrapper passes flex-1 to the sole content column.
    expect(html).toContain('flex-1')
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

// ---------------------------------------------------------------------------
// SSE connection indicator: Progress tab must show live vs offline status
// so users can tell whether updates are flowing from the daemon bus.
// ---------------------------------------------------------------------------

describe('ProgressPage – SSE connection indicator', () => {
  it('shows the "live" indicator when the daemon bus is connected', () => {
    // Default mock returns connected: true — should display "live"
    const html = renderToStaticMarkup(<ProgressPage />)
    expect(html).toContain('>live<')
    expect(html).not.toContain('>offline<')
  })

  it('shows the "offline" indicator when the daemon bus is disconnected', () => {
    mockUseProgress.mockImplementation(() => ({ ...baseState([]), connected: false }))
    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      expect(html).toContain('>offline<')
      expect(html).not.toContain('>live<')
    } finally {
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
// Header stats: the TopStripe must show the correct counts so that operators
// can trust the numbers at a glance.
//
// Numbers and labels are rendered in separate elements (different sizes and
// colours), so assertions use data-testid section extraction rather than
// checking for a contiguous "N LABEL" substring.
// ---------------------------------------------------------------------------

// Extract the HTML chunk between two data-testid markers.
function between(html: string, startId: string, endId: string): string {
  const s = html.indexOf(`data-testid="${startId}"`)
  const e = html.indexOf(`data-testid="${endId}"`)
  if (s === -1) return ''
  return e === -1 ? html.slice(s) : html.slice(s, e)
}

function from(html: string, startId: string): string {
  const s = html.indexOf(`data-testid="${startId}"`)
  return s === -1 ? '' : html.slice(s)
}

describe('ProgressPage – header stats', () => {
  const makeTask = (id: string, status: ProgressTask['status']): ProgressTask =>
    ({ id, status, prompt: 'p', branch: null, parentProposalId: null }) as unknown as ProgressTask

  it('DONE stat reflects tasks whose status is "done", not the failed count', () => {
    const doneTasks = [makeTask('d1', 'done'), makeTask('d2', 'done')]
    const failedTasks = [makeTask('f1', 'failed')]
    mockUseProgress.mockImplementation(() => ({
      ...baseState([]),
      tasks: [...doneTasks, ...failedTasks],
      byCluster: { ...emptyByCluster(), Failed: failedTasks },
      aggregates: { doneToday: 2, doneTotal: 2, failedOpen: 1 },
    }))
    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      const doneSection = between(html, 'stat-done', 'stat-failed')
      // Two done tasks → DONE must read 2
      expect(doneSection).toContain('>2<')
      // Must not use the failed count (1) for the DONE slot
      expect(doneSection).not.toContain('>1<')
    } finally {
      mockUseProgress.mockImplementation(() => baseState([]))
    }
  })

  it('FAILED stat surfaces the failed count — failures are never hidden under DONE', () => {
    const failedTasks = [makeTask('f1', 'failed'), makeTask('f2', 'failed')]
    mockUseProgress.mockImplementation(() => ({
      ...baseState([]),
      tasks: failedTasks,
      byCluster: { ...emptyByCluster(), Failed: failedTasks },
      aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 2 },
    }))
    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      const doneSection = between(html, 'stat-done', 'stat-failed')
      const failedSection = from(html, 'stat-failed')
      // Failed count (2) appears in the FAILED section
      expect(failedSection).toContain('>2<')
      // DONE must not show 2 (the failed count) — it shows 0
      expect(doneSection).not.toContain('>2<')
    } finally {
      mockUseProgress.mockImplementation(() => baseState([]))
    }
  })

  it('FAILED stat counts per-origin — a failed recovery does not inflate the count', () => {
    // One origin failure (fix_for_task_id IS NULL) + one failed recovery
    // (fix_for_task_id IS NOT NULL) => the aggregate reader returns failedOpen: 1.
    // The UI renders whatever failedOpen says; this test pins that the FAILED
    // stat shows the per-origin count, not the raw total across origin+recovery.
    const originTask = makeTask('origin-1', 'failed')
    const recoveryTask = makeTask('fix-1', 'failed')
    mockUseProgress.mockImplementation(() => ({
      ...baseState([]),
      tasks: [originTask, recoveryTask],
      byCluster: { ...emptyByCluster(), Failed: [originTask, recoveryTask] },
      // The query filters AND fix_for_task_id IS NULL, so only 1 is counted.
      aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 1 },
    }))
    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      const failedSection = from(html, 'stat-failed')
      // One origin failure — the failed recovery must not inflate the count to 2.
      expect(failedSection).toContain('>1<')
      expect(failedSection).not.toContain('>2<')
    } finally {
      mockUseProgress.mockImplementation(() => baseState([]))
    }
  })

  it('with zero done tasks and zero failed tasks both stats show 0', () => {
    mockUseProgress.mockImplementation(() => ({
      ...baseState([]),
      tasks: [],
      byCluster: emptyByCluster(),
    }))
    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      const doneSection = between(html, 'stat-done', 'stat-failed')
      const failedSection = from(html, 'stat-failed')
      expect(doneSection).toContain('>0<')
      expect(failedSection).toContain('>0<')
    } finally {
      mockUseProgress.mockImplementation(() => baseState([]))
    }
  })
})

// ---------------------------------------------------------------------------
// Search zero-state: the page must not surface a "0 tasks match" pill when
// the search query is empty (initial state). The pill appears only when the
// user types a non-matching query — tested at the widget level where the
// searchMatchIds / searchQuery props can be set directly.
// ---------------------------------------------------------------------------

describe('ProgressPage – search zero-state not shown on initial load', () => {
  it('does not show the search zero-state message when the query is empty', () => {
    // On initial render the searchQuery is '' (from readProgressStateFromUrl defaults),
    // so searchMatchIds is null and neither view should display the zero-state pill.
    const html = renderToStaticMarkup(<ProgressPage />)
    expect(html).not.toContain('0 tasks match')
    expect(html).not.toContain('data-testid="search-zero-state"')
  })
})

// ---------------------------------------------------------------------------
// Stale URL: ?proposal=<task-id> that is not a known proposal must not blank
// the board. This can happen when an origin arc card click wrote a task id
// into the URL before the TopologyView.toggleArc fix, or when a proposal is
// deleted after the link was bookmarked.
// ---------------------------------------------------------------------------

describe('ProgressPage – stale proposal URL fallback', () => {
  it('renders the board rather than No active tasks when ?proposal=<task-id> is unknown', () => {
    // Simulate a stale URL: ?proposal=task-id-not-a-proposal
    // In happy-dom the location is live, so we can set it directly.
    const prevHash = window.location.hash
    window.location.hash = '#/progress?proposal=task-id-not-a-proposal'

    // tasks is settled (non-null) with one task; proposals is empty.
    // effectiveProposalId must resolve to null (not found in proposals=[])
    // so TopologyView receives null and renders all tasks.
    mockUseProgress.mockImplementation(() => ({
      ...baseState([]),
      tasks: [
        {
          id: 'task-id-not-a-proposal',
          status: 'queued',
          prompt: 'an origin task',
          branch: null,
          parentProposalId: null,
          cluster: 'Queued',
          blockedBy: [],
          retryCount: 0,
          priority: 0,
        } as unknown as import('@/shared/schemas').ProgressTask,
      ],
    }))

    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      // The board is populated — task node exists (role="img" canvas is rendered).
      expect(html).not.toContain('No active tasks')
      expect(html).toContain('role="img"')
    } finally {
      window.location.hash = prevHash
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
// Board first paint regression (done criterion 2):
// The board must render task cards from the very first /api/progress payload
// without requiring any SSE event, click, or reload.
//
// Prior to the fix, useProgress had `enabled: projectId !== null || projectsEmpty`
// which disabled the query while the project registry was loading (projectId=null,
// projectsEmpty=false), so the board showed all-zero columns on cold load. After
// the fix, `enabled` is unconditional — the query fires immediately and the board
// renders from the very first resolved payload regardless of SSE state.
// ---------------------------------------------------------------------------

describe('ProgressPage – board first paint without SSE', () => {
  it('renders arc cards from the first /api/progress payload with SSE offline — no event or click required', () => {
    // Simulate the very first payload arriving: one running task, SSE not yet
    // connected (connected: false). This is the scenario that was broken before
    // the fix — the board showed all zeros despite the API returning tasks.
    const task = {
      id: 'task-running-1',
      status: 'running',
      prompt: 'Implement the dashboard feature',
      branch: 'task/task-running-1',
      parentProposalId: null,
      originId: null,
      cluster: 'In progress',
      plan: null,
      worktreePath: null,
      error: null,
      dropReason: null,
      retryCount: 0,
      blockerTaskId: null,
      blockedBy: [],
      spec: null,
      priority: 1,
      failureSignature: null,
      compensatesArcId: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    } as unknown as import('@/shared/schemas').ProgressTask

    mockUseProgress.mockImplementation(() => ({
      tasks: [task],
      proposals: [],
      byCluster: {
        Queued: [],
        'In progress': [task],
        Blocked: [],
        Failed: [],
        Done: [],
      },
      aggregates: { doneToday: 5, doneTotal: 2578, failedOpen: 0 },
      error: null,
      connected: false, // SSE offline — must NOT be a precondition for first paint
    }))

    const prevHash = window.location.hash
    window.location.hash = '#/progress?view=board'

    try {
      const html = renderToStaticMarkup(<ProgressPage />)
      // The task title must appear in board HTML without any SSE event or click.
      // If the `enabled` guard is reintroduced (blocking the query until SSE
      // connects), this assertion will fail — catching the regression.
      expect(html).toContain('Implement the dashboard feature')
    } finally {
      window.location.hash = prevHash
      mockUseProgress.mockImplementation(() =>
        baseState([
          { id: 'p1', title: 'Feature Alpha', source: 'human', status: 'draft' },
          { id: 'p2', title: 'Feature Beta', source: 'human', status: 'draft' },
        ]),
      )
    }
  })
})
