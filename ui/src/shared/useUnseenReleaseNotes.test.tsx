// @vitest-environment happy-dom
/**
 * Unit tests for the unseen-release-notes logic backing the chat hero
 * "While you were away" panel.
 *
 * Covers:
 *   - `computeUnseen` (pure): first-run null cursor, partial/all/none unseen
 *   - `useUnseenReleaseNotes` (hook, real react-query + mocked API):
 *     (a) null cursor + history → POSTs baseline, exposes NO unseen entries
 *     (b) unseen entries → exposed to the panel AND cursor POSTed on view
 *     (c) all seen → nothing exposed, no POST
 *   - HARD CUT: the hook never touches window.location.hash (no auto-open)
 */
import { mock, describe, expect, it, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// API mocks (must be installed before the hook module is imported)
// ---------------------------------------------------------------------------

const fetchReleaseNotesMock = mock(async () => [] as ReleaseNoteEntry[])
const getReleaseNotesCursorMock = mock(async () => ({ lastViewedAt: null as string | null }))
const postReleaseNotesViewedMock = mock(async () => ({ lastViewedAt: '2026-06-10T00:00:00.000Z' }))

mock.module('./api', () => ({
  fetchReleaseNotes: fetchReleaseNotesMock,
  getReleaseNotesCursor: getReleaseNotesCursorMock,
  postReleaseNotesViewed: postReleaseNotesViewedMock,
}))

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReleaseNoteEntry } from './schemas'

// vi.mock is not hoisted through the `mock.module` shim alias, so the module
// under test must be imported dynamically AFTER the mocks are registered.
const { computeUnseen, useUnseenReleaseNotes, _resetUnseenSession } = await import(
  './useUnseenReleaseNotes'
)

// act() support for react-dom/client renders.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEntry = (originId: string, landedAt: string): ReleaseNoteEntry => ({
  originId,
  title: `Arc ${originId}`,
  landedAt,
  detail: { prompt: 'p', spec: null, recoveryCount: 0 },
})

// Newest-first ordering (entries[0] = most recently landed)
const NEWEST = makeEntry('arc-1', '2026-06-05T10:00:00.000Z')
const MIDDLE = makeEntry('arc-2', '2026-06-03T10:00:00.000Z')
const OLDEST = makeEntry('arc-3', '2026-06-01T10:00:00.000Z')

const ENTRIES = [NEWEST, MIDDLE, OLDEST] // newest-first

// ---------------------------------------------------------------------------
// computeUnseen — pure function tests
// ---------------------------------------------------------------------------

describe('computeUnseen – first-run (lastViewedAt null)', () => {
  it('returns unseenCount=0 and firstUnseenIndex=null when cursor is null', () => {
    const result = computeUnseen(ENTRIES, null)
    expect(result.unseenCount).toBe(0)
    expect(result.firstUnseenIndex).toBeNull()
  })

  it('returns zero even when all entries would otherwise be unseen', () => {
    const result = computeUnseen([NEWEST], null)
    expect(result.unseenCount).toBe(0)
    expect(result.firstUnseenIndex).toBeNull()
  })

  it('returns zero for an empty list with null cursor', () => {
    const result = computeUnseen([], null)
    expect(result.unseenCount).toBe(0)
    expect(result.firstUnseenIndex).toBeNull()
  })
})

describe('computeUnseen – entries with lastViewedAt set', () => {
  it('identifies unseen entries and points firstUnseenIndex at the OLDEST unseen', () => {
    const result = computeUnseen(ENTRIES, '2026-06-02T00:00:00.000Z')
    expect(result.unseenCount).toBe(2)
    expect(result.firstUnseenIndex).toBe(1)
  })

  it('returns zero unseen when all entries are older than lastViewedAt', () => {
    const result = computeUnseen(ENTRIES, '2026-06-10T00:00:00.000Z')
    expect(result.unseenCount).toBe(0)
    expect(result.firstUnseenIndex).toBeNull()
  })

  it('handles all entries being unseen', () => {
    const result = computeUnseen(ENTRIES, '2026-01-01T00:00:00.000Z')
    expect(result.unseenCount).toBe(3)
    expect(result.firstUnseenIndex).toBe(2)
  })

  it('handles a single unseen entry', () => {
    const result = computeUnseen(ENTRIES, '2026-06-04T00:00:00.000Z')
    expect(result.unseenCount).toBe(1)
    expect(result.firstUnseenIndex).toBe(0)
  })

  it('returns zero for an empty list', () => {
    const result = computeUnseen([], '2026-06-01T00:00:00.000Z')
    expect(result.unseenCount).toBe(0)
    expect(result.firstUnseenIndex).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// useUnseenReleaseNotes — hook behaviour with real react-query + mocked API
// ---------------------------------------------------------------------------

/** Renders the hook and records the latest returned unseenEntries. */
const renderHook = async (projectId: string) => {
  const latest: { unseenEntries: ReleaseNoteEntry[] } = { unseenEntries: [] }

  const Probe = () => {
    const { unseenEntries } = useUnseenReleaseNotes(projectId)
    latest.unseenEntries = unseenEntries
    return null
  }

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  // Let queries resolve, effects run, and the post-invalidation refetch settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

  return {
    latest,
    cleanup: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
      qc.clear()
    },
  }
}

describe('useUnseenReleaseNotes', () => {
  beforeEach(() => {
    _resetUnseenSession()
    fetchReleaseNotesMock.mockClear()
    getReleaseNotesCursorMock.mockClear()
    postReleaseNotesViewedMock.mockClear()
    window.location.hash = ''
  })

  it('(a) first-run: null cursor + history → POSTs baseline, exposes nothing, no hash change', async () => {
    fetchReleaseNotesMock.mockResolvedValue(ENTRIES)
    getReleaseNotesCursorMock.mockResolvedValue({ lastViewedAt: null })

    const { latest, cleanup } = await renderHook('proj-a')

    expect(latest.unseenEntries).toHaveLength(0)
    expect(postReleaseNotesViewedMock).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('')
    await cleanup()
  })

  it('(b) unseen entries → exposed for the panel AND cursor POSTed on view', async () => {
    fetchReleaseNotesMock.mockResolvedValue(ENTRIES)
    getReleaseNotesCursorMock.mockResolvedValue({ lastViewedAt: '2026-06-02T00:00:00.000Z' })

    const { latest, cleanup } = await renderHook('proj-b')

    // NEWEST and MIDDLE landed after the cursor → both surface, newest-first.
    expect(latest.unseenEntries.map((e) => e.originId)).toEqual(['arc-1', 'arc-2'])
    // Rendering counted as viewing: cursor baseline was POSTed exactly once.
    expect(postReleaseNotesViewedMock).toHaveBeenCalledTimes(1)
    // HARD CUT: no auto-open — the hash is untouched.
    expect(window.location.hash).toBe('')
    await cleanup()
  })

  it('(b2) snapshot survives the cursor POST — entries stay visible for the session', async () => {
    fetchReleaseNotesMock.mockResolvedValue(ENTRIES)
    getReleaseNotesCursorMock
      .mockResolvedValueOnce({ lastViewedAt: '2026-06-02T00:00:00.000Z' })
      // The invalidation after the POST refetches an advanced cursor.
      .mockResolvedValue({ lastViewedAt: '2026-06-10T00:00:00.000Z' })

    const { latest, cleanup } = await renderHook('proj-c')

    expect(latest.unseenEntries.map((e) => e.originId)).toEqual(['arc-1', 'arc-2'])
    expect(postReleaseNotesViewedMock).toHaveBeenCalledTimes(1)
    await cleanup()
  })

  it('(c) all entries seen → nothing exposed, no POST', async () => {
    fetchReleaseNotesMock.mockResolvedValue(ENTRIES)
    getReleaseNotesCursorMock.mockResolvedValue({ lastViewedAt: '2026-06-10T00:00:00.000Z' })

    const { latest, cleanup } = await renderHook('proj-d')

    expect(latest.unseenEntries).toHaveLength(0)
    expect(postReleaseNotesViewedMock).not.toHaveBeenCalled()
    await cleanup()
  })
})
