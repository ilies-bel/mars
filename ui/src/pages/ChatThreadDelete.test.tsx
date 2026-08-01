// @vitest-environment happy-dom
/** The thread list preserves every Subthread once it has entered the conversation. */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThreadSidebar } from './ChatPage'

vi.mock('@/shared/api', () => ({
  fetchActionQueue: vi.fn().mockResolvedValue([]),
  fetchChatThreads: vi.fn().mockResolvedValue([{
    id: 't1', title: 'First subthread', status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    origin: null, alertItemId: null, alertResolved: false,
  }]),
  fetchChatHistory: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue({ thread: null, messages: [] }),
  createChatThread: vi.fn(),
  postChatMessage: vi.fn(),
  renameChatThread: vi.fn(),
  stopChatThread: vi.fn(),
  invokeAction: vi.fn(),
}))

describe('thread list', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('does not offer a way to delete a Subthread', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadSidebar
            selectedId={null}
            onSelect={() => {}}
            filters={{ query: '', kind: 'all', origin: 'all' }}
            onFiltersChange={() => {}}
            selectedItem={null}
            onFastAction={() => {}}
          />
        </QueryClientProvider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    for (let i = 0; i < 20 && !container.textContent?.includes('First subthread'); i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    }

    expect(container.textContent).toContain('First subthread')
    expect(container.querySelector('[aria-label="Delete thread"]')).toBeNull()
    expect(container.textContent).not.toMatch(/delete subthread|delete thread/i)
  })
})
