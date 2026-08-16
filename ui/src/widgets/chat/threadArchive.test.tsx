// @vitest-environment happy-dom
/**
 * Tests for thread archiving helpers and the sidebar archive toggle.
 *
 * Pure-function tests (isArchived, formatRelative) run without DOM;
 * the toggle test renders ThreadSidebar under happy-dom.
 */

import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { formatRelative, isArchived } from './queueThreads'
import type { ChatThread } from '@/shared/schemas'
import { ThreadSidebar } from '@/pages/ChatPage'
import type { ThreadListFilters } from './queueThreads'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECENT = '2026-08-15T12:00:00.000Z'  // 1 day ago relative to 2026-08-16
const OLD    = '2026-06-01T00:00:00.000Z'  // > 7 days ago

const thread = (overrides: Partial<ChatThread>): ChatThread => ({
  id: 'th-base',
  title: 'A thread',
  status: 'idle',
  origin: null,
  alertItemId: null,
  alertResolved: false,
  createdAt: RECENT,
  updatedAt: RECENT,
  archivedAt: null,
  ...overrides,
} as ChatThread)

// ---------------------------------------------------------------------------
// isArchived
// ---------------------------------------------------------------------------

describe('isArchived', () => {
  const NOW = new Date('2026-08-16T00:00:00.000Z').getTime()

  it('returns false for a thread created 1 day ago (under 7-day threshold)', () => {
    expect(isArchived(thread({ createdAt: RECENT }), NOW)).toBe(false)
  })

  it('returns true for a thread created more than 7 days ago', () => {
    expect(isArchived(thread({ createdAt: OLD }), NOW)).toBe(true)
  })

  it('returns true when archivedAt is set regardless of age', () => {
    expect(
      isArchived(thread({ createdAt: RECENT, archivedAt: '2026-08-14T00:00:00.000Z' }), NOW),
    ).toBe(true)
  })

  it('returns false when archivedAt is null and thread is recent', () => {
    expect(isArchived(thread({ createdAt: RECENT, archivedAt: null }), NOW)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// formatRelative
// ---------------------------------------------------------------------------

describe('formatRelative', () => {
  const base = new Date('2026-08-16T12:00:00.000Z').getTime()

  it('returns "now" for a timestamp within the last 60 seconds', () => {
    expect(formatRelative(base - 30_000, base)).toBe('now')
    expect(formatRelative(base - 0, base)).toBe('now')
  })

  it('returns "Nm" for timestamps between 1 minute and 1 hour ago', () => {
    expect(formatRelative(base - 2 * 60_000, base)).toBe('2m')
    expect(formatRelative(base - 59 * 60_000, base)).toBe('59m')
  })

  it('returns "Nh" for timestamps between 1 hour and 24 hours ago', () => {
    expect(formatRelative(base - 4 * 3_600_000, base)).toBe('4h')
    expect(formatRelative(base - 23 * 3_600_000, base)).toBe('23h')
  })

  it('returns "Nd" for timestamps older than 24 hours', () => {
    expect(formatRelative(base - 3 * 86_400_000, base)).toBe('3d')
    expect(formatRelative(base - 10 * 86_400_000, base)).toBe('10d')
  })
})

// ---------------------------------------------------------------------------
// Archived toggle in ThreadSidebar — DOM integration
// ---------------------------------------------------------------------------

const filters: ThreadListFilters = { query: '', origin: 'all' }

function makeQueryClient(threads: ChatThread[]): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['chat-threads', undefined], threads)
  return qc
}

describe('ThreadSidebar archive toggle', () => {
  it('hides archived threads by default and shows the toggle button', () => {
    const threads = [
      thread({ id: 'live',     title: 'Live thread',     createdAt: RECENT }),
      thread({ id: 'archived', title: 'Old thread',      createdAt: OLD }),
    ]
    const qc = makeQueryClient(threads)
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <ThreadSidebar
            selectedId={null}
            onSelect={() => {}}
            filters={filters}
            onFiltersChange={() => {}}
            selectedItem={null}
            onFastAction={() => {}}
            onSelectMainThread={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    // Live thread is visible; archived thread is not.
    expect(container.textContent).toContain('Live thread')
    expect(container.textContent).not.toContain('Old thread')

    // The toggle button is present and shows the count.
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="archived-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.textContent).toContain('archived (1)')

    root.unmount()
  })

  it('reveals archived threads when the toggle is clicked', () => {
    const threads = [
      thread({ id: 'live',     title: 'Live thread',   createdAt: RECENT }),
      thread({ id: 'archived', title: 'Old thread',    createdAt: OLD }),
    ]
    const qc = makeQueryClient(threads)
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <ThreadSidebar
            selectedId={null}
            onSelect={() => {}}
            filters={filters}
            onFiltersChange={() => {}}
            selectedItem={null}
            onFastAction={() => {}}
            onSelectMainThread={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    // Confirm hidden before click.
    expect(container.textContent).not.toContain('Old thread')

    // Click the toggle.
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="archived-toggle"]')!.click()
    })

    // Archived thread is now visible.
    expect(container.textContent).toContain('Old thread')
    // Live thread is still visible.
    expect(container.textContent).toContain('Live thread')

    root.unmount()
  })

  it('collapses archived threads when the toggle is clicked again', () => {
    const threads = [
      thread({ id: 'live',     title: 'Live thread',   createdAt: RECENT }),
      thread({ id: 'archived', title: 'Old thread',    createdAt: OLD }),
    ]
    const qc = makeQueryClient(threads)
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <ThreadSidebar
            selectedId={null}
            onSelect={() => {}}
            filters={filters}
            onFiltersChange={() => {}}
            selectedItem={null}
            onFastAction={() => {}}
            onSelectMainThread={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    // Open the archived block.
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="archived-toggle"]')!.click()
    })
    expect(container.textContent).toContain('Old thread')

    // Close it again.
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="archived-toggle"]')!.click()
    })
    expect(container.textContent).not.toContain('Old thread')

    root.unmount()
  })

  it('shows no archive toggle when all threads are recent', () => {
    const threads = [
      thread({ id: 'live1', title: 'Thread A', createdAt: RECENT }),
      thread({ id: 'live2', title: 'Thread B', createdAt: RECENT }),
    ]
    const qc = makeQueryClient(threads)
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <ThreadSidebar
            selectedId={null}
            onSelect={() => {}}
            filters={filters}
            onFiltersChange={() => {}}
            selectedItem={null}
            onFastAction={() => {}}
            onSelectMainThread={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    expect(container.querySelector('[data-testid="archived-toggle"]')).toBeNull()
    expect(container.textContent).toContain('Thread A')
    expect(container.textContent).toContain('Thread B')

    root.unmount()
  })
})
