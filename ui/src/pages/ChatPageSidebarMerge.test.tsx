/**
 * DOM-level tests for the chat sidebar: it is a plain list of conversation
 * threads with a title search. Alerts live on the top-bar Bell (slices 1-2),
 * so the sidebar no longer renders action-queue projection rows, the
 * All|Alerts|Drafts kind toggle, or the resolved-rows History accordion.
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

const renderPage = (
  items: ActionQueueItem[],
  threads: ChatThread[],
  needsCodexAuth = false,
): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['action-queue', null], items)
  qc.setQueryData(['action-queue-history', null], { rows: [], nextCursor: null })
  qc.setQueryData(['chat-threads', undefined], threads)
  if (needsCodexAuth) qc.setQueryData(['codex-auth', undefined], { needsAuth: true })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ChatPage />
    </QueryClientProvider>,
  )
}

describe('ChatPage sidebar – conversation threads only', () => {
  it('tells operators to complete the terminal Codex login before retrying chat', () => {
    const html = renderPage([], [], true)

    expect(html).toContain('data-testid="codex-auth-banner"')
    expect(html).toContain('run codex login')
    expect(html).toContain('After completing the terminal login, retry.')
    expect(html).toContain('>Retry<')
    expect(html).not.toContain('Re-authenticate')
  })

  it('renders conversation threads in the sidebar', () => {
    const html = renderPage([], [PLAIN_THREAD])
    expect(html).toContain('regular conversation title')
  })

  it('renders the thread search input', () => {
    expect(renderPage([], [])).toContain('data-testid="thread-search"')
  })

  it('does NOT render action-queue projection rows even when queue rows exist', () => {
    const html = renderPage([QUEUE_ITEM], [PLAIN_THREAD])
    // No projection row is rendered for the queue item: the projection-merge
    // marker and the row's quick Decision pills are absent from the sidebar.
    // (The queue item may still surface in the out-of-scope hero alert preview.)
    expect(html).not.toContain('data-testid="projection-has-conversation"')
    expect(html).not.toContain('>Purge<')
    // The conversation thread is still present.
    expect(html).toContain('regular conversation title')
  })

  it('does NOT render the All | Alerts | Drafts kind toggle', () => {
    const html = renderPage([QUEUE_ITEM], [])
    expect(html).not.toContain('data-testid="action-queue-filter-all"')
    expect(html).not.toContain('data-testid="action-queue-filter-alerts"')
    expect(html).not.toContain('data-testid="action-queue-filter-drafts"')
  })

  it('does NOT render the resolved-rows History accordion', () => {
    const html = renderPage([], [PLAIN_THREAD])
    expect(html).not.toContain('data-testid="history-accordion"')
  })
})
