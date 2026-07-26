// @vitest-environment happy-dom
/**
 * Unit tests for the ReleaseNotesModal widget.
 *
 * `useQuery` is mocked at the module boundary (the project's hook-mocking
 * convention) so each test drives a fixed query result synchronously inside
 * `renderToStaticMarkup`. This lets us cover:
 *   - The empty state ("No work has landed yet.")
 *   - A populated list: title, relative date, recovery badge
 *   - Loading and error states
 *   - "new since you were away" divider above the oldest unseen entry
 *   - scrollIntoView is invoked on the oldest-unseen ref
 *   - click-outside (scrim) dismissal triggers the 180 ms exit animation
 *     and calls onClose
 */
import { mock, describe, expect, it, beforeEach, vi } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { ReleaseNoteEntry, ReleaseNotesCursor } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRY_NO_RECOVERY: ReleaseNoteEntry = {
  originId: 'mars-abc1',
  title: 'Add the release notes feed',
  landedAt: '2026-06-01T12:00:00.000Z',
  detail: {
    prompt: 'Implement the /api/release-notes endpoint.',
    spec: null,
    recoveryCount: 0,
  },
}

const ENTRY_WITH_RECOVERY: ReleaseNoteEntry = {
  originId: 'mars-abc2',
  title: 'Fix the flaky test',
  landedAt: '2026-06-02T09:00:00.000Z',
  detail: {
    prompt: 'The flaky test was fixed.',
    spec: {
      files: ['src/foo.ts'],
      verifyCmd: 'npm test',
      doneCriteria: ['All tests pass'],
    },
    recoveryCount: 2,
  },
}

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the dynamic import so hoisting works.
// ---------------------------------------------------------------------------

type QueryResult = {
  isPending: boolean
  isError: boolean
  data: ReleaseNoteEntry[] | undefined
}

const LOADING: QueryResult = { isPending: true, isError: false, data: undefined }
const ERROR_RESULT: QueryResult = { isPending: false, isError: true, data: undefined }
const empty = (): QueryResult => ({ isPending: false, isError: false, data: [] })
const loaded = (entries: ReleaseNoteEntry[]): QueryResult => ({
  isPending: false,
  isError: false,
  data: entries,
})

// Shared mutable so each test can override before rendering.
let nextResult: QueryResult = LOADING
// Mutable cursor result — override per test to drive divider behaviour.
let nextCursorResult: { isPending: boolean; isError: boolean; data: ReleaseNotesCursor | undefined } = {
  isPending: false,
  isError: false,
  // Default: no prior cursor → computeUnseen returns zero unseen, no divider.
  data: { lastViewedAt: null },
}

// Spy on postReleaseNotesViewed so tests can assert when it is (and isn't) called.
const mockPostViewed = vi.fn()

mock.module('@/shared/api', () => ({
  fetchReleaseNotes: async (): Promise<ReleaseNoteEntry[]> => [],
  getReleaseNotesCursor: async (): Promise<ReleaseNotesCursor> => ({ lastViewedAt: null }),
  postReleaseNotesViewed: mockPostViewed,
}))

mock.module('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
}))

// Distinguish the two useQuery calls by their queryKey[0].
mock.module('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
    queryKey[0] === 'release-notes-cursor' ? nextCursorResult : nextResult,
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}))

// computeUnseen is a pure function imported directly — no need to mock it.

const { ReleaseNotesModal, PAGE_SIZE } = await import('./ReleaseNotesModal')

// Reset the postReleaseNotesViewed spy before each test so call counts are isolated.
beforeEach(() => {
  mockPostViewed.mockClear()
  mockPostViewed.mockResolvedValue({ lastViewedAt: '2026-07-03T00:00:00.000Z' })
})

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

const render = (result: QueryResult, cursor?: ReleaseNotesCursor): string => {
  nextResult = result
  if (cursor !== undefined) {
    nextCursorResult = { isPending: false, isError: false, data: cursor }
  } else {
    nextCursorResult = { isPending: false, isError: false, data: { lastViewedAt: null } }
  }
  return renderToStaticMarkup(<ReleaseNotesModal onClose={() => {}} />)
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('ReleaseNotesModal – empty state', () => {
  it('shows the empty-state message when there are no landed arcs', () => {
    const html = render(empty())
    expect(html).toContain('No work has landed yet.')
    expect(html).not.toContain('data-testid="release-notes-list"')
  })
})

// ---------------------------------------------------------------------------
// Populated list
// ---------------------------------------------------------------------------

describe('ReleaseNotesModal – populated list', () => {
  it('renders a row for each entry with its title', () => {
    const html = render(loaded([ENTRY_NO_RECOVERY, ENTRY_WITH_RECOVERY]))
    expect(html).toContain('Add the release notes feed')
    expect(html).toContain('Fix the flaky test')
    expect(html).toContain('data-testid="release-notes-list"')
  })

  it('shows a recovery badge only when recoveryCount > 0', () => {
    const html = render(loaded([ENTRY_NO_RECOVERY, ENTRY_WITH_RECOVERY]))
    // ENTRY_WITH_RECOVERY has recoveryCount=2 → badge shown
    expect(html).toContain('+2 recovery')
    // ENTRY_NO_RECOVERY has recoveryCount=0 → no badge
    // Count occurrences of the badge test id
    const badgeCount = (html.match(/data-testid="recovery-badge"/g) ?? []).length
    expect(badgeCount).toBe(1)
  })

  it('renders one row per entry', () => {
    const html = render(loaded([ENTRY_NO_RECOVERY, ENTRY_WITH_RECOVERY]))
    const rowCount = (html.match(/data-testid="release-note-row"/g) ?? []).length
    expect(rowCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Loading and error states
// ---------------------------------------------------------------------------

describe('ReleaseNotesModal – loading state', () => {
  it('shows the loading skeleton while the query is pending', () => {
    const html = render(LOADING)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('data-testid="release-notes-list"')
    expect(html).not.toContain('No work has landed yet.')
  })
})

describe('ReleaseNotesModal – error state', () => {
  it('shows the error message when the query fails', () => {
    const html = render(ERROR_RESULT)
    expect(html).toContain('Failed to load release notes.')
    expect(html).not.toContain('data-testid="release-notes-list"')
  })
})

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe('ReleaseNotesModal – header', () => {
  it('renders the "Release Notes" heading and a Close button', () => {
    const html = render(empty())
    expect(html).toContain('>Release Notes<')
    expect(html).toContain('data-testid="release-notes-close"')
    expect(html).toContain('>Close<')
  })

  it('has the dialog role and aria-modal for accessibility', () => {
    const html = render(empty())
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Release Notes"')
  })
})

// ---------------------------------------------------------------------------
// Unseen divider
// ---------------------------------------------------------------------------

// Newest-first fixtures for divider tests.
// ENTRY_NEWER has landedAt after lastViewedAt → unseen.
// ENTRY_OLDER has landedAt before lastViewedAt → seen.
const ENTRY_NEWER: ReleaseNoteEntry = {
  originId: 'mars-new1',
  title: 'Newer arc',
  landedAt: '2026-06-05T10:00:00.000Z',
  detail: { prompt: 'p', spec: null, recoveryCount: 0 },
}
const ENTRY_NEWEST: ReleaseNoteEntry = {
  originId: 'mars-new2',
  title: 'Newest arc',
  landedAt: '2026-06-06T10:00:00.000Z',
  detail: { prompt: 'p', spec: null, recoveryCount: 0 },
}
const ENTRY_OLDER: ReleaseNoteEntry = {
  originId: 'mars-old1',
  title: 'Older arc',
  landedAt: '2026-06-01T10:00:00.000Z',
  detail: { prompt: 'p', spec: null, recoveryCount: 0 },
}

const LAST_VIEWED_BETWEEN = '2026-06-03T00:00:00.000Z' // NEWER and NEWEST are unseen

describe('ReleaseNotesModal – unseen divider', () => {
  it('renders the divider when there are unseen entries and a prior cursor', () => {
    // Two unseen (NEWEST, NEWER) and one seen (OLDER) in newest-first order
    const html = render(
      loaded([ENTRY_NEWEST, ENTRY_NEWER, ENTRY_OLDER]),
      { lastViewedAt: LAST_VIEWED_BETWEEN },
    )
    expect(html).toContain('data-testid="unseen-divider"')
    expect(html).toContain('new since you were away')
  })

  it('does NOT render the divider when lastViewedAt is null (first-run)', () => {
    const html = render(
      loaded([ENTRY_NEWEST, ENTRY_NEWER, ENTRY_OLDER]),
      { lastViewedAt: null },
    )
    expect(html).not.toContain('data-testid="unseen-divider"')
  })

  it('does NOT render the divider when all entries are seen', () => {
    // lastViewedAt after all entries → all seen
    const html = render(
      loaded([ENTRY_NEWEST, ENTRY_NEWER, ENTRY_OLDER]),
      { lastViewedAt: '2026-06-10T00:00:00.000Z' },
    )
    expect(html).not.toContain('data-testid="unseen-divider"')
  })

  it('does NOT render a divider when there is only one entry and it is unseen', () => {
    // firstUnseenIndex === 0 → no divider (nowhere above to place it)
    const html = render(
      loaded([ENTRY_NEWEST]),
      { lastViewedAt: '2026-06-01T00:00:00.000Z' },
    )
    // There's no "above" position when the oldest unseen is also the first entry
    expect(html).not.toContain('data-testid="unseen-divider"')
  })

  it('renders the divider just above the oldest unseen entry in the DOM', () => {
    // [NEWEST (unseen), NEWER (unseen), OLDER (seen)]
    // firstUnseenIndex = 1 (NEWER is the oldest unseen)
    // Divider renders between index 0 (NEWEST) and index 1 (NEWER)
    const html = render(
      loaded([ENTRY_NEWEST, ENTRY_NEWER, ENTRY_OLDER]),
      { lastViewedAt: LAST_VIEWED_BETWEEN },
    )
    // The divider should appear before the oldest-unseen row (NEWER).
    // In the HTML, the divider markup should come before NEWER's title.
    const dividerPos = html.indexOf('unseen-divider')
    const olderPos = html.indexOf('Newer arc')
    const newerPos = html.indexOf('Newest arc')
    expect(dividerPos).toBeGreaterThan(-1)
    // Divider appears after NEWEST arc but before NEWER arc title
    expect(dividerPos).toBeGreaterThan(newerPos)
    expect(dividerPos).toBeLessThan(olderPos)
  })

  it('marks the oldest unseen row with data-oldest-unseen', () => {
    const html = render(
      loaded([ENTRY_NEWEST, ENTRY_NEWER, ENTRY_OLDER]),
      { lastViewedAt: LAST_VIEWED_BETWEEN },
    )
    // NEWER is the oldest unseen (index 1); it should have data-oldest-unseen
    expect(html).toContain('data-oldest-unseen="true"')
  })

  it('divider rule-lines use bg-flame/40 and label uses text-flame so the color is visible', () => {
    // The accent color token does not exist in @theme; the divider must use
    // the defined `flame` token so rule-lines and label render with color.
    const html = render(
      loaded([ENTRY_NEWEST, ENTRY_NEWER, ENTRY_OLDER]),
      { lastViewedAt: LAST_VIEWED_BETWEEN },
    )
    expect(html).toContain('data-testid="unseen-divider"')
    // Both rule-line spans must carry bg-flame/40
    const ruleMatches = html.match(/bg-flame\/40/g) ?? []
    expect(ruleMatches.length).toBeGreaterThanOrEqual(2)
    // The label span must carry text-flame
    expect(html).toContain('text-flame')
    // Broken classes must not appear
    expect(html).not.toContain('bg-accent')
    expect(html).not.toContain('text-accent')
  })
})

// ---------------------------------------------------------------------------
// Click-outside (backdrop) dismissal
// ---------------------------------------------------------------------------

describe('ReleaseNotesModal – click-outside dismissal', () => {
  it('calls onClose after clicking the empty area outside the panel', async () => {
    vi.useFakeTimers()

    const onClose = vi.fn()
    nextResult = empty()
    nextCursorResult = { isPending: false, isError: false, data: { lastViewedAt: null } }

    const container = document.createElement('div')
    document.body.appendChild(container)

    let root: Root | null = null
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(<ReleaseNotesModal onClose={onClose} />)
      })

      // The centering wrapper carries the dismiss handler with a target guard.
      const backdrop = container.querySelector('[data-testid="release-notes-backdrop"]') as HTMLElement
      expect(backdrop).not.toBeNull()

      // Dispatch the click directly on the backdrop element so e.target === e.currentTarget.
      await act(async () => {
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      // The scrim signals the exit animation immediately via data-closing.
      const overlay = container.querySelector('[data-testid="release-notes-overlay"]') as HTMLElement
      expect(overlay.getAttribute('data-closing')).toBe('true')

      // Advance past the 180 ms exit-animation delay.
      await act(async () => {
        vi.advanceTimersByTime(200)
      })

      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => {
        root?.unmount()
      })
      document.body.removeChild(container)
      vi.useRealTimers()
    }
  })

  it('does NOT call onClose when clicking inside the panel', async () => {
    vi.useFakeTimers()

    const onClose = vi.fn()
    nextResult = loaded([ENTRY_NO_RECOVERY])
    nextCursorResult = { isPending: false, isError: false, data: { lastViewedAt: null } }

    const container = document.createElement('div')
    document.body.appendChild(container)

    let root: Root | null = null
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(<ReleaseNotesModal onClose={onClose} />)
      })

      // Click inside the panel — the event bubbles to the backdrop, but
      // e.target (the aside) !== e.currentTarget (the backdrop), so the guard
      // prevents handleClose from firing.
      const panel = container.querySelector('[data-testid="release-notes-drawer"]') as HTMLElement
      expect(panel).not.toBeNull()

      await act(async () => {
        panel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      // Advance well past the 180 ms exit-animation window — onClose must not fire.
      await act(async () => {
        vi.advanceTimersByTime(300)
      })

      expect(onClose).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        root?.unmount()
      })
      document.body.removeChild(container)
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Pagination — large history stays snappy
// ---------------------------------------------------------------------------

const makeEntries = (count: number): ReleaseNoteEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    originId: `mars-page-${i}`,
    title: `Entry ${i}`,
    landedAt: new Date(2026, 0, count - i).toISOString(),
    detail: { prompt: 'p', spec: null, recoveryCount: 0 },
  }))

describe('ReleaseNotesModal – pagination', () => {
  it('renders only the first PAGE_SIZE rows when there are more entries than PAGE_SIZE', () => {
    const entries = makeEntries(PAGE_SIZE + 50)
    const html = render(loaded(entries))
    const rowCount = (html.match(/data-testid="release-note-row"/g) ?? []).length
    expect(rowCount).toBe(PAGE_SIZE)
  })

  it('shows a Load-more button when entries exceed PAGE_SIZE', () => {
    const entries = makeEntries(PAGE_SIZE + 1)
    const html = render(loaded(entries))
    expect(html).toContain('data-testid="release-notes-load-more"')
  })

  it('shows how many entries will be loaded on the Load-more button', () => {
    const extra = 37
    const entries = makeEntries(PAGE_SIZE + extra)
    const html = render(loaded(entries))
    expect(html).toContain(`Load ${extra} more`)
  })

  it('does NOT show a Load-more button when entries fit within PAGE_SIZE', () => {
    const entries = makeEntries(PAGE_SIZE)
    const html = render(loaded(entries))
    expect(html).not.toContain('data-testid="release-notes-load-more"')
  })

  it('does NOT show a Load-more button when there are fewer entries than PAGE_SIZE', () => {
    const entries = makeEntries(5)
    const html = render(loaded(entries))
    expect(html).not.toContain('data-testid="release-notes-load-more"')
  })
})

// ---------------------------------------------------------------------------
// Viewed-marker fires on close, not on open
// ---------------------------------------------------------------------------

describe('ReleaseNotesModal – viewed marker fires on close not on open', () => {
  it('does NOT call postReleaseNotesViewed when the modal mounts with data loaded', async () => {
    vi.useFakeTimers()
    nextResult = loaded([ENTRY_NO_RECOVERY])
    nextCursorResult = { isPending: false, isError: false, data: { lastViewedAt: null } }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(<ReleaseNotesModal onClose={() => {}} />)
      })
      expect(mockPostViewed).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root?.unmount() })
      document.body.removeChild(container)
      vi.useRealTimers()
    }
  })

  it('calls postReleaseNotesViewed exactly once when the Close button is clicked', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    nextResult = loaded([ENTRY_NO_RECOVERY])
    nextCursorResult = { isPending: false, isError: false, data: { lastViewedAt: null } }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(<ReleaseNotesModal onClose={onClose} />)
      })

      expect(mockPostViewed).not.toHaveBeenCalled()

      const closeBtn = container.querySelector('[data-testid="release-notes-close"]') as HTMLElement
      await act(async () => {
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(mockPostViewed).toHaveBeenCalledTimes(1)

      await act(async () => { vi.advanceTimersByTime(200) })
      expect(onClose).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => { root?.unmount() })
      document.body.removeChild(container)
      vi.useRealTimers()
    }
  })

  it('does NOT call postReleaseNotesViewed when closed before data loads', async () => {
    vi.useFakeTimers()
    // Data is still pending — no data yet
    nextResult = LOADING
    nextCursorResult = { isPending: true, isError: false, data: undefined }

    const container = document.createElement('div')
    document.body.appendChild(container)
    let root: Root | null = null
    try {
      await act(async () => {
        root = createRoot(container)
        root.render(<ReleaseNotesModal onClose={() => {}} />)
      })

      const closeBtn = container.querySelector('[data-testid="release-notes-close"]') as HTMLElement
      await act(async () => {
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(mockPostViewed).not.toHaveBeenCalled()
    } finally {
      await act(async () => { root?.unmount() })
      document.body.removeChild(container)
      vi.useRealTimers()
    }
  })
})
