// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatPage } from './ChatPage'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }),
})
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createSubjectAndSend, fetchChatThread } = vi.hoisted(() => ({
  createSubjectAndSend: vi.fn(),
  fetchChatThread: vi.fn(),
}))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: [], error: null, projectsError: null, projectsEmpty: false }),
}))
vi.mock('@/entities/actionQueue/useActionQueueHistory', () => ({
  useActionQueueHistory: () => ({ items: [], nextCursor: null, isLoadingMore: false, loadMore: vi.fn(), error: null, projectsError: null, projectsEmpty: false }),
}))
vi.mock('@/entities/notices', () => ({ useNotices: () => ({ notices: [], error: null, ack: vi.fn(), isPending: false }) }))
vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  useFocusedProject: () => ({ focusedProjectId: null, projectsSettled: true, projectsError: null, projects: [], setFocusedProjectId: vi.fn() }),
}))
vi.mock('@/hooks/useTasks', () => ({ useTasks: () => ({ snapshot: null, error: null, connected: true }) }))
vi.mock('@/shared/useMarsChat', () => ({
  useMarsChat: () => ({
    messages: [], status: 'ready', sendMessage: vi.fn(), stop: vi.fn(), error: undefined,
    setMessages: vi.fn(), resumeStream: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('@/shared/api', () => ({
  fetchChatThreads: vi.fn().mockResolvedValue([]), fetchChatThread,
  fetchChatConversation: vi.fn().mockResolvedValue({ entries: [], memoryStartsAfterSeq: 0, memoryCutAt: null, memoryCutReason: null }), fetchChatHistory: vi.fn().mockResolvedValue([]),
  fetchCodexAuthState: vi.fn().mockResolvedValue(null), refreshCodexAuth: vi.fn().mockResolvedValue(null),
  fetchProjectMeta: vi.fn().mockResolvedValue({ vision: null, theme: null }), fetchGlossary: vi.fn().mockResolvedValue([]),
  createChatThread: vi.fn(), createSubjectAndSend, endChatSubject: vi.fn(), postChatMessage: vi.fn(), uploadAttachment: vi.fn(),
  renameChatThread: vi.fn(), setMessageFeedback: vi.fn(), clearMessageFeedback: vi.fn(), invokeAction: vi.fn(),
  ApiError: class ApiError extends Error { kind = 'other' },
}))

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  createSubjectAndSend.mockReset()
  fetchChatThread.mockReset()
  createSubjectAndSend.mockResolvedValue({ id: 'subject-1', title: '', status: 'idle', attentionStatus: 'idle', createdAt: '', updatedAt: '', origin: null, alertItemId: null, alertResolved: false, closedAt: null, terminalEventType: null, parentThreadId: null })
  fetchChatThread.mockResolvedValue({
    thread: { id: 'subject-1', title: '', status: 'idle', attentionStatus: 'idle', createdAt: '', updatedAt: '', origin: null, alertItemId: null, alertResolved: false, closedAt: '2026-08-01T00:00:00.000Z', terminalEventType: null, parentThreadId: null },
    messages: [],
  })
  window.location.hash = '#/chat'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('ChatPage Subject closure', () => {
  it('returns an automatically closed active Subject to the boundary composer', async () => {
    await act(async () => {
      root.render(<QueryClientProvider client={qc()}><ChatPage /></QueryClientProvider>)
    })
    const input = container.querySelector('[data-testid="hero-composer"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Finish this Subject')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      ;(container.querySelector('[data-testid="hero-send"]') as HTMLButtonElement).click()
    })

    await vi.waitFor(() => expect(fetchChatThread).toHaveBeenCalledWith('subject-1', undefined))
    await vi.waitFor(() => expect(container.querySelector('[data-testid="active-subject"]')).toBeNull())
    expect(container.querySelector('[data-testid="hero-composer"]')).not.toBeNull()
  })
})
