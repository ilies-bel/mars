// @vitest-environment happy-dom
/**
 * Seeded opening message tests for ChatPage.
 *
 * Verifies the queue-summary opening introduced when pending work exists:
 *   - There is no hero screen; the chat feed is present on first paint.
 *   - When the action queue has actionable items, a grouped queue summary is
 *     shown (blocked-task group + proposal-to-refine group).
 *   - When the queue is empty but tasks are blocked, the opening still shows
 *     the grouped summary (supplement from useTasks snapshot).
 *   - When genuinely nothing is pending, a simple "nothing pressing" invitation
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

// Controllable useTasks return value: start with null snapshot, override per-test.
const mockUseTasks = vi.fn()

vi.mock('@/hooks/useTasks', () => ({
  useTasks: () => mockUseTasks(),
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

/** Minimal UITask-like shape used to seed the useTasks mock snapshot. */
const makeUITask = (id: string, title: string, status = 'blocked') => ({
  id,
  title,
  status,
  role: 'orchestrator' as const,
  failed: false,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  spec: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const makeSnapshot = (inProgressTasks: ReturnType<typeof makeUITask>[]) => ({
  columns: {
    backlog: [],
    in_progress: inProgressTasks,
    done: [],
  },
  counts: { inProgress: inProgressTasks.length, todo: 0, done: 0 },
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  // Default: empty queue and no tasks
  mockUseActionQueue.mockReturnValue({
    items: [],
    error: null,
    projectsError: null,
    projectsEmpty: false,
  })
  mockUseTasks.mockReturnValue({ snapshot: null, error: null, connected: true })

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

  it('shows the nothing-pressing fallback when the queue is empty and no tasks are blocked', async () => {
    // mockUseActionQueue already returns empty items from beforeEach
    // mockUseTasks already returns null snapshot
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

  it('does not show the queue-summary widget when the queue is empty and no tasks are blocked', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    expect(container.querySelector('[data-testid="opening-next-moves"]')).toBeNull()
  })

  it('shows the queue-summary widget instead of plain text when queue items exist', async () => {
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

  it('shows accurate alert count in the group header for failed-task items', async () => {
    // failed-task items are alerts, NOT blocked tasks
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

    const headers = Array.from(container.querySelectorAll('[data-testid="queue-group-header"]'))
    const texts = headers.map((h) => h.textContent ?? '')
    // Three failed-task items → "3 alerts", NOT "3 blocked tasks"
    expect(texts.some((t) => t.includes('3 alerts'))).toBe(true)
    expect(texts.every((t) => !t.includes('blocked'))).toBe(true)
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

    const headers = Array.from(container.querySelectorAll('[data-testid="queue-group-header"]'))
    const texts = headers.map((h) => h.textContent ?? '')
    // draft-proposal is a proposal to refine — NOT an alert or blocked task
    expect(texts.some((t) => t.includes('1 proposal to refine'))).toBe(true)
    expect(texts.every((t) => !t.includes('alert'))).toBe(true)
    expect(texts.every((t) => !t.includes('blocked'))).toBe(true)
  })

  it('surfaces alerts and proposal groups, not "blocked tasks", for failed-task + draft-proposal', async () => {
    // failed-task is an alert; draft-proposal is a proposal. Neither is a "blocked task".
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
    // The two failed-task items are "alerts", NOT "blocked tasks"
    expect(texts.some((t) => t.includes('2 alerts'))).toBe(true)
    expect(texts.every((t) => !t.includes('blocked task'))).toBe(true)
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

  // ---------------------------------------------------------------------------
  // Task-data supplement: blocked tasks from useTasks()
  // ---------------------------------------------------------------------------

  it('shows the queue-summary widget when action queue is empty but tasks are blocked', async () => {
    // Queue is empty (from beforeEach), but tasks snapshot has a blocked task
    mockUseTasks.mockReturnValue({
      snapshot: makeSnapshot([makeUITask('t1', 'Deploy blocked by build')]),
      error: null,
      connected: true,
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
    // The nothing-pressing text must NOT appear
    expect(openingEl?.textContent).not.toContain("Nothing's pressing right now")
  })

  it('shows accurate blocked-task count for tasks from useTasks snapshot', async () => {
    mockUseTasks.mockReturnValue({
      snapshot: makeSnapshot([
        makeUITask('t1', 'Build failed'),
        makeUITask('t2', 'Deploy waiting'),
      ]),
      error: null,
      connected: true,
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    const header = container.querySelector('[data-testid="queue-group-header"]')
    expect(header?.textContent).toContain('2 blocked tasks')
  })

  it('does not duplicate a blocked task already represented in the action queue', async () => {
    // Queue has a failed-task item whose entityId matches the blocked task's id
    mockUseActionQueue.mockReturnValue({
      items: [makeItem({ id: 'q1', entityId: 't1', title: 'Build failed' })],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    mockUseTasks.mockReturnValue({
      snapshot: makeSnapshot([makeUITask('t1', 'Build failed')]),
      error: null,
      connected: true,
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    // Should show 1 chip (from the queue), not 2 (queue + task)
    const chips = container.querySelectorAll('[data-testid="next-move-chip"]')
    expect(chips.length).toBe(1)
  })

  it('combines queue items and supplemental blocked tasks in a single grouped summary', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [makeItem({ id: 'p1', kind: 'draft-proposal', title: 'New idea' })],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    mockUseTasks.mockReturnValue({
      snapshot: makeSnapshot([makeUITask('t1', 'Deploy blocked')]),
      error: null,
      connected: true,
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    const headers = container.querySelectorAll('[data-testid="queue-group-header"]')
    const texts = Array.from(headers).map((h) => h.textContent ?? '')
    expect(texts.some((t) => t.includes('1 blocked task'))).toBe(true)
    expect(texts.some((t) => t.includes('1 proposal to refine'))).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Eligibility: truthful grouping at the data-to-UI boundary
  // ---------------------------------------------------------------------------

  it('genuinely blocked task (from useTasks, status=blocked) reaches "blocked tasks" group, not "alerts"', async () => {
    // A task with status='blocked' in the DB is a BLOCKED TASK — not an alert.
    // It must reach the "blocked tasks" group in the opening, not be mislabelled.
    mockUseTasks.mockReturnValue({
      snapshot: makeSnapshot([makeUITask('t1', 'Deploy waiting on build')]),
      error: null,
      connected: true,
    })

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <ChatPage />
        </QueryClientProvider>,
      )
    })

    const headers = Array.from(container.querySelectorAll('[data-testid="queue-group-header"]'))
    const texts = headers.map((h) => h.textContent ?? '')
    expect(texts.some((t) => t.includes('blocked task'))).toBe(true)
    // Must NOT appear as an "alert"
    expect(texts.every((t) => !t.includes('alert'))).toBe(true)
  })

  it('draft proposal reaches "proposals to refine" group, not "alerts" or "blocked tasks"', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [makeItem({ id: 'p1', kind: 'draft-proposal', title: 'New capability idea' })],
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

    const headers = Array.from(container.querySelectorAll('[data-testid="queue-group-header"]'))
    const texts = headers.map((h) => h.textContent ?? '')
    expect(texts.some((t) => t.includes('proposal to refine'))).toBe(true)
    expect(texts.every((t) => !t.includes('alert'))).toBe(true)
    expect(texts.every((t) => !t.includes('blocked'))).toBe(true)
  })

  it('non-blocked alert kinds (failed-task, stale-worktree, arc-failed) reach "alerts" group, not "blocked tasks"', async () => {
    // These are distinct failure kinds — the operator must not be told they are
    // "blocked tasks" (which implies waiting on a dependency, not a failure).
    mockUseActionQueue.mockReturnValue({
      items: [
        makeItem({ id: 'f1', kind: 'failed-task', title: 'Coder timed out' }),
        makeItem({ id: 's1', kind: 'stale-worktree', title: 'Stale worktree: task-xyz' }),
        makeItem({ id: 'a1', kind: 'arc-failed', title: 'Arc failed' }),
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

    const headers = Array.from(container.querySelectorAll('[data-testid="queue-group-header"]'))
    const texts = headers.map((h) => h.textContent ?? '')
    expect(texts.some((t) => t.includes('3 alerts'))).toBe(true)
    // Must NOT be labelled as "blocked tasks"
    expect(texts.every((t) => !t.includes('blocked task'))).toBe(true)
  })
})
