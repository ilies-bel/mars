// @vitest-environment happy-dom
/**
 * Unit tests for the "While you were away" hero panel.
 *
 * The backing hook and React Query are mocked at the module boundary so each
 * test drives a fixed delta payload synchronously through `renderToStaticMarkup`.
 * Covers:
 *   - hidden when there are no unseen entries and no delta events
 *   - lists each delta event summary as a one-liner, newest first
 *   - caps at MAX_VISIBLE_ENTRIES with an "and N more" line (andMore from server)
 *   - carries the manual "Release notes" link to the modal's hash route
 *   - shows when unseenEntries are non-empty even with an empty delta
 */
import { mock, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReleaseNoteEntry, WywaDeltaResponse, WywaEvent } from '@/shared/schemas'

let mockUnseen: ReleaseNoteEntry[] = []
let mockDelta: WywaDeltaResponse = { ok: true, events: [], andMore: 0 }

mock.module('@/shared/useUnseenReleaseNotes', () => ({
  useUnseenReleaseNotes: () => ({ unseenEntries: mockUnseen }),
}))

// Stub React Query so renderToStaticMarkup doesn't need a QueryClientProvider.
// useQuery returns data keyed by queryKey[0]:
//   'release-notes-cursor' → { lastViewedAt: '2026-07-01T00:00:00.000Z' }
//   'wywa-delta'           → mockDelta
mock.module('@tanstack/react-query', () => ({
  useQuery: (_opts: unknown) => {
    const key = (_opts as { queryKey?: unknown[] })?.queryKey?.[0]
    if (key === 'release-notes-cursor') return { data: { lastViewedAt: '2026-07-01T00:00:00.000Z' } }
    if (key === 'wywa-delta') return { data: mockDelta }
    return { data: undefined }
  },
}))

// useRef must return an object whose .current is writable; happy-dom provides
// React, but renderToStaticMarkup ignores refs (they are set after mount).
// Since we render server-side the snapshotRef is always null → the component
// falls through to `freshDelta` (= mockDelta), which is exactly what we want.
mock.module('react', async () => {
  const actual = await import('react')
  return { ...actual, useRef: () => ({ current: null }) }
})

// vi.mock is not hoisted through the `mock.module` shim alias, so the module
// under test must be imported dynamically AFTER all mocks are registered.
const { WhileYouWereAwayPanel, MAX_VISIBLE_ENTRIES, entryOneLiner } = await import(
  './WhileYouWereAwayPanel'
)
import { releaseNotesHash } from '@/shared/routing'

const makeEntry = (n: number): ReleaseNoteEntry => ({
  originId: `arc-${n}`,
  title: `Arc title ${n}`,
  landedAt: `2026-06-${String(n).padStart(2, '0')}T10:00:00.000Z`,
  detail: { prompt: `First line of prompt ${n}\nsecond line`, spec: null, recoveryCount: 0 },
})

const makeEvent = (kind: WywaEvent['kind'], n: number): WywaEvent => ({
  kind,
  summary: `${kind} event ${n}`,
  at: `2026-06-${String(n).padStart(2, '0')}T12:00:00.000Z`,
})

describe('WhileYouWereAwayPanel', () => {
  it('renders nothing when there are no unseen entries and no delta events', () => {
    mockUnseen = []
    mockDelta = { ok: true, events: [], andMore: 0 }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toBe('')
  })

  it('lists delta event summaries as one-liners', () => {
    mockUnseen = []
    mockDelta = {
      ok: true,
      events: [
        { kind: 'merge', summary: 'Merged: Add login', at: '2026-06-02T12:00:00.000Z' },
        { kind: 'auto-recipe', summary: 'Auto-restart on task-1 (sig)', at: '2026-06-01T12:00:00.000Z' },
      ],
      andMore: 0,
    }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain('While you were away')
    expect(html).toContain('Merged: Add login')
    expect(html).toContain('Auto-restart on task-1')
    expect(html).not.toContain('and ')
  })

  it('shows all event kinds from the delta', () => {
    mockUnseen = []
    mockDelta = {
      ok: true,
      events: [
        { kind: 'merge', summary: 'Merged: X', at: '2026-06-05T00:00:00.000Z' },
        { kind: 'failure-recovered', summary: 'Task arc-1 failed and recovered', at: '2026-06-04T00:00:00.000Z' },
        { kind: 'auto-recipe', summary: 'Auto-restart on t1 (sig)', at: '2026-06-03T00:00:00.000Z' },
        { kind: 'throttle', summary: 'Rate limit hit on chat thread th-1', at: '2026-06-02T00:00:00.000Z' },
        { kind: 'evaporated-thread', summary: 'Idle thread th-2 evaporated', at: '2026-06-01T00:00:00.000Z' },
      ],
      andMore: 0,
    }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain('Merged: X')
    expect(html).toContain('failed and recovered')
    expect(html).toContain('Auto-restart')
    expect(html).toContain('Rate limit hit')
    expect(html).toContain('Idle thread th-2 evaporated')
  })

  it('caps the list at MAX_VISIBLE_ENTRIES and shows "and N more" from server andMore', () => {
    mockUnseen = []
    const events = Array.from({ length: MAX_VISIBLE_ENTRIES }, (_, i) =>
      makeEvent('merge', i + 1),
    )
    mockDelta = { ok: true, events, andMore: 5 }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    const eventCount = (html.match(/data-testid="wywa-event"/g) ?? []).length
    expect(eventCount).toBe(MAX_VISIBLE_ENTRIES)
    expect(html).toContain('and 5 more')
  })

  it('caps local visible and adds server andMore together in the overflow count', () => {
    mockUnseen = []
    // 10 events locally but MAX_VISIBLE_ENTRIES = 8, plus 3 more from server
    const events = Array.from({ length: MAX_VISIBLE_ENTRIES + 2 }, (_, i) =>
      makeEvent('merge', i + 1),
    )
    mockDelta = { ok: true, events, andMore: 3 }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    const eventCount = (html.match(/data-testid="wywa-event"/g) ?? []).length
    expect(eventCount).toBe(MAX_VISIBLE_ENTRIES)
    // 2 truncated locally + 3 from server = 5
    expect(html).toContain('and 5 more')
  })

  it('links to the manual release-notes modal hash route', () => {
    mockUnseen = []
    mockDelta = {
      ok: true,
      events: [{ kind: 'merge', summary: 'Merged: Y', at: '2026-06-01T00:00:00.000Z' }],
      andMore: 0,
    }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain(`href="${releaseNotesHash()}"`)
  })

  it('links to the Steward intervention timeline', () => {
    mockUnseen = []
    mockDelta = {
      ok: true,
      events: [{ kind: 'merge', summary: 'Merged: Z', at: '2026-06-01T00:00:00.000Z' }],
      andMore: 0,
    }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)

    expect(html).toContain('See timeline')
    expect(html).toContain('href="#steward-ledger"')
  })

  it('shows the panel (via unseenEntries) even when the delta is empty', () => {
    mockUnseen = [makeEntry(1)]
    mockDelta = { ok: true, events: [], andMore: 0 }
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    // Panel renders because unseenEntries.length > 0, even though delta is empty.
    expect(html).toContain('While you were away')
    expect(html).not.toContain('data-testid="wywa-event"')
  })
})

describe('entryOneLiner', () => {
  it('takes the first prompt line and truncates long ones', () => {
    expect(entryOneLiner(makeEntry(1))).toBe('First line of prompt 1')
    const long = { ...makeEntry(1), detail: { prompt: 'x'.repeat(200), spec: null, recoveryCount: 0 } }
    expect(entryOneLiner(long).length).toBeLessThanOrEqual(140)
    expect(entryOneLiner(long).endsWith('…')).toBe(true)
  })
})
