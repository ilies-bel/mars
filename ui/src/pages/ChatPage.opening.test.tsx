// @vitest-environment happy-dom
/**
 * Seeded opening message tests for ChatPage.
 *
 * Covers the new behaviour introduced by the collapse-hero PRD (slice 2):
 *   - There is no hero screen; the chat feed is present on first paint.
 *   - Mars's first message is derived from the top action-queue item's
 *     humanSummary, or a static "nothing pressing" fallback when the queue
 *     is empty.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPage } from './ChatPage'
import type { ActionQueueItem } from '@/shared/schemas'

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
// Module mocks — hoisted by vite before imports execute.
// ---------------------------------------------------------------------------

// Controllable useActionQueue return value: start empty, override per-test.
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
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue(null),
  fetchChatHistory: vi.fn().mockResolvedValue([]),
  fetchCodexAuthState: vi.fn().mockResolvedValue(null),
  refreshCodexAuth: vi.fn().mockResolvedValue(null),
  fetchGlossary: vi.fn().mockResolvedValue([]),
  fetchSkills: vi.fn().mockResolvedValue([]),
  fetchAdrs: vi.fn().mockResolvedValue([]),
  fetchVision: vi.fn().mockResolvedValue(null),
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
  deleteChatThread: vi.fn().mockResolvedValue(undefined),
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

const makeQc = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

const makeItem = (overrides: Partial<ActionQueueItem> = {}): ActionQueueItem =>
  ({
    id: 'q-1',
    kind: 'failed-task',
    entityId: 'task-abc',
    priority: 'high',
    title: 'Something failed',
    body: 'Details here',
    at: '2026-01-01T00:00:00.000Z',
    dag: null,
    errorKind: 'failed-task',
    actions: [],
    diagnosis: null,
    failureReasonCode: null,
    humanSummary: 'A task got stuck and needs your decision.',
    verbs: [],
    decisions: [],
    ...overrides,
  } as ActionQueueItem)

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  // Default: empty queue
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
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatPage — seeded opening message (no thread selected)', () => {
  it('renders the seeded feed instead of the hero on first paint', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    // Seeded feed is present
    expect(container.querySelector('[data-testid="seeded-feed"]')).not.toBeNull()

    // Old hero headline is gone
    expect(container.querySelector('[data-testid="hero-headline"]')).toBeNull()
  })

  it('shows the top queue item humanSummary as the Mars opening message', async () => {
    const item = makeItem({ humanSummary: 'Task deploy-prod got stuck — decide what to do.' })
    mockUseActionQueue.mockReturnValue({
      items: [item],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    const el = container.querySelector('[data-testid="mars-opening-message"]')
    expect(el).not.toBeNull()
    expect(el?.textContent).toContain('Task deploy-prod got stuck — decide what to do.')
  })

  it('shows the nothing-pressing fallback when the queue is empty', async () => {
    // mockUseActionQueue already returns empty items from beforeEach

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    const el = container.querySelector('[data-testid="mars-opening-message"]')
    expect(el).not.toBeNull()
    expect(el?.textContent).toContain("Nothing's pressing right now")
  })

  it('picks the highest-priority item when the queue has multiple rows', async () => {
    const low = makeItem({
      id: 'q-low',
      priority: 'low',
      humanSummary: 'Low priority item.',
      at: '2026-01-02T00:00:00.000Z',
    })
    const high = makeItem({
      id: 'q-high',
      priority: 'high',
      humanSummary: 'High priority item needs attention.',
      at: '2026-01-01T00:00:00.000Z',
    })
    mockUseActionQueue.mockReturnValue({
      items: [low, high],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    const el = container.querySelector('[data-testid="mars-opening-message"]')
    expect(el?.textContent).toContain('High priority item needs attention.')
    expect(el?.textContent).not.toContain('Low priority item.')
  })
})
