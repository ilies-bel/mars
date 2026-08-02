// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPage } from './ChatPage'
import type { ActionQueueItem, DraftFeature } from '@/shared/schemas'

let largeScreen = true

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('1280') ? largeScreen : true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

const mockUseActionQueue = vi.hoisted(() => vi.fn())
const mockUseTasks = vi.hoisted(() => vi.fn())
const mockUseProposals = vi.hoisted(() => vi.fn())
const createChatThread = vi.hoisted(() => vi.fn())

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => mockUseActionQueue(),
}))

vi.mock('@/entities/actionQueue/useActionQueueHistory', () => ({
  useActionQueueHistory: () => ({ items: [], nextCursor: null, isLoadingMore: false, loadMore: vi.fn(), error: null, projectsError: null, projectsEmpty: false }),
}))

vi.mock('@/entities/proposals/useProposals', () => ({
  useProposals: () => mockUseProposals(),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  useFocusedProject: () => ({ focusedProjectId: null, projectsSettled: true, projectsError: null, projects: [], setFocusedProjectId: vi.fn() }),
}))

vi.mock('@/shared/api', () => ({
  fetchChatLayoutPreference: vi.fn().mockResolvedValue({ layout: 'focus' }),
  putChatLayoutPreference: vi.fn().mockResolvedValue({ layout: 'focus' }),
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatConversation: vi.fn().mockResolvedValue({ entries: [], boundaries: [], memoryStartsAfterSeq: 0, memoryCutAt: null, memoryCutReason: null }),
  fetchChatThread: vi.fn().mockResolvedValue(null),
  createChatThread,
  createSubthreadAndSend: vi.fn(),
  endChatSubthread: vi.fn(),
  uploadAttachment: vi.fn(),
  renameChatThread: vi.fn(),
  setMessageFeedback: vi.fn(),
  clearMessageFeedback: vi.fn(),
  fetchCodexAuthState: vi.fn().mockResolvedValue(null),
  refreshCodexAuth: vi.fn(),
  fetchProjectMeta: vi.fn().mockResolvedValue({ vision: null, theme: null }),
  fetchGlossary: vi.fn().mockResolvedValue([]),
  fetchAdrs: vi.fn().mockResolvedValue([]),
  fetchTasksForThread: vi.fn().mockResolvedValue([]),
  invokeAction: vi.fn(),
  ApiError: class ApiError extends Error { kind = 'unknown' },
}))

vi.mock('@/entities/alerts/api', () => ({ startThreadFromAlert: vi.fn() }))
vi.mock('@/entities/alerts', () => ({ useAlerts: () => ({ alerts: [] }) }))
vi.mock('@/hooks/useTasks', () => ({ useTasks: () => mockUseTasks() }))

const makeQc = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

const alert = (id: string, title: string, priority: ActionQueueItem['priority']): ActionQueueItem => ({
  id,
  kind: 'failed-task',
  entityId: id,
  priority,
  title,
  body: '',
  at: '2026-01-01T00:00:00.000Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
  resolution: null,
  humanSummary: '',
  verbs: [],
  decisions: [],
})

const blockedTask = (id: string, title: string) => ({
  id,
  title,
  status: 'blocked',
  role: 'orchestrator' as const,
  failed: false,
  dropReason: null,
  retryCount: 0,
  priority: 2,
  blockerTaskId: null,
  spec: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const proposal = (id: string): DraftFeature => ({
  id,
  title: `Proposal ${id}`,
  problem: '',
  solution: '',
  status: 'draft',
  source: 'human',
  createdAt: 1,
  updatedAt: 1,
  acceptanceCount: 0,
  userStories: [],
})

const snapshot = (tasks: ReturnType<typeof blockedTask>[]) => ({
  columns: { backlog: [], in_progress: tasks, done: [] },
  counts: { inProgress: tasks.length, todo: 0, done: 0 },
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  largeScreen = true
  window.location.hash = '#/chat'
  createChatThread.mockResolvedValue({ id: 'subject-1' })
  mockUseActionQueue.mockReturnValue({ items: [], error: null, projectsError: null, projectsEmpty: false })
  mockUseTasks.mockReturnValue({ snapshot: null, error: null, connected: true })
  mockUseProposals.mockReturnValue({ proposals: [], isPending: false, error: null, connected: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const renderPage = async () => {
  await act(async () => {
    root.render(<QueryClientProvider client={makeQc()}><ChatPage /></QueryClientProvider>)
  })
}

describe('ChatPage opening greeting', () => {
  it('shows the seeded feed and terse all-clear fallback when no open work or drafts exist', async () => {
    await renderPage()

    expect(container.querySelector('[data-testid="seeded-feed"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="hero-headline"]')).toBeNull()
    expect(container.querySelector('[data-testid="mars-opening-message"]')?.textContent).toContain('All clear.')
    expect(container.querySelector('[data-testid="chat-greeting"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preloaded-responses"]')).toBeNull()
  })

  it('opens a Subject for one supplied draft from the all-clear Grill response', async () => {
    const drafts = [proposal('1'), proposal('2')]
    mockUseProposals.mockReturnValue({ proposals: drafts, isPending: false, error: null, connected: true })
    await renderPage()

    await act(async () => (container.querySelector('[data-testid^="preloaded-response-"]') as HTMLButtonElement).click())

    expect(createChatThread).toHaveBeenCalledTimes(1)
    const request = createChatThread.mock.calls[0]?.[0]
    expect(drafts.map(({ title }) => `Grill: ${title}`)).toContain(request.title)
    expect(drafts.map(({ id }) => `Grill proposal ${id}`)).toContain(request.objective)
    expect(request.origin).toBe('proposal')
  })

  it('names only the first item from the rail ranking and keeps all inventories in the context rail', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [alert('normal', 'Later alert', 'normal'), alert('urgent', 'Repair deployment', 'high')],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    mockUseProposals.mockReturnValue({ proposals: [proposal('1')], isPending: false, error: null, connected: true })

    await renderPage()

    const opening = container.querySelector('[data-testid="mars-opening-message"]')
    expect(opening?.textContent).toContain('Repair deployment')
    expect(opening?.textContent).not.toContain('Later alert')
    expect(opening?.textContent).toContain('2 more open items')
    expect(opening?.querySelector('[data-testid="opening-next-moves"]')).toBeNull()
    expect(opening?.querySelector('[data-testid="queue-group-header"]')).toBeNull()
    expect(opening?.querySelectorAll('button')).toHaveLength(2)
  })

  it('opens the named alert through the existing Subject handler', async () => {
    mockUseActionQueue.mockReturnValue({ items: [alert('urgent', 'Repair deployment', 'high')], error: null, projectsError: null, projectsEmpty: false })
    await renderPage()

    await act(async () => (container.querySelector('[data-testid="chat-greeting-next-move"]') as HTMLButtonElement).click())
    expect(createChatThread).toHaveBeenCalledWith({ projectId: undefined })
  })

  it('opens the named blocked task in task detail', async () => {
    mockUseTasks.mockReturnValue({ snapshot: snapshot([blockedTask('task-1', 'Release is blocked')]), error: null, connected: true })
    await renderPage()

    await act(async () => (container.querySelector('[data-testid="chat-greeting-next-move"]') as HTMLButtonElement).click())
    expect(window.location.hash).toBe('#/task/task-1?from=chat')
  })

  it('expands and focuses the context rail when the remaining count is activated', async () => {
    largeScreen = false
    mockUseActionQueue.mockReturnValue({ items: [alert('urgent', 'Repair deployment', 'high'), alert('normal', 'Later alert', 'normal')], error: null, projectsError: null, projectsEmpty: false })
    await renderPage()

    expect(container.querySelector('[aria-label="Context rail (collapsed)"]')).not.toBeNull()
    await act(async () => (container.querySelector('[data-testid="chat-greeting-remaining"]') as HTMLButtonElement).click())
    const openWork = container.querySelector('[data-testid="context-rail-open-work"]')
    expect(container.querySelector('[aria-label="Context rail"]')).not.toBeNull()
    expect(document.activeElement).toBe(openWork)
  })
})
