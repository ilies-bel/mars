/**
 * Unit tests for the ReleaseNotesDrawer widget.
 *
 * `useQuery` is mocked at the module boundary (the project's hook-mocking
 * convention) so each test drives a fixed query result synchronously inside
 * `renderToStaticMarkup`. This lets us cover:
 *   - The empty state ("No work has landed yet.")
 *   - A populated list: title, relative date, recovery badge
 *   - Loading and error states
 */
import { mock, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReleaseNoteEntry } from '@/shared/schemas'

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
      taskType: 'auto',
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

mock.module('@/shared/api', () => ({
  fetchReleaseNotes: async (): Promise<ReleaseNoteEntry[]> => [],
}))

mock.module('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
}))

mock.module('@tanstack/react-query', () => ({
  useQuery: () => nextResult,
}))

const { ReleaseNotesDrawer } = await import('./ReleaseNotesDrawer')

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

const render = (result: QueryResult): string => {
  nextResult = result
  return renderToStaticMarkup(<ReleaseNotesDrawer onClose={() => {}} />)
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('ReleaseNotesDrawer – empty state', () => {
  it('shows the empty-state message when there are no landed arcs', () => {
    const html = render(empty())
    expect(html).toContain('No work has landed yet.')
    expect(html).not.toContain('data-testid="release-notes-list"')
  })
})

// ---------------------------------------------------------------------------
// Populated list
// ---------------------------------------------------------------------------

describe('ReleaseNotesDrawer – populated list', () => {
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

describe('ReleaseNotesDrawer – loading state', () => {
  it('shows the loading message while the query is pending', () => {
    const html = render(LOADING)
    expect(html).toContain('Loading…')
    expect(html).not.toContain('data-testid="release-notes-list"')
    expect(html).not.toContain('No work has landed yet.')
  })
})

describe('ReleaseNotesDrawer – error state', () => {
  it('shows the error message when the query fails', () => {
    const html = render(ERROR_RESULT)
    expect(html).toContain('Failed to load release notes.')
    expect(html).not.toContain('data-testid="release-notes-list"')
  })
})

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe('ReleaseNotesDrawer – header', () => {
  it('renders the "Release Notes" heading and a Close button', () => {
    const html = render(empty())
    expect(html).toContain('>Release Notes<')
    expect(html).toContain('data-testid="release-notes-close"')
    expect(html).toContain('>Close<')
  })

  it('has the drawer role and aria-modal for accessibility', () => {
    const html = render(empty())
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Release Notes"')
  })
})
