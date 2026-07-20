/**
 * DOM-level tests for the chat sidebar's absorbed action queue: projection
 * Threads float above regular chat threads, the kind toggle and search input
 * render, and the history accordion sits at the bottom, collapsed.
 *
 * Uses renderToStaticMarkup with a pre-warmed QueryClient — effects never run,
 * so the URL write-back and SSE plumbing are inert.
 */
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPage } from './ChatPage'
import type { ActionQueueItem, ChatThread } from '@/shared/schemas'

const QUEUE_ITEM: ActionQueueItem = {
  id: 'failed-task:t-1',
  kind: 'failed-task',
  entityId: 't-1',
  priority: 'high',
  title: 'projection thread title',
  body: 'the daemon needs a decision',
  at: new Date().toISOString(),
  dag: null,
  errorKind: 'failed-task',
  actions: [
    { id: 'restart', label: 'Restart', op: 'restart' },
    { id: 'purge', label: 'Purge', op: 'purge', needsConfirm: true },
  ],
  diagnosis: null,
} as unknown as ActionQueueItem

const PLAIN_THREAD: ChatThread = {
  id: 'th-plain',
  title: 'regular conversation title',
  status: 'idle',
  origin: null,
  alertItemId: null,
  alertResolved: false,
} as unknown as ChatThread

const ALERT_THREAD: ChatThread = {
  id: 'th-alert',
  title: 'alert conversation title',
  status: 'idle',
  origin: 'alert',
  alertItemId: 'failed-task:t-1',
  alertResolved: false,
} as unknown as ChatThread

const renderPage = (
  items: ActionQueueItem[],
  threads: ChatThread[],
): string => {
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

describe('ChatPage sidebar – projection Threads float above chat threads', () => {
  it('renders projection rows before regular chat threads', () => {
    const html = renderPage([QUEUE_ITEM], [PLAIN_THREAD])
    const projectionPos = html.indexOf('projection thread title')
    const threadPos = html.indexOf('regular conversation title')
    expect(projectionPos).toBeGreaterThan(-1)
    expect(threadPos).toBeGreaterThan(-1)
    expect(projectionPos).toBeLessThan(threadPos)
  })

  it('merges an alert-origin thread with its live row into one entry', () => {
    const html = renderPage([QUEUE_ITEM], [ALERT_THREAD, PLAIN_THREAD])
    // The merged entry renders the queue row (not a second ThreadItem for the
    // alert thread) plus the conversation marker.
    expect(html).toContain('data-testid="projection-has-conversation"')
    expect(html).not.toContain('alert conversation title')
    // The plain thread remains a regular entry.
    expect(html).toContain('regular conversation title')
  })

  it('projection rows carry the quick Decision pills', () => {
    const html = renderPage([QUEUE_ITEM], [])
    expect(html).toContain('Purge')
    expect(html).toContain('>Restart<')
  })

  it('projection rows have no delete affordance', () => {
    const html = renderPage([QUEUE_ITEM], [])
    expect(html).not.toContain('aria-label="Delete thread"')
  })
})

describe('ChatPage sidebar – migrated search and kind filter', () => {
  it('renders the All | Alerts | Drafts kind toggle with data-testids', () => {
    const html = renderPage([QUEUE_ITEM], [])
    expect(html).toContain('data-testid="action-queue-filter-all"')
    expect(html).toContain('data-testid="action-queue-filter-alerts"')
    expect(html).toContain('data-testid="action-queue-filter-drafts"')
  })

  it('"All" is pressed by default', () => {
    const html = renderPage([QUEUE_ITEM], [])
    const allBtnIdx = html.indexOf('data-testid="action-queue-filter-all"')
    const snippet = html.slice(Math.max(0, allBtnIdx - 120), allBtnIdx + 150)
    expect(snippet).toContain('aria-pressed="true"')
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
  })

  it('renders the search input', () => {
    expect(renderPage([], [])).toContain('data-testid="action-queue-search"')
  })
})

describe('ChatPage sidebar – history accordion', () => {
  it('renders the accordion collapsed by default at the bottom of the sidebar', () => {
    const html = renderPage([], [])
    expect(html).toContain('data-testid="history-accordion"')
    const accordionStart = html.indexOf('data-testid="history-accordion"')
    const snippet = html.slice(accordionStart, accordionStart + 500)
    expect(snippet).toContain('aria-expanded="false"')
    // Collapsed → the section body (and Load more) is not rendered.
    expect(html).not.toContain('id="section-body-history"')
    expect(html).not.toContain('data-testid="history-load-more"')
  })
})
