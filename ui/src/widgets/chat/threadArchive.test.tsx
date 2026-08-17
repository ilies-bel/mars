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

const RECENT = new Date(Date.now() - 24 * 3600 * 1000).toISOString()      // 1 day ago
const OLD    = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() // > 7 days ago

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

// ---------------------------------------------------------------------------
// Stale-untitled fold in ThreadSidebar
// ---------------------------------------------------------------------------

// An untitled thread created more than 48 hours ago (must be under 7 days to
// avoid the archived block).
const STALE_48H = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() // 3 days ago — stale untitled, not archived

describe('ThreadSidebar stale-untitled fold', () => {
  it('folds untitled threads older than 48h into a single disclosure row', () => {
    const threads = [
      thread({ id: 'titled',   title: 'Titled thread', createdAt: RECENT }),
      thread({ id: 'untitled', title: null,             createdAt: STALE_48H }),
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

    // Titled thread is visible directly.
    expect(container.textContent).toContain('Titled thread')
    // The stale-untitled toggle is present.
    const toggle = container.querySelector('[data-testid="stale-untitled-toggle"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.textContent).toContain('1 older untitled thread')
    // Stale-untitled section body is collapsed — no ThreadItem children visible.
    // ThreadItem divs render with role="button"; only the toggle <button> is present.
    const section = container.querySelector('[data-testid="stale-untitled-section"]')!
    expect(section.querySelectorAll('[role="button"]')).toHaveLength(0)

    root.unmount()
  })

  it('reveals stale untitled threads when the disclosure is opened', () => {
    const threads = [
      thread({ id: 'titled',   title: 'Named thread', createdAt: RECENT }),
      thread({ id: 'stale1',   title: null,            createdAt: STALE_48H }),
      thread({ id: 'stale2',   title: null,            createdAt: STALE_48H }),
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

    // Two stale threads behind the fold.
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="stale-untitled-toggle"]')!
    expect(toggle.textContent).toContain('2 older untitled threads')

    // Open the fold.
    act(() => { toggle.click() })

    // Both "New thread" labels are now visible.
    const text = container.textContent ?? ''
    const count = (text.match(/New thread/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(2)

    root.unmount()
  })

  it('does not show the stale-untitled toggle when all threads have titles', () => {
    const threads = [
      thread({ id: 'a', title: 'Thread A', createdAt: STALE_48H }),
      thread({ id: 'b', title: 'Thread B', createdAt: STALE_48H }),
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

    expect(container.querySelector('[data-testid="stale-untitled-toggle"]')).toBeNull()
    expect(container.textContent).toContain('Thread A')
    expect(container.textContent).toContain('Thread B')

    root.unmount()
  })

  it('does not fold untitled threads that are recent (under 48h)', () => {
    const threads = [
      thread({ id: 'recent-untitled', title: null, createdAt: RECENT }),
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

    // Recent untitled thread appears directly in the list as "New thread".
    expect(container.textContent).toContain('New thread')
    expect(container.querySelector('[data-testid="stale-untitled-toggle"]')).toBeNull()

    root.unmount()
  })
})
