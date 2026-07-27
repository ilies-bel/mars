// @vitest-environment happy-dom
/**
 * Seeded opening message tests for ChatPage.
 *
 * Verifies the queue-summary opening introduced when pending work exists:
 *   - There is no hero screen; the chat feed is present on first paint.
 *   - When the action queue has actionable items, a grouped queue summary is
 *     shown (blocked-task group + proposal-to-refine group).
 *   - When the queue is genuinely empty, a simple "nothing pressing" invitation
 *     is shown instead.
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

    expect(container.querySelector('[data-testid="seeded-feed"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="hero-headline"]')).toBeNull()
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

  it('does not show the queue-summary widget when the queue is empty', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    expect(container.querySelector('[data-testid="opening-next-moves"]')).toBeNull()
  })

  it('shows the queue-summary widget instead of plain text when items exist', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [makeItem({ title: 'Deploy job stuck' })],
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

    const openingEl = container.querySelector('[data-testid="mars-opening-message"]')
    expect(openingEl?.querySelector('[data-testid="opening-next-moves"]')).not.toBeNull()
  })

  it('shows accurate blocked-task count in the group header', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [
        makeItem({ id: 'b1', title: 'Task A' }),
        makeItem({ id: 'b2', title: 'Task B' }),
        makeItem({ id: 'b3', title: 'Task C' }),
      ],
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

    const header = container.querySelector('[data-testid="queue-group-header"]')
    expect(header?.textContent).toContain('3 blocked tasks')
  })

  it('shows a proposal-to-refine group when draft proposals exist', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [makeItem({ id: 'p1', kind: 'draft-proposal', title: 'New feature idea' })],
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

    const header = container.querySelector('[data-testid="queue-group-header"]')
    expect(header?.textContent).toContain('1 proposal to refine')
  })

  it('surfaces both blocked-task and proposal groups when both kinds exist', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [
        makeItem({ id: 'b1', kind: 'failed-task', title: 'Task failed' }),
        makeItem({ id: 'b2', kind: 'failed-task', title: 'Another task' }),
        makeItem({ id: 'p1', kind: 'draft-proposal', title: 'New idea' }),
      ],
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

    const headers = container.querySelectorAll('[data-testid="queue-group-header"]')
    expect(headers.length).toBe(2)

    const texts = Array.from(headers).map((h) => h.textContent ?? '')
    expect(texts.some((t) => t.includes('2 blocked tasks'))).toBe(true)
    expect(texts.some((t) => t.includes('1 proposal to refine'))).toBe(true)
  })

  it('lists every actionable item as a clickable chip', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [
        makeItem({ id: 'b1', title: 'Task A' }),
        makeItem({ id: 'b2', title: 'Task B' }),
      ],
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

    const chips = container.querySelectorAll('[data-testid="next-move-chip"]')
    expect(chips.length).toBe(2)
  })
})
