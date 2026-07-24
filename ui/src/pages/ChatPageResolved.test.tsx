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

const RESOLVED_ALERT_THREAD: ChatThread = {
  id: 'th-resolved-alert',
  title: 'Resolved alert conversation',
  status: 'idle',
  origin: 'alert',
  alertItemId: 'failed-task:gone-item',
  alertResolved: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as unknown as ChatThread

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

describe('ChatPage sidebar — resolved alert-origin threads', () => {
  it('resolved alert thread does NOT appear in the main thread list by default', () => {
    const html = renderPage([LIVE_ITEM], [RESOLVED_ALERT_THREAD])
    // The thread title must not be in a ThreadItem in the main list.
    // It may appear in the History accordion label count but not as a row.
    // We verify there is no ThreadItem with aria-label="Delete thread" for it —
    // ThreadItems (regular rows) have a delete button; history-thread-rows do not.
    // More directly: the title only appears if the history body is expanded (it's
    // not by default), so the title must not appear in the collapsed static render.
    expect(html).not.toContain('Resolved alert conversation')
  })

  it('History accordion label count includes the resolved alert thread', () => {
    const html = renderPage([LIVE_ITEM], [RESOLVED_ALERT_THREAD])
    // With no queue history rows and 1 resolved alert thread the label is "History · 1".
    expect(html).toContain('History · 1')
  })

  it('History accordion label shows count of both queue history rows and resolved threads', () => {
    // Pre-seed one queue history row by using action-queue-history.
    // We do this by wrapping our own renderPage variant inline.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const historyItem: ActionQueueItem = {
      ...LIVE_ITEM,
      id: 'failed-task:archived',
      entityId: 'archived',
    } as unknown as ActionQueueItem
    qc.setQueryData(['action-queue', null], [LIVE_ITEM])
    qc.setQueryData(['action-queue-history', null], {
      rows: [historyItem],
      nextCursor: null,
    })
    qc.setQueryData(['chat-threads', undefined], [RESOLVED_ALERT_THREAD])
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <ChatPage />
      </QueryClientProvider>,
    )
    // 1 queue history row + 1 resolved alert thread = 2
    expect(html).toContain('History · 2')
  })
})
