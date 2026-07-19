/**
 * Tests for the action-queue sidebar header counter and the entityId search fix.
 *
 * The header counter must always agree with the number of rows actually rendered.
 * The filtered memo must match against entityId so task-id strings visible on
 * rows are findable via the search box.
 *
 * State is pre-seeded via vi.stubGlobal('window', …) so the component's
 * useState lazy-initialisers pick up the desired query/kindFilter from
 * readAqStateFromUrl() before the first render.  renderToStaticMarkup is used
 * so effects (which normally write back to the URL) are never invoked.
 */

import { afterEach, describe, expect, it, vi } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ActionQueuePage } from './ActionQueuePage'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Restore window after each test so stubs don't bleed across tests.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ITEM: ActionQueueItem = {
  id: 'failed-task:t-1',
  kind: 'failed-task',
  entityId: 't-1',
  priority: 'normal',
  title: 'Some failed task',
  body: 'verbatim body text',
  at: new Date().toISOString(),
  dag: { blockers: [], blocking: [], descendants: [], proposalId: null, edges: [] },
  errorKind: 'failed-task',
  actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
  diagnosis: null,
  failureReasonCode: 'verify:typecheck',
}

const makeItem = (overrides: Record<string, unknown>): ActionQueueItem =>
  ({ ...BASE_ITEM, ...overrides } as ActionQueueItem)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the full page with a pre-seeded action-queue cache. */
const renderPage = (items: ActionQueueItem[]): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['action-queue', null], items)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ActionQueuePage />
    </QueryClientProvider>,
  )
}

/**
 * Stub window so readAqStateFromUrl() initialises the component with the
 * given search query and/or kind filter.  Must be called BEFORE renderPage().
 */
const stubUrlState = (q: string, kind: 'all' | 'alerts' | 'drafts' = 'all') => {
  const parts: string[] = []
  if (kind !== 'all') parts.push(`kind=${encodeURIComponent(kind)}`)
  if (q) parts.push(`q=${encodeURIComponent(q)}`)
  const hash =
    parts.length > 0 ? `#/action-queue?${parts.join('&')}` : '#/action-queue'
  vi.stubGlobal('window', { location: { hash } })
}

// ---------------------------------------------------------------------------
// Counter tracks search box
// ---------------------------------------------------------------------------

describe('ActionQueuePage sidebar header – counter tracks search box', () => {
  it('shows unfiltered count when no search is active', () => {
    const items = [
      makeItem({ id: 'ft:a', entityId: 'a', title: 'alpha task' }),
      makeItem({ id: 'ft:b', entityId: 'b', title: 'beta task' }),
      makeItem({ id: 'ft:c', entityId: 'c', title: 'gamma task' }),
    ]
    const html = renderPage(items)
    expect(html).toContain('3 items')
    expect(html).not.toContain('of 3')
  })

  it('shows "M of N items" when the search query narrows the list', () => {
    const items = [
      makeItem({ id: 'ft:a', entityId: 'a', title: 'daemon task alpha' }),
      makeItem({ id: 'ft:b', entityId: 'b', title: 'daemon task beta' }),
      makeItem({ id: 'ft:c', entityId: 'c', title: 'unrelated task' }),
      makeItem({ id: 'ft:d', entityId: 'd', title: 'another unrelated' }),
      makeItem({ id: 'ft:e', entityId: 'e', title: 'yet another' }),
    ]
    stubUrlState('daemon')
    const html = renderPage(items)
    expect(html).toContain('2 of 5 items')
  })

  it('count agrees with rendered row count — not the unfiltered total', () => {
    const items = [
      makeItem({ id: 'ft:1', entityId: 'e1', title: 'match me' }),
      makeItem({ id: 'ft:2', entityId: 'e2', title: 'also match me' }),
      makeItem({ id: 'ft:3', entityId: 'e3', title: 'skip' }),
    ]
    stubUrlState('match me')
    const html = renderPage(items)
    // Both matching rows must be present, and the header must say 2 of 3, not 3
    expect(html).toContain('match me')
    expect(html).toContain('2 of 3 items')
    expect(html).not.toContain('>3 items<')
  })
})

// ---------------------------------------------------------------------------
// Counter tracks kind filter
// ---------------------------------------------------------------------------

describe('ActionQueuePage sidebar header – counter tracks kind filter', () => {
  it('shows "M of N items" when the Drafts filter hides alert rows', () => {
    const items = [
      makeItem({ id: 'ft:1', entityId: 'e1', kind: 'failed-task', errorKind: 'failed-task', title: 'failed 1' }),
      makeItem({ id: 'ft:2', entityId: 'e2', kind: 'failed-task', errorKind: 'failed-task', title: 'failed 2' }),
      makeItem({ id: 'ft:3', entityId: 'e3', kind: 'failed-task', errorKind: 'failed-task', title: 'failed 3' }),
      makeItem({ id: 'dp:1', entityId: 'p1', kind: 'draft-proposal', errorKind: 'draft-proposal', title: 'draft 1', actions: [] }),
      makeItem({ id: 'dp:2', entityId: 'p2', kind: 'draft-proposal', errorKind: 'draft-proposal', title: 'draft 2', actions: [] }),
    ]
    stubUrlState('', 'drafts')
    const html = renderPage(items)
    expect(html).toContain('2 of 5 items')
  })

  it('shows "M of N items" when the Alerts filter hides draft rows', () => {
    const items = [
      makeItem({ id: 'ft:1', entityId: 'e1', kind: 'failed-task', errorKind: 'failed-task', title: 'alert row' }),
      makeItem({ id: 'dp:1', entityId: 'p1', kind: 'draft-proposal', errorKind: 'draft-proposal', title: 'draft row', actions: [] }),
      makeItem({ id: 'dp:2', entityId: 'p2', kind: 'draft-proposal', errorKind: 'draft-proposal', title: 'draft row 2', actions: [] }),
    ]
    stubUrlState('', 'alerts')
    const html = renderPage(items)
    expect(html).toContain('1 of 3 items')
  })
})

// ---------------------------------------------------------------------------
// entityId search
// ---------------------------------------------------------------------------

describe('ActionQueuePage sidebar – entityId is searchable', () => {
  it('typing an entityId that appears on a row finds that row', () => {
    const target = makeItem({
      id: 'failed-task:mars-d0039bc7',
      entityId: 'mars-d0039bc7',
      title: 'the task we want',
    })
    const other = makeItem({
      id: 'failed-task:other-abc',
      entityId: 'other-abc',
      title: 'irrelevant task',
    })
    stubUrlState('mars-d0039bc7')
    const html = renderPage([target, other])
    expect(html).toContain('the task we want')
    expect(html).toContain('1 of 2 items')
  })

  it('does not crash when entityId is an empty string', () => {
    // entityId is always a string per the schema, but guard is in place
    const item = makeItem({ entityId: '' })
    stubUrlState('somequery')
    // Should not throw; the empty-entityId item simply does not match
    expect(() => renderPage([item])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Empty result
// ---------------------------------------------------------------------------

describe('ActionQueuePage sidebar – empty result state', () => {
  it('renders "No matches." and a count of zero when nothing matches the search', () => {
    const items = [
      makeItem({ id: 'ft:1', entityId: 'e1', title: 'first task' }),
      makeItem({ id: 'ft:2', entityId: 'e2', title: 'second task' }),
    ]
    stubUrlState('zzz-nothing-matches-this')
    const html = renderPage(items)
    expect(html).toContain('No matches.')
    expect(html).toContain('0 of 2 items')
    // Must NOT show the unfiltered total as the plain count
    expect(html).not.toContain('>2 items<')
  })
})
