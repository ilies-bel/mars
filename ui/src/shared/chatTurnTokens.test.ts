import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageView } from '@/pages/ChatPage'
import { chatMessageToUIMessage } from './chatMessageMapping'
import { chatMessageSchema } from './schemas'

describe('chat turn tokens', () => {
  it('renders a visible zero-token footer for a persisted operator message', () => {
    const message = chatMessageSchema.parse({
      id: 'user-1',
      threadId: 'thread-1',
      role: 'user',
      segments: [{ type: 'text', text: 'show me the queue' }],
      createdAt: '2026-08-01T00:00:00.000Z',
      feedback: null,
      turnTokens: 0,
    })

    const html = renderToStaticMarkup(
      createElement(MessageView, { message: chatMessageToUIMessage(message), onRetry: () => undefined }),
    )

    expect(html).toContain('0 tokens')
  })

  it('renders the persisted turn total instead of a result segment usage value', () => {
    const message = chatMessageSchema.parse({
      id: 'assistant-1',
      threadId: 'thread-1',
      role: 'assistant',
      segments: [{ type: 'result', durationMs: null, inputTokens: 999, outputTokens: 1, cacheReadTokens: null, cost: null }],
      createdAt: '2026-08-01T00:00:00.000Z',
      feedback: null,
      turnTokens: 20,
    })

    const html = renderToStaticMarkup(
      createElement(MessageView, { message: chatMessageToUIMessage(message), onRetry: () => undefined }),
    )

    expect(html).toContain('20 tokens')
    expect(html).not.toContain('1000 tokens')
  })

  it('formats large turn token counts with locale separators', () => {
    const message = chatMessageSchema.parse({
      id: 'assistant-2',
      threadId: 'thread-1',
      role: 'assistant',
      segments: [{ type: 'result', durationMs: null, inputTokens: 200000, outputTokens: 40000, cacheReadTokens: null, cost: null }],
      createdAt: '2026-08-01T00:00:00.000Z',
      feedback: null,
      turnTokens: 241281,
    })

    const html = renderToStaticMarkup(
      createElement(MessageView, { message: chatMessageToUIMessage(message), onRetry: () => undefined }),
    )

    // The footer must use toLocaleString()-style formatting, not a bare integer
    const formatted = (241281).toLocaleString()
    expect(html).toContain(`${formatted} tokens`)
    // Raw unformatted form should be absent when the locale adds a separator
    if (formatted !== '241281') {
      expect(html).not.toContain('241281 tokens')
    }
  })
})
