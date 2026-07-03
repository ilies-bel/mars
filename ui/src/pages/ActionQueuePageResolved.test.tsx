/**
 * Tests for the ActionQueuePage "resolved" pane — the state shown when the
 * user had an item selected and it disappeared from the live queue (resolved /
 * restarted / removed by SSE churn).
 *
 * We mock @/shared/actionQueueUrlState so the component mounts with an explicit
 * selectedId that points at an item NOT in the action-queue payload, triggering
 * the isResolved=true branch.
 *
 * This file is separate from ActionQueuePageDetail.test.tsx because the module
 * mock must be declared before the dynamic import of ActionQueuePage; mixing it
 * with the static import in the detail test file is not safe.
 */
import { mock, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Mock URL state — return a selectedId that won't be in the items payload so
// the page reaches the isResolved=true branch on first render.
// ---------------------------------------------------------------------------

mock.module('@/shared/actionQueueUrlState', () => ({
  readAqStateFromUrl: () => ({ item: 'failed-task:gone-item', kind: 'all', q: '' }),
  writeAqStateToUrl: () => {},
  defaultAqUrlState: () => ({ item: null, kind: 'all', q: '' }),
  encodeAqState: () => '',
  decodeAqState: () => ({ item: null, kind: 'all', q: '' }),
}))

// Dynamic import AFTER mock is declared (hoisting ensures mock runs first).
const { ActionQueuePage: Page } = await import('./ActionQueuePage')

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const LIVE_ITEM: ActionQueueItem = {
  id: 'failed-task:t-alive',
  kind: 'failed-task',
  entityId: 't-alive',
  priority: 'normal',
  title: 'A live task',
  body: 'still in the queue',
  at: new Date().toISOString(),
  dag: null,
  errorKind: 'failed-task',
  actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
  diagnosis: null,
  failureReasonCode: null,
}

const makeClient = (items: ActionQueueItem[]) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['action-queue', null], items)
  qc.setQueryData(['action-queue-history', null], { items: [], nextCursor: null })
  return qc
}

const renderPage = (qc: QueryClient): string =>
  renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Page />
    </QueryClientProvider>,
  )

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionQueuePage — resolved pane', () => {
  it('shows the resolved pane when selectedId points to an item no longer in the queue', () => {
    // Queue has LIVE_ITEM; selected id is 'failed-task:gone-item' (not in queue).
    // items.length > 0 satisfies the "data has loaded" guard.
    const qc = makeClient([LIVE_ITEM])
    const html = renderPage(qc)
    expect(html).toContain('data-testid="resolved-pane"')
    expect(html).toContain('This item has been resolved')
  })

  it('does NOT show the resolved pane when the selected item exists in the live queue', () => {
    // The mock returns selectedId='failed-task:gone-item', but this test confirms
    // that when the LIVE_ITEM is the only item and its id MATCHES selectedId,
    // the resolved pane is absent.
    // Use a client whose item id matches the mocked selectedId.
    const matchingItem: ActionQueueItem = {
      ...LIVE_ITEM,
      id: 'failed-task:gone-item',
      entityId: 'gone-item',
    }
    const qc = makeClient([matchingItem])
    const html = renderPage(qc)
    expect(html).not.toContain('data-testid="resolved-pane"')
  })

  it('does NOT show the resolved pane when the queue is empty (loading guard)', () => {
    // items.length === 0 → isResolved guard prevents "resolved" during initial load.
    const qc = makeClient([])
    const html = renderPage(qc)
    expect(html).not.toContain('data-testid="resolved-pane"')
  })

  it('shows a Back to queue button on the resolved pane', () => {
    const qc = makeClient([LIVE_ITEM])
    const html = renderPage(qc)
    expect(html).toContain('Back to queue')
  })

  it('shows a View task button on the resolved pane', () => {
    const qc = makeClient([LIVE_ITEM])
    const html = renderPage(qc)
    expect(html).toContain('View task')
  })
})
