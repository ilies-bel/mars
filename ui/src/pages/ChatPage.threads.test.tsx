// @vitest-environment happy-dom
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
 *
 * Interactive tests (handleOpenSubthread) use createRoot + act to exercise
 * user interactions that require a live DOM.
 */

import { describe, it, expect } from 'bun:test'
import { vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThreadSidebar, ChatPage } from './ChatPage'
import { relativeTime, smartTitle } from './chatPageUtils'
import type { ChatThread, ActionQueueItem } from '@/shared/schemas'

const mockFetchChatHistory = vi.hoisted(() => vi.fn())
const mockFetchChatConversation = vi.hoisted(() => vi.fn())

// ---------------------------------------------------------------------------
// window.matchMedia stub (happy-dom doesn't implement it)
// ---------------------------------------------------------------------------
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

// ---------------------------------------------------------------------------
// Module mocks — hoisted by vitest before imports execute.
// ---------------------------------------------------------------------------

const mockStartThreadFromAlert = vi.fn()

vi.mock('@/entities/alerts/api', () => ({
  startThreadFromAlert: (...args: unknown[]) => mockStartThreadFromAlert(...args),
  fetchAlerts: vi.fn().mockResolvedValue([]),
  useAlerts: () => ({ alerts: [], error: null }),
  useStartThreadFromAlert: () => ({ mutate: vi.fn(), isPending: false }),
}))

const mockUseActionQueue = vi.fn()

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => mockUseActionQueue(),
}))

vi.mock('@/entities/actionQueue/useActionQueueHistory', () => ({
  useActionQueueHistory: () => ({
    items: [],
    nextCursor: null,
    isLoadingMore: false,
    loadMore: vi.fn(),
    error: null,
    projectsError: null,
    projectsEmpty: false,
  }),
}))


vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  useFocusedProject: () => ({
    focusedProjectId: null,
    projectsSettled: true,
    projectsError: null,
    projects: [],
    setFocusedProjectId: vi.fn(),
  }),
}))

vi.mock('@/shared/api', () => ({
  fetchChatLayoutPreference: vi.fn().mockResolvedValue({ layout: 'focus' }),
  putChatLayoutPreference: vi.fn().mockResolvedValue({ layout: 'focus' }),
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue(null),
  fetchChatHistory: (...args: unknown[]) => mockFetchChatHistory(...args),
  fetchChatConversation: (...args: unknown[]) => mockFetchChatConversation(...args),
  fetchCodexAuthState: vi.fn().mockResolvedValue(null),
  refreshCodexAuth: vi.fn().mockResolvedValue(null),
  fetchGlossary: vi.fn().mockResolvedValue([]),
  fetchSkills: vi.fn().mockResolvedValue([]),
  fetchAdrs: vi.fn().mockResolvedValue([]),
  fetchVision: vi.fn().mockResolvedValue(null),
  fetchChatConfig: vi.fn().mockResolvedValue(null),
  createChatThread: vi.fn().mockResolvedValue({
    id: 'new-thread-1',
    title: null,
    status: 'idle',
    createdAt: '',
    updatedAt: '',
    messageCount: 0,
  }),
  postChatMessage: vi.fn().mockResolvedValue(undefined),
  uploadAttachment: vi.fn().mockResolvedValue({
    id: 'u1',
    path: '/uploads/u1',
    mimeType: 'image/png',
    name: 'f.png',
  }),
  renameChatThread: vi.fn().mockResolvedValue(undefined),
  stopChatThread: vi.fn().mockResolvedValue(undefined),
  setMessageFeedback: vi.fn().mockResolvedValue(undefined),
  clearMessageFeedback: vi.fn().mockResolvedValue(undefined),
  invokeAction: vi.fn().mockResolvedValue(undefined),
  ApiError: class ApiError extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.kind = kind
    }
  },
}))

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
        filters: { query: '', kind: 'all', origin: 'all' },
        onFiltersChange: () => {},
        selectedItem: null,
        onFastAction: () => {},
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
        filters: { query: '', kind: 'all', origin: 'all' },
        onFiltersChange: () => {},
        selectedItem: null,
        onFastAction: () => {},
      }),
    ),
  )
}

const makeQc = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

const makeArcFailedItem = (overrides: Partial<ActionQueueItem> = {}): ActionQueueItem =>
  ({
    id: 'q-arc-1',
    kind: 'arc-failed',
    entityId: 'arc-xyz-123',
    priority: 'high',
    title: 'Arc failed: deploy-prod',
    body: 'The arc failed at step 3.',
    at: '2026-01-01T00:00:00.000Z',
    dag: null,
    errorKind: 'arc-failed',
    actions: [],
    diagnosis: null,
    failureReasonCode: null,
    humanSummary: 'Deploy arc got stuck.',
    verbs: [],
    decisions: [],
    ...overrides,
  } as ActionQueueItem)

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

  it('shows a neutral alert icon for alert threads with opaque row ids', () => {
    const html = renderSidebar([
      makeThread({
        origin: 'alert',
        alertItemId: 'mars-123',
        alertResolved: false,
      }),
    ])
    expect(html).toContain('🔔')
  })

  it('does not infer a proposal icon from an opaque alert row id', () => {
    const html = renderSidebar([
      makeThread({
        origin: 'alert',
        alertItemId: 'mars-456',
        alertResolved: false,
      }),
    ])
    expect(html).toContain('🔔')
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

// ---------------------------------------------------------------------------
// ChatPage — handleOpenSubthread: chip pick opens a Subthread inline
// ---------------------------------------------------------------------------

describe('ChatPage – handleOpenSubthread: chip opens Subthread inline', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    mockFetchChatHistory.mockResolvedValue([])
    mockFetchChatConversation.mockResolvedValue({
      entries: [], boundaries: [], memoryStartsAfterSeq: 0, memoryCutAt: null, memoryCutReason: null,
    })
    mockStartThreadFromAlert.mockResolvedValue({ threadId: 'subthread-thread-123' })
    mockUseActionQueue.mockReturnValue({
      items: [],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('clicking an arc-failed chip calls startThreadFromAlert and sets the active subthread thread', async () => {
    const arcItem = makeArcFailedItem()
    mockUseActionQueue.mockReturnValue({
      items: [arcItem],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })

    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: makeQc() },
          createElement(ChatPage),
        ),
      )
    })

    // Chip should be visible in the opening next-moves
    const chip = container.querySelector('[data-testid="next-move-chip"]')
    expect(chip).not.toBeNull()

    // Click the chip — triggers handleOpenSubthread
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // Allow the async startThreadFromAlert promise to resolve
      await Promise.resolve()
      await Promise.resolve()
    })

    // startThreadFromAlert should have been called with the arc entityId
    expect(mockStartThreadFromAlert).toHaveBeenCalledWith('arc-xyz-123')

    // The active subthread div should now exist with the returned thread id
    const subthread = container.querySelector('[data-testid="active-subthread"]')
    expect(subthread).not.toBeNull()
    expect(subthread?.getAttribute('data-thread-id')).toBe('subthread-thread-123')

    // Opening block must remain visible — no unmount
    const opening = container.querySelector('[data-testid="mars-opening-message"]')
    expect(opening).not.toBeNull()
  })

  it('repeated clicks on the same arc-failed chip call startThreadFromAlert each time (daemon deduplicates)', async () => {
    const arcItem = makeArcFailedItem()
    mockUseActionQueue.mockReturnValue({
      items: [arcItem],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    // Both calls return the same thread (daemon dedup)
    mockStartThreadFromAlert.mockResolvedValue({ threadId: 'subthread-thread-123' })

    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: makeQc() },
          createElement(ChatPage),
        ),
      )
    })

    const chip = container.querySelector('[data-testid="next-move-chip"]')
    expect(chip).not.toBeNull()

    // First click
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    // Second click on the same chip
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockStartThreadFromAlert).toHaveBeenCalledTimes(2)

    // The active subthread still shows the (same) thread id
    const subthread = container.querySelector('[data-testid="active-subthread"]')
    expect(subthread?.getAttribute('data-thread-id')).toBe('subthread-thread-123')
  })

  it('keeps closed Subthread messages expanded in the chronological feed', async () => {
    mockFetchChatConversation.mockResolvedValue({
      entries: [
        {
          id: 'past-first-message', seq: 1, threadId: 'past-first', subthreadId: 'past-first', subthreadTitle: 'First past Subthread', subthreadClosed: true,
          role: 'assistant', content: 'First past message.', segments: [], createdAt: '2026-07-31T08:00:00.000Z', kind: 'situation', backingEntityId: null, resolution: null,
        },
        {
          id: 'past-second-message', seq: 2, threadId: 'past-second', subthreadId: 'past-second', subthreadTitle: 'Second past Subthread', subthreadClosed: true,
          role: 'assistant', content: 'Second past message.', segments: [], createdAt: '2026-07-31T09:00:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
        },
      ],
      boundaries: [
        { subthreadId: 'past-first', startedAt: '2026-07-31T08:00:00.000Z', closedAt: '2026-07-31T08:01:00.000Z', producedTokens: 10, carriedTokens: 5 },
        { subthreadId: 'past-second', startedAt: '2026-07-31T09:00:00.000Z', closedAt: '2026-07-31T09:01:00.000Z', producedTokens: 20, carriedTokens: 10 },
      ],
      memoryStartsAfterSeq: 0, memoryCutAt: null, memoryCutReason: null,
    })
    const arcItem = makeArcFailedItem()
    mockUseActionQueue.mockReturnValue({
      items: [arcItem],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })

    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: makeQc() }, createElement(ChatPage)),
      )
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelector('[data-testid="past-subthreads-column"]')).toBeNull()
    expect(container.querySelector('[data-testid="chat-history-section"]')).toBeNull()
    expect(container.textContent).toContain('First past message.')
    expect(container.textContent).toContain('Second past message.')
    expect(container.textContent!.indexOf('First past message.')).toBeLessThan(
      container.textContent!.indexOf('Second past message.'),
    )

    await act(async () => {
      container.querySelector('[data-testid="next-move-chip"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="active-subthread"]')).not.toBeNull()
  })
})
