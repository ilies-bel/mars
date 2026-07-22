// @vitest-environment happy-dom
/**
 * Unit tests for the "While you were away" hero panel.
 *
 * The backing hook and React Query are mocked at the module boundary so each
 * test drives a fixed unseen set synchronously through `renderToStaticMarkup`.
 * Covers:
 *   - hidden when there are no unseen entries and no auto-runs
 *   - lists title + one-line body for each unseen entry, newest first
 *   - caps at MAX_VISIBLE_ENTRIES with an "and N more" line
 *   - carries the manual "Release notes" link to the modal's hash route
 */
import { mock, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AutoRecipeRun, ReleaseNoteEntry } from '@/shared/schemas'

let mockUnseen: ReleaseNoteEntry[] = []
let mockAutoRuns: AutoRecipeRun[] = []

mock.module('@/shared/useUnseenReleaseNotes', () => ({
  useUnseenReleaseNotes: () => ({ unseenEntries: mockUnseen }),
}))

// Stub React Query so renderToStaticMarkup doesn't need a QueryClientProvider.
// useQuery returns { data: undefined } by default; the component maps that to
// an empty auto-runs list via the `= []` default in destructuring.
mock.module('@tanstack/react-query', () => ({
  useQuery: (_opts: unknown) => ({ data: (_opts as { queryKey?: unknown[] })?.queryKey?.[0] === 'auto-recipe-runs' ? mockAutoRuns : undefined }),
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

const makeAutoRun = (n: number): AutoRecipeRun => ({
  id: `run-${n}`,
  signature: `verify:typecheck/err-${n}`,
  actionOp: 'restart',
  taskId: `task-${n}`,
  ranAt: `2026-06-${String(n).padStart(2, '0')}T12:00:00.000Z`,
})

describe('WhileYouWereAwayPanel', () => {
  it('renders nothing when there are no unseen entries and no auto-runs', () => {
    mockUnseen = []
    mockAutoRuns = []
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toBe('')
  })

  it('lists title and one-line body for each unseen entry', () => {
    mockUnseen = [makeEntry(2), makeEntry(1)]
    mockAutoRuns = []
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
    mockAutoRuns = []
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    const entryCount = (html.match(/data-testid="wywa-entry"/g) ?? []).length
    expect(entryCount).toBe(MAX_VISIBLE_ENTRIES)
    expect(html).toContain('and 3 more')
  })

  it('links to the manual release-notes modal hash route', () => {
    mockUnseen = [makeEntry(1)]
    mockAutoRuns = []
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain(`href="${releaseNotesHash()}"`)
  })

  it('shows the panel with auto-runs section when auto-runs exist (even without unseen release notes)', () => {
    mockUnseen = []
    mockAutoRuns = [makeAutoRun(1), makeAutoRun(2)]
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain('While you were away')
    expect(html).toContain('data-testid="wywa-auto-runs"')
    const runCount = (html.match(/data-testid="wywa-auto-run"/g) ?? []).length
    expect(runCount).toBe(2)
    expect(html).toContain('Auto-applied')
  })

  it('shows auto-runs below release notes when both are present', () => {
    mockUnseen = [makeEntry(1)]
    mockAutoRuns = [makeAutoRun(1)]
    const html = renderToStaticMarkup(<WhileYouWereAwayPanel projectId="p" />)
    expect(html).toContain('Arc title 1')
    expect(html).toContain('data-testid="wywa-auto-runs"')
    // Release notes section appears before auto-runs
    const notesPos = html.indexOf('data-testid="wywa-entry"')
    const runsPos = html.indexOf('data-testid="wywa-auto-runs"')
    expect(notesPos).toBeLessThan(runsPos)
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
