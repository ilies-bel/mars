// @vitest-environment happy-dom
/**
 * The thread rail lets an operator delete a Subthread.
 *
 * It used to refuse: threads were preserved forever, so the rail grew one row
 * per alert, grill and stray question and the only relief was a 7-day
 * auto-archive into a collapsed block that also only grew. Deleting is
 * irreversible, so the control arms on first click and deletes on the second.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThreadSidebar } from './ChatPage'

const { mockDeleteChatThread } = vi.hoisted(() => ({
  mockDeleteChatThread: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/shared/api', () => ({
  fetchActionQueue: vi.fn().mockResolvedValue([]),
  fetchChatThreads: vi.fn().mockResolvedValue([{
    id: 't1', title: 'First subthread', status: 'idle',
    // Recent createdAt so the thread is NOT archived (< 7-day threshold).
    createdAt: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
    origin: null, alertItemId: null, alertResolved: false,
  }]),
  fetchChatHistory: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue({ thread: null, messages: [] }),
  createChatThread: vi.fn(),
  postChatMessage: vi.fn(),
  renameChatThread: vi.fn(),
  deleteChatThread: mockDeleteChatThread,
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

  it('offers a delete control that takes two clicks to fire', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThreadSidebar
            selectedId={null}
            onSelect={() => {}}
            filters={{ query: '', origin: 'all' }}
            onFiltersChange={() => {}}
            selectedItem={null}
            onFastAction={() => {}}
            onSelectMainThread={() => {}}
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

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="thread-delete"]')
    expect(trigger).not.toBeNull()

    // First click only arms it — nothing is deleted yet.
    await act(async () => { trigger!.click() })
    expect(mockDeleteChatThread).not.toHaveBeenCalled()

    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="thread-delete-confirm"]')
    expect(confirm).not.toBeNull()

    await act(async () => { confirm!.click() })
    expect(mockDeleteChatThread).toHaveBeenCalledWith('t1', undefined)
  })
})
