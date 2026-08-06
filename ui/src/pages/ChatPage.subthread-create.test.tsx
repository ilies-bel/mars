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

const { createSubthreadAndSend } = vi.hoisted(() => ({ createSubthreadAndSend: vi.fn() }))
const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: [], error: null, projectsError: null, projectsEmpty: false }),
}))
vi.mock('@/entities/actionQueue/useActionQueueHistory', () => ({
  useActionQueueHistory: () => ({ items: [], nextCursor: null, isLoadingMore: false, loadMore: vi.fn(), error: null, projectsError: null, projectsEmpty: false }),
}))
vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  useFocusedProject: () => ({ focusedProjectId: null, projectsSettled: true, projectsError: null, projects: [], setFocusedProjectId: vi.fn() }),
}))
vi.mock('@/hooks/useTasks', () => ({ useTasks: () => ({ snapshot: null, error: null, connected: true }) }))
vi.mock('@/shared/useMarsChat', () => ({
  useMarsChat: () => ({
    messages: [], status: 'ready', sendMessage, stop: vi.fn(), error: undefined,
    setMessages: vi.fn(), resumeStream: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('@/shared/api', () => ({
  fetchChatThreads: vi.fn().mockResolvedValue([]), fetchChatThread: vi.fn().mockResolvedValue(null),
  fetchChatConversation: vi.fn().mockResolvedValue({ entries: [], boundaries: [], memoryStartsAfterSeq: 0, memoryCutAt: null, memoryCutReason: null }), fetchChatHistory: vi.fn().mockResolvedValue([]),
  fetchCodexAuthState: vi.fn().mockResolvedValue(null), refreshCodexAuth: vi.fn().mockResolvedValue(null),
  fetchProjectMeta: vi.fn().mockResolvedValue({ vision: null, theme: null }), fetchGlossary: vi.fn().mockResolvedValue([]),
  createChatThread: vi.fn(), createSubthreadAndSend, postChatMessage: vi.fn(), uploadAttachment: vi.fn(),
  renameChatThread: vi.fn(), setMessageFeedback: vi.fn(), clearMessageFeedback: vi.fn(), invokeAction: vi.fn(),
  ApiError: class ApiError extends Error { kind = 'other' },
}))

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  createSubthreadAndSend.mockReset()
  sendMessage.mockClear()
  createSubthreadAndSend.mockResolvedValue({ id: 'subthread-1', title: '', status: 'running', attentionStatus: 'generating', createdAt: '', updatedAt: '', origin: null, alertItemId: null, alertResolved: false, parentThreadId: null })
  window.location.hash = '#/chat'
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('ChatPage Subthread boundary composer', () => {
  it('starts and activates one inline Subthread without changing the chat URL', async () => {
    await act(async () => {
      root.render(<QueryClientProvider client={qc()}><ChatPage /></QueryClientProvider>)
    })
    const input = container.querySelector('[data-testid="hero-composer"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Review the deployment')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      (container.querySelector('[data-testid="hero-send"]') as HTMLButtonElement).click()
    })
    await vi.waitFor(() => expect(createSubthreadAndSend).toHaveBeenCalledWith('Review the deployment', undefined))
    expect(container.querySelector('[data-testid="active-subthread"]')?.getAttribute('data-thread-id')).toBe('subthread-1')
    expect(window.location.hash).toBe('#/chat')
  })

  it('keeps the drafted text when starting a Subthread fails', async () => {
    createSubthreadAndSend.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      root.render(<QueryClientProvider client={qc()}><ChatPage /></QueryClientProvider>)
    })
    const input = container.querySelector('[data-testid="hero-composer"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Keep this draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      ;(container.querySelector('[data-testid="hero-send"]') as HTMLButtonElement).click()
    })
    await vi.waitFor(() => expect(container.querySelector('[data-testid="hero-send-error"]')).not.toBeNull())
    expect((container.querySelector('[data-testid="hero-composer"]') as HTMLTextAreaElement).value).toBe('Keep this draft')
    expect(container.querySelector('[data-testid="active-subthread"]')).toBeNull()
  })

  it('sends the next message to the active Subthread instead of creating another one', async () => {
    await act(async () => {
      root.render(<QueryClientProvider client={qc()}><ChatPage /></QueryClientProvider>)
    })
    const hero = container.querySelector('[data-testid="hero-composer"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(hero, 'Start here')
      hero.dispatchEvent(new Event('input', { bubbles: true }))
      hero.dispatchEvent(new Event('change', { bubbles: true }))
      ;(container.querySelector('[data-testid="hero-send"]') as HTMLButtonElement).click()
    })
    await vi.waitFor(() => expect(container.querySelector('[data-testid="active-subthread"]')).not.toBeNull())

    // The composer is portaled into the dock outside the scroll container, so
    // query it from the composer-dock rather than from inside active-subthread.
    const activeComposer = container.querySelector('[data-testid="composer-dock"] textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(activeComposer, 'Continue here')
      activeComposer.dispatchEvent(new Event('input', { bubbles: true }))
      activeComposer.dispatchEvent(new Event('change', { bubbles: true }))
      ;(container.querySelector('[data-testid="composer-dock"] [data-testid="send-btn"]') as HTMLButtonElement).click()
    })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ text: 'Continue here' }, undefined))
    expect(createSubthreadAndSend).toHaveBeenCalledTimes(1)
  })
})
