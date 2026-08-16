// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPage } from './ChatPage'
import type { ActionQueueItem } from '@/shared/schemas'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('1280') ? true : true,
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
const mockUseStatusCounts = vi.hoisted(() => vi.fn())
const createChatThread = vi.hoisted(() => vi.fn())
const startThreadFromAlert = vi.hoisted(() => vi.fn())

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

vi.mock('@/entities/alerts/api', () => ({ startThreadFromAlert }))
vi.mock('@/hooks/useTasks', () => ({ useTasks: () => mockUseTasks() }))
vi.mock('@/hooks/useStatusCounts', () => ({ useStatusCounts: () => mockUseStatusCounts() }))

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

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  window.location.hash = '#/chat'
  createChatThread.mockResolvedValue({ id: 'subject-1' })
  mockUseActionQueue.mockReturnValue({ items: [], error: null, projectsError: null, projectsEmpty: false })
  mockUseTasks.mockReturnValue({ snapshot: null, error: null, connected: true })
  mockUseProposals.mockReturnValue({ proposals: [], isPending: false, error: null, connected: true })
  mockUseStatusCounts.mockReturnValue({ running: 0, recovering: 0, needYou: 0, failed: 0, doneToday: 0 })
  startThreadFromAlert.mockResolvedValue({ threadId: 'alert-subject-1' })
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
  it('shows the seeded feed and the all-quiet greeting when no open work exists', async () => {
    await renderPage()

    expect(container.querySelector('[data-testid="seeded-feed"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="hero-headline"]')).toBeNull()
    expect(container.querySelector('[data-testid="mars-opening-message"]')?.textContent).toContain('All quiet.')
    expect(container.querySelector('[data-testid="chat-greeting"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preloaded-responses"]')).toBeNull()
  })

  it('shows aggregate "N need you" count and Open-the-board link without naming individual alerts', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [alert('normal', 'Later alert', 'normal'), alert('urgent', 'Repair deployment', 'high')],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    mockUseStatusCounts.mockReturnValue({ running: 0, recovering: 0, needYou: 2, failed: 0, doneToday: 0 })

    await renderPage()

    const opening = container.querySelector('[data-testid="mars-opening-message"]')
    expect(opening?.textContent).toContain('2 need you')
    expect(opening?.textContent).not.toContain('Start with')
    expect(opening?.textContent).not.toContain('After that')
    expect(opening?.textContent).not.toContain('Repair deployment')
    expect(opening?.textContent).not.toContain('Later alert')
    // The board link is present; no per-alert buttons.
    const link = opening?.querySelector('[data-testid="chat-greeting-board-link"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('#/progress')
    expect(link?.textContent).toBe('Open the board')
  })

  it('keeps open alerts out of the seeded feed', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [{ ...alert('alert-1', 'Repair deployment', 'high'), kind: 'arc-failed' }],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    await renderPage()

    const feed = container.querySelector('[data-testid="seeded-feed"]')
    expect(feed?.querySelector('[data-testid="main-thread-alerts"]')).toBeNull()
    expect(feed?.querySelector('[data-testid="main-thread-alert"]')).toBeNull()
    expect(feed?.querySelector('[data-testid="alert-event-timeline"]')).toBeNull()
  })

  it('opens an alert Subject from its context-rail row (panel must be opened first)', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [{ ...alert('alert-1', 'Repair deployment', 'high'), kind: 'arc-failed' }],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    await renderPage()

    // The context panel is closed by default — open it via the toggle.
    await act(async () => {
      const toggle = container.querySelector('[data-testid="context-panel-toggle"]') as HTMLButtonElement
      expect(toggle).not.toBeNull()
      toggle.click()
    })

    // Now the alert row is visible; click it to open its Subject.
    await act(async () => {
      (container.querySelector('[data-testid="context-rail-alert-row"]') as HTMLButtonElement).click()
    })

    expect(startThreadFromAlert).toHaveBeenCalledWith('alert-1')
    expect(container.querySelector('[data-testid="active-subthread"]')?.getAttribute('data-thread-id'))
      .toBe('alert-subject-1')
  })

  it('shows the Open-the-board link when there is an alert needing attention', async () => {
    mockUseActionQueue.mockReturnValue({
      items: [alert('urgent', 'Repair deployment', 'high')],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
    mockUseStatusCounts.mockReturnValue({ running: 0, recovering: 0, needYou: 1, failed: 0, doneToday: 0 })
    await renderPage()

    const link = container.querySelector('[data-testid="chat-greeting-board-link"]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('#/progress')
    expect(container.querySelector('[data-testid="chat-greeting"]')?.textContent).toContain('1 need you')
  })
})
