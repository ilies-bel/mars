import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

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
import { ConversationTimeline } from '@/widgets/chat/ConversationTimeline'

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

describe('ChatPage main thread', () => {
  it('opens on the main thread: Mars briefing plus the conversation timeline', () => {
    const html = renderPage()

    expect(html).toContain('data-testid="mars-opening-message"')
    expect(html).toContain('data-testid="chat-greeting"')
    expect(html).toContain('aria-label="Conversation timeline"')
  })

  it('offers no layout switch — the Subject rail presentation is the only one', () => {
    const html = renderPage()

    expect(html).not.toContain('aria-label="Chat layout"')
    expect(html).not.toContain('data-testid="chat-layout-focus"')
    expect(html).not.toContain('data-testid="chat-layout-threads"')
    expect(html).not.toContain('Select a Subject from the list')
  })

  it('the timeline includes a composer scroll spacer so the last entry is never hidden behind the hero composer', () => {
    const html = renderPage()

    // The spacer must be inside the conversation timeline, after the entries.
    expect(html).toContain('data-testid="composer-scroll-spacer"')
    // Both the timeline and the spacer appear in the same render — the spacer
    // is inside the <section> that wraps the timeline entries.
    const timelineIdx = html.indexOf('aria-label="Conversation timeline"')
    const spacerIdx = html.indexOf('data-testid="composer-scroll-spacer"')
    expect(timelineIdx).toBeGreaterThan(-1)
    expect(spacerIdx).toBeGreaterThan(timelineIdx)
  })
})

describe('ConversationTimeline composer spacer', () => {
  it('renders a zero-height spacer by default so the element is always reachable in the DOM', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationTimeline, { entries: [] }),
    )
    expect(html).toContain('data-testid="composer-scroll-spacer"')
  })

  it('reflects an explicit composerHeight so a growing multi-line draft extends the spacer', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationTimeline, { entries: [], composerHeight: 180 }),
    )
    // The inline style height must match the measured composer height.
    expect(html).toContain('height:180px')
    expect(html).toContain('data-testid="composer-scroll-spacer"')
  })
})
