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
  recorded: true,
  suggestion: hasSuggestion ? { version: 'v1.2.3', decisionKind: 'promoted' } : null,
  review: hasReview ? { decision: 'accepted', decidedAt: 1700000002000 } : null,
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

// useTasks is used by LoopLedgerPanel to resolve run ids to human titles.
// Mock it to avoid needing a QueryClientProvider in these tests.
vi.mock('@/hooks/useTasks', () => ({
  useTasks: vi.fn(() => ({ snapshot: null, error: null, connected: false })),
}))

import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useLoopLedger } from '@/entities/watchtower/useLoopLedger'
import { useTasks } from '@/hooks/useTasks'

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

    // Entry with suggestion shows version and decisionKind
    expect(html).toContain('v1.2.3')
    expect(html).toContain('promoted')

    // Entry with review shows decision
    expect(html).toContain('accepted')

    // Recorded column shows a lucide check for recorded entries
    expect(html).toContain('lucide-check')

    // Entry without suggestion/review shows — (at least 2 dashes)
    const dashCount = (html.match(/—/g) ?? []).length
    expect(dashCount).toBeGreaterThanOrEqual(2)
  })

  it('renders the table (not the empty state) with a server-shaped entry (recorded: boolean, no recordedAt)', async () => {
    // This directly mirrors the live server payload that caused the bug:
    //   { runId, scoredAt, score, recorded: true, suggestion: null, review: null }
    // The old client schema had `recordedAt: z.number().nullable()` which failed
    // Zod validation on every entry, collapsing the panel to "No loop runs yet".
    const serverEntry: LoopLedgerEntry = {
      runId: 'mars-ba051780',
      scoredAt: 1788267539341,
      score: 0.72,
      recorded: true,
      suggestion: null,
      review: null,
    }

    vi.mocked(useLoopLedger).mockReturnValueOnce({
      entries: [serverEntry],
      isLoading: false,
      error: null,
    })

    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    expect(html).not.toContain('No loop runs yet')
    expect(html).toContain('mars-ba051780')
    // recorded: true renders as a tick, not as a timestamp
    expect(html).toContain('lucide-check')
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

  it('renders task title and run id in separate elements: id carries muted styling and is not adjacent to the title text', async () => {
    const HUMAN_TITLE = 'Fix blank action queue: teach the UI schema the new group/item union'

    vi.mocked(useTasks).mockReturnValueOnce({
      snapshot: {
        columns: {
          in_progress: [
            {
              id: 'run-001',
              title: HUMAN_TITLE,
              status: 'in_progress' as const,
              role: 'builder' as const,
              failed: false,
              dropReason: null,
              recoverySpawnedCount: 0,
              priority: 1,
              blockerTaskId: null,
              spec: null,
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          backlog: [],
          done: [],
        },
        counts: { inProgress: 1, todo: 0, done: 0 },
      },
      error: null,
      connected: false,
    })

    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    // Both pieces of information must appear
    expect(html).toContain(HUMAN_TITLE)
    expect(html).toContain('run-001')

    // The title and the run id must NOT be in the same text node.
    // Locate where the title text ends and where the run id begins; between
    // them there must be HTML structure (at least one tag boundary '>').
    const afterTitle = html.indexOf(HUMAN_TITLE) + HUMAN_TITLE.length
    const idStart = html.indexOf('run-001', afterTitle)
    expect(idStart).toBeGreaterThan(afterTitle)
    const between = html.slice(afterTitle, idStart)
    // Must contain a closing '>' — i.e. there is a tag boundary separating them
    expect(between).toMatch(/>/)
    // Must NOT be that the title and id sit together with only whitespace
    expect(between.trim()).not.toBe('')

    // The run id must carry muted styling (visually subordinate to the title)
    const idElementStart = html.lastIndexOf('<', idStart)
    expect(html.slice(idElementStart, idStart)).toContain('muted-foreground')
  })
})

// ---------------------------------------------------------------------------
// Dormant-stage columns
//
// A loop stage that has not run for ANY visible row contributes a column of
// em-dashes — N rows of nothing competing for width with the rows that say
// something. Those columns are dropped, but dropping alone is lossy (a missing
// column reads as "this stage does not exist" rather than "it has not run"),
// so a caption must name them.
// ---------------------------------------------------------------------------

describe('LoopLedgerPanel — dormant stage columns', () => {
  beforeEach(() => {
    vi.mocked(useScorerWorkflows).mockReturnValue({
      data: WORKFLOWS,
      isLoading: false,
      error: null,
    })
  })

  it('drops a column no visible row has reached, and names it in a caption', async () => {
    // Neither entry has a suggestion or a review.
    vi.mocked(useLoopLedger).mockReturnValue({
      entries: [makeEntry('run-001', false, false), makeEntry('run-002', false, false)],
      isLoading: false,
      error: null,
    })
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    const headerRow = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
    expect(headerRow).not.toContain('Suggest')
    expect(headerRow).not.toContain('Review')
    // Stages that DID run keep their columns.
    expect(headerRow).toContain('Score')
    expect(headerRow).toContain('Recorded')

    // Nothing is silently lost: the caption says which stages are missing.
    expect(html).toContain('Not reached yet in this window: Suggest, Review.')
  })

  it('keeps a column when at least one row has reached that stage', async () => {
    vi.mocked(useLoopLedger).mockReturnValue({
      entries: [makeEntry('run-001', true, false), makeEntry('run-002', false, false)],
      isLoading: false,
      error: null,
    })
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)

    const headerRow = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'))
    expect(headerRow).toContain('Suggest')
    expect(headerRow).not.toContain('Review')
    expect(html).toContain('Not reached yet in this window: Review.')
  })

  it('emits no caption when every stage has data', async () => {
    vi.mocked(useLoopLedger).mockReturnValue({
      entries: [makeEntry('run-001', true, true)],
      isLoading: false,
      error: null,
    })
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)
    expect(html).not.toContain('Not reached yet')
  })
})

// ---------------------------------------------------------------------------
// Drill-in to Studio
//
// This panel and #/studio list the same runs from the same endpoint. Before,
// neither reached the other: the ledger could tell you the loop stalled and
// then leave you to find that run by hand.
// ---------------------------------------------------------------------------

describe('LoopLedgerPanel — Studio drill-in', () => {
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

  it('links each run to its Studio page', async () => {
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)
    expect(html).toContain('href="#/studio/run-001"')
    expect(html).toContain('href="#/studio/run-002"')
  })

  it('gives the link a hover affordance, not colour alone', async () => {
    // The link inherits body colour by design (a table of 50 permanently
    // underlined rows is worse), so discoverability has to come from the hover
    // state. Without it the drill-in only announces itself to a cursor that is
    // already on top of it.
    const { LoopLedgerPanel } = await import('./LoopLedgerPanel')
    const html = renderToStaticMarkup(<LoopLedgerPanel />)
    const anchor = html.slice(html.indexOf('<a href="#/studio/run-001"'))
    expect(anchor.slice(0, 400)).toContain('hover:underline')
  })
})
