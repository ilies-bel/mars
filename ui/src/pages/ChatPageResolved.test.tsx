/**
 * Tests for the chat page's "resolved" pane — shown when a projection Thread
 * was selected and its backing action-queue row left the queue (resolved /
 * restarted / superseded by SSE churn).
 *
 * We mock @/shared/actionQueueUrlState so ChatPage mounts with an explicit
 * selected queue item id that is NOT in the live payload, triggering the
 * resolved branch. Kept separate from the other ChatPage tests because the
 * module mock must be declared before the dynamic import.
 */
import { mock, describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionQueueItem, ChatThread } from '@/shared/schemas'

mock.module('@/shared/actionQueueUrlState', () => ({
  readAqStateFromUrl: () => ({ item: 'failed-task:gone-item', kind: 'all', q: '' }),
  writeAqStateToUrl: () => {},
  defaultAqUrlState: () => ({ item: null, kind: 'all', q: '' }),
  encodeAqState: () => '',
  decodeAqState: () => ({ item: null, kind: 'all', q: '' }),
}))

// Dynamic import AFTER the mock is declared.
const { ChatPage } = await import('./ChatPage')

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
} as unknown as ActionQueueItem

const renderPage = (items: ActionQueueItem[], threads: ChatThread[] = []): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['action-queue', null], items)
  qc.setQueryData(['action-queue-history', null], { rows: [], nextCursor: null })
  qc.setQueryData(['chat-threads', undefined], threads)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatPage />
    </QueryClientProvider>,
  )
}

describe('ChatPage — resolved pane for vanished projection Threads', () => {
  it('shows the resolved pane when the pinned row is no longer in the queue', () => {
    const html = renderPage([LIVE_ITEM])
    expect(html).toContain('data-testid="resolved-pane"')
    expect(html).toContain('This item has been resolved')
  })

  it('does NOT show the resolved pane when the selected row is still live', () => {
    const matchingItem: ActionQueueItem = {
      ...LIVE_ITEM,
      id: 'failed-task:gone-item',
      entityId: 'gone-item',
    }
    const html = renderPage([matchingItem])
    expect(html).not.toContain('data-testid="resolved-pane"')
    // The detail pane renders instead.
    expect(html).toContain('Move forward')
  })

  it('does NOT show the resolved pane during the initial empty-load frame', () => {
    const html = renderPage([])
    expect(html).not.toContain('data-testid="resolved-pane"')
  })

  it('offers View task and Back actions on the resolved pane', () => {
    const html = renderPage([LIVE_ITEM])
    expect(html).toContain('View task')
    expect(html).toContain('Back to chat')
  })
})
