// @vitest-environment happy-dom
/**
 * DOM interaction tests for thread deletion in ThreadSidebar.
 *
 * Deleting a thread is a one-click gesture: the row disappears immediately and
 * a toast offers Undo. Nothing is sent to the server until the undo window
 * closes, so the covered behaviours are:
 *
 *   1. no confirmation step exists at all;
 *   2. the ✕ hides the row right away but does NOT call deleteChatThread yet;
 *   3. once the window elapses, deleteChatThread fires exactly once;
 *   4. Undo restores the row and never calls deleteChatThread;
 *   5. deleting a second thread commits the first rather than dropping it;
 *   6. a rejected delete puts the row back and surfaces the error.
 *
 * Timers are faked so the 5 s window does not make the suite slow.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ThreadSidebar } from './ChatPage'
import * as api from '@/shared/api'

const thread = (id: string, title: string) => ({
  id,
  title,
  status: 'idle' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  origin: null,
  alertItemId: null,
  alertResolved: false,
})

const THREADS = [thread('t1', 'First thread'), thread('t2', 'Second thread')]

// The factory is hoisted above every top-level binding, so it must not close
// over the helpers above — everything it returns is constructed inline.
vi.mock('@/shared/api', () => ({
  fetchActionQueue: vi.fn().mockResolvedValue([]),
  fetchChatThreads: vi.fn(),
  fetchChatThread: vi.fn().mockResolvedValue({ thread: null, messages: [] }),
  createChatThread: vi.fn().mockResolvedValue({
    id: 'new',
    title: 'New',
    status: 'idle',
    createdAt: '',
    updatedAt: '',
    origin: null,
    alertItemId: null,
    alertResolved: false,
  }),
  postChatMessage: vi.fn().mockResolvedValue(undefined),
  renameChatThread: vi.fn().mockResolvedValue(undefined),
  deleteChatThread: vi.fn().mockResolvedValue(undefined),
  stopChatThread: vi.fn().mockResolvedValue(undefined),
  invokeAction: vi.fn().mockResolvedValue(undefined),
}))

const mockedApi = vi.mocked(api)

let container: HTMLDivElement
let root: Root

/** Mount the sidebar and wait for the thread query to settle. */
const mount = async (onSelect: (id: string) => void = () => {}, selectedId: string | null = null) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <ThreadSidebar selectedId={selectedId} projectId={undefined} onSelect={onSelect} />
      </QueryClientProvider>,
    )
  })
  // react-query resolves the fetch across several microtask/timer turns; keep
  // flushing until the rows land rather than guessing a single tick.
  for (let i = 0; i < 20 && container.querySelectorAll('button').length <= 1; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
  }
}

/** Text of every thread row currently rendered. */
const rowTitles = () =>
  [...container.querySelectorAll('span')]
    .map((s) => s.textContent ?? '')
    .filter((t) => t.endsWith(' thread'))

const deleteButtons = () =>
  [...container.querySelectorAll('button')].filter(
    (b) => b.getAttribute('aria-label') === 'Delete thread',
  )

const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const toast = () => container.querySelector('[data-testid="thread-delete-undo-toast"]')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mockedApi.fetchChatThreads.mockResolvedValue(THREADS)
  mockedApi.deleteChatThread.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('thread delete — no confirmation step', () => {
  it('deletes on a single click with no confirm panel', async () => {
    await mount()
    expect(rowTitles()).toEqual(['First thread', 'Second thread'])

    await click(deleteButtons()[0]!)

    // No confirm affordance of any kind.
    const text = container.textContent ?? ''
    expect(text).not.toContain('Delete “First thread”?')
    expect(text).not.toContain('Cancel')
    expect(
      [...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Delete'),
    ).toBe(false)
  })
})

describe('thread delete — optimistic removal and deferred commit', () => {
  it('hides the row immediately without calling the API', async () => {
    await mount()

    await click(deleteButtons()[0]!)

    expect(rowTitles()).toEqual(['Second thread'])
    expect(toast()).not.toBeNull()
    expect(mockedApi.deleteChatThread).not.toHaveBeenCalled()
  })

  it('commits the delete once the undo window elapses', async () => {
    await mount()
    await click(deleteButtons()[0]!)

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    expect(mockedApi.deleteChatThread).toHaveBeenCalledTimes(1)
    expect(mockedApi.deleteChatThread.mock.calls[0]![0]).toBe('t1')
    expect(toast()).toBeNull()
  })
})

describe('thread delete — undo', () => {
  it('restores the row and never calls the API', async () => {
    await mount()
    await click(deleteButtons()[0]!)
    expect(rowTitles()).toEqual(['Second thread'])

    const undo = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Undo',
    )
    expect(undo).toBeDefined()
    await click(undo!)

    expect(rowTitles()).toEqual(['First thread', 'Second thread'])
    expect(toast()).toBeNull()

    // Even after the window would have elapsed, nothing is sent.
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(mockedApi.deleteChatThread).not.toHaveBeenCalled()
  })

  it('re-opens the thread when the undone thread was the selected one', async () => {
    const onSelect = vi.fn()
    await mount(onSelect, 't1')

    await click(deleteButtons()[0]!)
    expect(onSelect).toHaveBeenCalledWith('')

    const undo = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Undo',
    )
    await click(undo!)
    expect(onSelect).toHaveBeenLastCalledWith('t1')
  })
})

describe('thread delete — a second delete commits the first', () => {
  it('does not drop the pending delete when another row is deleted', async () => {
    await mount()

    await click(deleteButtons()[0]!)
    expect(mockedApi.deleteChatThread).not.toHaveBeenCalled()

    // Second delete, still inside the first row's undo window.
    await click(deleteButtons()[0]!)

    // The first delete was flushed rather than discarded.
    expect(mockedApi.deleteChatThread).toHaveBeenCalledTimes(1)
    expect(mockedApi.deleteChatThread.mock.calls[0]![0]).toBe('t1')

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    expect(mockedApi.deleteChatThread).toHaveBeenCalledTimes(2)
    expect(mockedApi.deleteChatThread.mock.calls[1]![0]).toBe('t2')
  })
})

describe('thread delete — server rejection', () => {
  it('restores the row and shows the error', async () => {
    mockedApi.deleteChatThread.mockRejectedValue(new Error('thread is locked'))
    await mount()

    await click(deleteButtons()[0]!)
    expect(rowTitles()).toEqual(['Second thread'])

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(rowTitles()).toEqual(['First thread', 'Second thread'])
    expect(container.textContent).toContain('thread is locked')
  })
})
