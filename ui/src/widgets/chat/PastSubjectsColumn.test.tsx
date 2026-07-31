// @vitest-environment happy-dom

import { describe, expect, it } from 'bun:test'
import { vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PastSubjectsColumn, type ThreadSummary } from './PastSubjectsColumn'

const mockFetchChatThread = vi.hoisted(() => vi.fn())

vi.mock('@/shared/api', () => ({
  fetchChatThread: (...args: unknown[]) => mockFetchChatThread(...args),
}))

describe('PastSubjectsColumn', () => {
  it('renders past Subjects oldest-first', () => {
    const pastThreads: ThreadSummary[] = [
      { id: 'subject-early', title: 'Earlier subject', createdAt: '2026-07-31T08:00:00.000Z' },
      { id: 'subject-late', title: 'Later subject', createdAt: '2026-07-31T09:00:00.000Z' },
    ]

    const html = renderToStaticMarkup(<PastSubjectsColumn pastThreads={pastThreads} />)

    expect(html).toContain('Earlier subject')
    expect(html).toContain('Later subject')
    expect(html.indexOf('Earlier subject')).toBeLessThan(html.indexOf('Later subject'))
  })

  it('loads a past Subject’s messages only after it is expanded', async () => {
    mockFetchChatThread.mockResolvedValue({
      thread: { id: 'subject-early' },
      messages: [{
        id: 'message-1',
        threadId: 'subject-early',
        role: 'assistant',
        createdAt: '2026-07-31T08:01:00.000Z',
        feedback: null,
        segments: [{ type: 'text', text: 'Mars kept this context.' }],
      }],
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    await act(async () => {
      root.render(createElement(
        QueryClientProvider,
        { client },
        createElement(PastSubjectsColumn, {
          pastThreads: [{ id: 'subject-early', title: 'Earlier subject', createdAt: '2026-07-31T08:00:00.000Z' }],
        }),
      ))
    })

    expect(mockFetchChatThread).not.toHaveBeenCalled()

    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mockFetchChatThread).toHaveBeenCalledWith('subject-early', undefined)
    expect(container.textContent).toContain('Mars kept this context.')
    await act(async () => root.unmount())
  })
})
