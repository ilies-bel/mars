import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const layout = vi.hoisted(() => ({ value: 'focus' as 'focus' | 'threads' }))

vi.mock('@/entities/chat-layout/api', () => ({
  useChatLayoutPreference: () => ({
    layout: layout.value,
    setLayout: vi.fn(),
    isPending: false,
  }),
}))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: [] }),
}))

vi.mock('@/entities/actionQueue/useActionQueueHistory', () => ({
  useActionQueueHistory: () => ({ items: [] }),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  useFocusedProject: () => ({ projects: [], setFocusedProjectId: vi.fn() }),
}))

vi.mock('@/shared/api', () => ({
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatConversation: vi.fn().mockResolvedValue({ entries: [], boundaries: [], memoryStartsAfterSeq: 0, memoryCutAt: null, memoryCutReason: null }),
  fetchChatThread: vi.fn().mockResolvedValue(null),
  fetchCodexAuthState: vi.fn().mockResolvedValue(null),
  fetchProjectMeta: vi.fn().mockResolvedValue({ vision: null, theme: null }),
  fetchGlossary: vi.fn().mockResolvedValue([]),
  createChatThread: vi.fn(),
  createSubjectAndSend: vi.fn(),
  endChatSubject: vi.fn(),
  uploadAttachment: vi.fn(),
  renameChatThread: vi.fn(),
  setMessageFeedback: vi.fn(),
  clearMessageFeedback: vi.fn(),
  refreshCodexAuth: vi.fn(),
  invokeAction: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

import { ChatPage } from './ChatPage'

const renderPage = (): string => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['chat-threads', undefined], [])
  queryClient.setQueryData(['chat-conversation', undefined], {
    entries: [], boundaries: [], memoryStartsAfterSeq: 0, memoryCutAt: null, memoryCutReason: null,
  })
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(ChatPage)),
  )
}

describe('ChatPage layout preference', () => {
  it('shows the continuous conversation timeline by default', () => {
    layout.value = 'focus'
    const html = renderPage()

    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Conversation timeline"')
    expect(html).not.toContain('Select a Subject from the list')
  })

  it('shows the thread rail presentation without rendering the continuous timeline', () => {
    layout.value = 'threads'
    const html = renderPage()

    expect(html).toContain('data-testid="threads-empty-state"')
    expect(html).toContain('data-testid="empty-rail"')
    expect(html).not.toContain('aria-label="Conversation timeline"')
  })
})
