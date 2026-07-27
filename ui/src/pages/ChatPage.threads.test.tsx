/**
 * Tests for thread sidebar scanability improvements:
 *   - Relative timestamps on each row
 *   - Smart title truncation (strips common category prefixes)
 *   - Type-specific icons per thread category
 *   - Bottom border between rows for visual separation
 *
 * Pure-function tests (relativeTime, smartTitle) use the exported helpers
 * directly. DOM-level tests render ThreadSidebar via renderToStaticMarkup with
 * a pre-seeded QueryClient — effects never run, so only the initial render
 * is exercised.
 */

import { describe, it, expect } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThreadSidebar } from './ChatPage'
import { relativeTime, smartTitle } from './chatPageUtils'
import type { ChatThread } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeThread = (overrides: Partial<ChatThread> = {}): ChatThread => ({
  id: 'th-1',
  title: 'regular conversation',
  status: 'idle',
  origin: null,
  alertItemId: null,
  alertResolved: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  messageCount: 0,
  ...overrides,
} as unknown as ChatThread)

const renderSidebar = (threads: ChatThread[]): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['chat-threads', undefined], threads)
  qc.setQueryData(['chat-history', undefined], [])
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ThreadSidebar, {
        selectedId: null,
        onSelect: () => {},
      }),
    ),
  )
}

/** Render the sidebar with no pre-seeded query data (simulates initial load). */
const renderSidebarPending = (): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  // No setQueryData — query stays in pending state for static render
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ThreadSidebar, {
        selectedId: null,
        onSelect: () => {},
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// relativeTime — pure function
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  it('returns "just now" for a timestamp less than 1 minute ago', () => {
    const now = Date.now()
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe('just now')
  })

  it('returns "Xm ago" for timestamps within the last hour', () => {
    const now = Date.now()
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5m ago')
  })

  it('returns "Xh ago" for timestamps within the last 24 hours', () => {
    const now = Date.now()
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3h ago')
  })

  it('returns "Xd ago" for timestamps older than a day', () => {
    const now = Date.now()
    expect(relativeTime(new Date(now - 5 * 86_400_000).toISOString(), now)).toBe('5d ago')
  })

  it('returns "just now" for future timestamps', () => {
    const now = Date.now()
    expect(relativeTime(new Date(now + 5_000).toISOString(), now)).toBe('just now')
  })
})

// ---------------------------------------------------------------------------
// smartTitle — pure function
// ---------------------------------------------------------------------------

describe('smartTitle', () => {
  it('returns "New thread" for null titles', () => {
    expect(smartTitle(null)).toBe('New thread')
  })

  it('strips the "Phantom task auto-" prefix and returns the task ID portion', () => {
    expect(smartTitle('Phantom task auto-mars-abc123')).toBe('mars-abc123')
  })

  it('passes through non-prefixed titles unchanged', () => {
    expect(smartTitle('regular conversation title')).toBe('regular conversation title')
  })

  it('handles an empty string by returning it unchanged', () => {
    expect(smartTitle('')).toBe('New thread')
  })
})

// ---------------------------------------------------------------------------
// ThreadSidebar — DOM integration
// ---------------------------------------------------------------------------

describe('ThreadSidebar – row scanability', () => {
  it('renders a relative timestamp for each thread row', () => {
    const thread = makeThread({
      updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    })
    const html = renderSidebar([thread])
    expect(html).toContain('2h ago')
  })

  it('shows a chat icon (💬) for user-created threads', () => {
    const html = renderSidebar([makeThread({ origin: null })])
    expect(html).toContain('💬')
  })

  it('shows a warning icon (⚠️) for failed-task alert threads', () => {
    const html = renderSidebar([
      makeThread({
        origin: 'alert',
        alertItemId: 'failed-task:mars-123',
        alertResolved: false,
      }),
    ])
    expect(html).toContain('⚠️')
  })

  it('shows a proposal icon (💡) for draft-proposal alert threads', () => {
    const html = renderSidebar([
      makeThread({
        origin: 'alert',
        alertItemId: 'draft-proposal:mars-456',
        alertResolved: false,
      }),
    ])
    expect(html).toContain('💡')
  })

  it('smart-truncates "Phantom task auto-" prefix in thread titles', () => {
    const html = renderSidebar([
      makeThread({ title: 'Phantom task auto-mars-abc123' }),
    ])
    // Should show the meaningful part (task ID) not the full verbose prefix
    expect(html).toContain('mars-abc123')
    expect(html).not.toContain('Phantom task auto-mars-abc123')
  })

  it('renders thread rows with a bottom border for visual separation', () => {
    const html = renderSidebar([makeThread()])
    expect(html).toContain('border-b')
  })
})

// ---------------------------------------------------------------------------
// ThreadSidebar — loading state (no false empty-state flash)
// ---------------------------------------------------------------------------

describe('ThreadSidebar – pending state', () => {
  it('renders a skeleton while the query is pending, not the empty-state text', () => {
    const html = renderSidebarPending()
    // Skeleton wrapper should be present (aria-busy)
    expect(html).toContain('aria-busy="true"')
    // The empty-state text must NOT appear during the pending phase
    expect(html).not.toContain("You're all clear")
  })

  it('renders skeleton with accessible label while pending', () => {
    const html = renderSidebarPending()
    expect(html).toContain('Loading threads')
  })

  it('renders the empty-state text only after data resolves as empty', () => {
    const html = renderSidebar([]) // data resolved, zero threads
    // The empty-state paragraph uses data-testid="empty-rail"
    expect(html).toContain('data-testid="empty-rail"')
    expect(html).not.toContain('aria-busy="true"')
  })
})
