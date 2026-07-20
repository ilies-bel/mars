// @vitest-environment happy-dom
/**
 * Unit tests for the "While you were away" hero panel.
 *
 * The backing hook is mocked at the module boundary so each test drives a
 * fixed unseen set synchronously through `renderToStaticMarkup`. Covers:
 *   - hidden when there are no unseen entries
 *   - lists title + one-line body for each unseen entry, newest first
 *   - caps at MAX_VISIBLE_ENTRIES with an "and N more" line
 *   - carries the manual "Release notes" link to the modal's hash route
 */
import { mock, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReleaseNoteEntry } from '@/shared/schemas'

let mockUnseen: ReleaseNoteEntry[] = []

mock.module('@/shared/useUnseenReleaseNotes', () => ({
  useUnseenReleaseNotes: () => ({ unseenEntries: mockUnseen }),
}))

// vi.mock is not hoisted through the `mock.module` shim alias, so the module
// under test must be imported dynamically AFTER the mock is registered.
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

describe('WhileYouWereAwayPanel', () => {
  it('renders nothing when there are no unseen entries', () => {
    mockUnseen = []
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toBe('')
  })

  it('lists title and one-line body for each unseen entry', () => {
    mockUnseen = [makeEntry(2), makeEntry(1)]
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain('While you were away')
    expect(html).toContain('Arc title 2')
    expect(html).toContain('Arc title 1')
    expect(html).toContain('First line of prompt 2')
    // Body is one line only — the second prompt line never renders.
    expect(html).not.toContain('second line')
    expect(html).not.toContain('and ')
  })

  it('caps the list and shows "and N more"', () => {
    mockUnseen = Array.from({ length: MAX_VISIBLE_ENTRIES + 3 }, (_, i) => makeEntry(i + 1))
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    const entryCount = (html.match(/data-testid="wywa-entry"/g) ?? []).length
    expect(entryCount).toBe(MAX_VISIBLE_ENTRIES)
    expect(html).toContain('and 3 more')
  })

  it('links to the manual release-notes modal hash route', () => {
    mockUnseen = [makeEntry(1)]
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain(`href="${releaseNotesHash()}"`)
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
