// @vitest-environment happy-dom
/**
 * DOM interaction tests for HeroEmptyState.
 *
 * Covers:
 * 1. Hero renders "What should Mars build?" headline when no thread is selected.
 * 2. Hero composer calls onCreateAndSend when the user types and submits.
 *
 * Uses the happy-dom environment for DOM APIs and vi.mock to prevent network
 * requests from the useQuery calls inside HeroEmptyState.
 */

import { vi, describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HeroEmptyState } from './ChatPage'

// ---------------------------------------------------------------------------
// Module mocks — hoisted by vite before imports execute.
// Mock the API to prevent network requests when HeroEmptyState queries the
// action queue and thread list.
// ---------------------------------------------------------------------------

vi.mock('@/shared/api', () => ({
  fetchActionQueue: vi.fn().mockResolvedValue([]),
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue({
    thread: { id: 'tid', title: null, status: 'idle', createdAt: '', updatedAt: '', messageCount: 0 },
    messages: [],
  }),
  createChatThread: vi.fn().mockResolvedValue({
    id: 'new-thread-1',
    title: null,
    status: 'idle',
    createdAt: '',
    updatedAt: '',
    messageCount: 0,
  }),
  postChatMessage: vi.fn().mockResolvedValue(undefined),
  renameChatThread: vi.fn().mockResolvedValue(undefined),
  deleteChatThread: vi.fn().mockResolvedValue(undefined),
  stopChatThread: vi.fn().mockResolvedValue(undefined),
  invokeAction: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeQc = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

/** Render HeroEmptyState to static markup for presence checks. */
const renderHeroStatic = (
  opts: {
    onSelectThread?: (id: string) => void
    onCreateAndSend?: (msg: string) => void
    isPending?: boolean
  } = {},
) =>
  renderToStaticMarkup(
    <QueryClientProvider client={makeQc()}>
      <HeroEmptyState
        projectId={undefined}
        onSelectThread={opts.onSelectThread ?? (() => {})}
        onCreateAndSend={opts.onCreateAndSend ?? (() => {})}
        isPending={opts.isPending ?? false}
      />
    </QueryClientProvider>,
  )

// ---------------------------------------------------------------------------
// Hero renders when no thread is selected
// ---------------------------------------------------------------------------

describe('HeroEmptyState – renders when no thread is selected', () => {
  it('shows the "What should Mars build?" headline', () => {
    const html = renderHeroStatic()
    expect(html).toContain('What should Mars build?')
  })

  it('shows a subtitle prompting the user to start a conversation', () => {
    const html = renderHeroStatic()
    expect(html).toContain('Start a conversation')
  })

  it('renders the hero composer textarea', () => {
    const html = renderHeroStatic()
    expect(html).toContain('hero-composer')
  })
})

// ---------------------------------------------------------------------------
// Composer creates and sends in one gesture
// ---------------------------------------------------------------------------

/**
 * Simulates typing into a React-controlled textarea.
 *
 * React's synthetic event system intercepts the native `value` setter, so we
 * must go through the prototype's own property descriptor rather than
 * assigning `textarea.value` directly — otherwise the `onChange` handler does
 * not fire and React's state is not updated.
 */
const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set
  nativeSetter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('HeroEmptyState – composer creates and sends', () => {
  it('calls onCreateAndSend with the typed text when the user presses Enter', async () => {
    const onCreateAndSend = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <HeroEmptyState
            projectId={undefined}
            onSelectThread={() => {}}
            onCreateAndSend={onCreateAndSend}
            isPending={false}
          />
        </QueryClientProvider>,
      )
    })

    const textarea = container.querySelector(
      '[data-testid="hero-composer"]',
    ) as HTMLTextAreaElement
    expect(textarea).toBeTruthy()

    await act(async () => {
      setTextareaValue(textarea, 'Build me a feature')
    })

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })

    expect(onCreateAndSend).toHaveBeenCalledWith('Build me a feature')

    await act(async () => { root.unmount() })
    document.body.removeChild(container)
  })

  it('calls onCreateAndSend when the Send button is clicked', async () => {
    const onCreateAndSend = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <HeroEmptyState
            projectId={undefined}
            onSelectThread={() => {}}
            onCreateAndSend={onCreateAndSend}
            isPending={false}
          />
        </QueryClientProvider>,
      )
    })

    const textarea = container.querySelector(
      '[data-testid="hero-composer"]',
    ) as HTMLTextAreaElement

    await act(async () => {
      setTextareaValue(textarea, 'Enqueue a task')
    })

    const sendBtn = container.querySelector('[data-testid="hero-send"]') as HTMLElement
    await act(async () => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onCreateAndSend).toHaveBeenCalledWith('Enqueue a task')

    await act(async () => { root.unmount() })
    document.body.removeChild(container)
  })

  it('does not call onCreateAndSend when the input is empty', async () => {
    const onCreateAndSend = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <QueryClientProvider client={makeQc()}>
          <HeroEmptyState
            projectId={undefined}
            onSelectThread={() => {}}
            onCreateAndSend={onCreateAndSend}
            isPending={false}
          />
        </QueryClientProvider>,
      )
    })

    const textarea = container.querySelector(
      '[data-testid="hero-composer"]',
    ) as HTMLTextAreaElement

    // Press Enter without typing anything
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })

    expect(onCreateAndSend).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
    document.body.removeChild(container)
  })
})
