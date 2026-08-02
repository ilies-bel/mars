/**
 * Tests for the queued-next-message feature in Composer / ChatConversation.
 *
 * Covers:
 *   - queue-while-busy: Enter with text while isBusy calls onQueueNext
 *   - chip render: queuedNext prop renders data-testid="queued-next-chip"
 *   - cancel: Cancel button calls onCancelQueued
 *   - cancel restores text: cancel re-fills the textarea via initialText mechanism
 *   - auto-submit on busy→ready transition
 *   - one-slot invariant: a second queue attempt replaces the first
 *
 * Runs under happy-dom (configured via vitest.config.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, useState, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Composer } from './ChatPage'
import type { AttachmentInfo } from '@/shared/api'

// ---------------------------------------------------------------------------
// Mock the API layer (same as ChatPage.composer.test.tsx)
// ---------------------------------------------------------------------------

vi.mock('@/shared/api', () => ({
  fetchChatLayoutPreference: vi.fn().mockResolvedValue({ layout: 'focus' }),
  putChatLayoutPreference: vi.fn().mockResolvedValue({ layout: 'focus' }),
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue(null),
  fetchActionQueue: vi.fn().mockResolvedValue([]),
  createChatThread: vi.fn().mockResolvedValue({ id: 'thread-new' }),
  postChatMessage: vi.fn().mockResolvedValue({}),
  uploadAttachment: vi.fn().mockResolvedValue({
    id: 'upload-1',
    path: '/tmp/upload-1.png',
    mimeType: 'image/png',
    name: 'photo.png',
    size: 1024,
  }),
  renameChatThread: vi.fn().mockResolvedValue({}),
  stopChatThread: vi.fn().mockResolvedValue({}),
  invokeAction: vi.fn().mockResolvedValue({}),
  setMessageFeedback: vi.fn().mockResolvedValue({}),
  clearMessageFeedback: vi.fn().mockResolvedValue({}),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

/**
 * Render Composer with queue-related props.
 */
function renderComposer(
  container: HTMLElement,
  props: {
    isBusy?: boolean
    onQueueNext?: (text: string, attachments?: AttachmentInfo[]) => void
    queuedNext?: { text: string; attachmentCount: number } | null
    onCancelQueued?: () => void
    initialText?: string
    onInitialTextConsumed?: () => void
    onSend?: (text: string, att?: AttachmentInfo[]) => Promise<void>
  } = {},
) {
  const qc = makeQueryClient()
  const root = createRoot(container)
  root.render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(Composer, {
        threadId: 'thread-q',
        disabled: false,
        isBusy: props.isBusy ?? false,
        onInitialTextConsumed: props.onInitialTextConsumed ?? (() => {}),
        initialText: props.initialText,
        onSend: props.onSend ?? vi.fn().mockResolvedValue(undefined),
        onStop: () => {},
        onQueueNext: props.onQueueNext,
        queuedNext: props.queuedNext,
        onCancelQueued: props.onCancelQueued,
      }),
    ),
  )
  return { root }
}

/**
 * Type text into the composer textarea and press Enter.
 * React's onChange fires via native event delegation.
 */
async function typeAndPressEnter(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  if (!textarea) throw new Error('textarea not found')

  // Set DOM value and fire change so React's handler updates state.
  Object.defineProperty(textarea, 'value', { value: text, configurable: true, writable: true })
  await act(async () => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
  })

  // Press Enter — handleKeyDown → handleSend (now async).
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }),
    )
    // Flush any microtasks spawned by the async handleSend.
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ---------------------------------------------------------------------------
// QueueManagerWrapper — mirrors ChatConversation's queue orchestration
// ---------------------------------------------------------------------------

/**
 * A stateful wrapper component that mirrors what ChatConversation does:
 *   - tracks isBusy and a queued message
 *   - auto-submits the queued message when busy→ready transition occurs
 *   - cancel restores text to the composer via initialText/onInitialTextConsumed
 *
 * Exposes a "End run" button to simulate the busy→ready transition.
 */
function QueueManagerWrapper({
  onFinalSend,
}: {
  onFinalSend: ReturnType<typeof vi.fn>
}) {
  const [isBusy, setIsBusy] = useState(true)
  const [queued, setQueued] = useState<{ text: string; attachments?: AttachmentInfo[] } | null>(null)
  const [localPrefill, setLocalPrefill] = useState<string | undefined>(undefined)
  // Stable QueryClient across re-renders.
  const qcRef = useRef(makeQueryClient())
  const prevBusyRef = useRef(true)

  // Auto-submit on busy→ready transition (mirrors ChatConversation's useEffect).
  useEffect(() => {
    const prevBusy = prevBusyRef.current
    prevBusyRef.current = isBusy
    if (prevBusy && !isBusy && queued !== null) {
      onFinalSend(queued.text, queued.attachments)
      setQueued(null)
    }
  }, [isBusy, queued, onFinalSend])

  return createElement(
    'div',
    null,
    createElement('button', {
      type: 'button',
      'data-testid': 'end-run',
      onClick: () => setIsBusy(false),
    }, 'End run'),
    createElement(
      QueryClientProvider,
      { client: qcRef.current },
      createElement(Composer, {
        threadId: 'thread-q',
        disabled: false,
        isBusy,
        onInitialTextConsumed: () => setLocalPrefill(undefined),
        initialText: localPrefill,
        onSend: vi.fn().mockResolvedValue(undefined),
        onStop: () => {},
        onQueueNext: (text: string, att?: AttachmentInfo[]) => setQueued({ text, attachments: att }),
        queuedNext: queued ? { text: queued.text, attachmentCount: queued.attachments?.length ?? 0 } : null,
        onCancelQueued: () => {
          if (queued) {
            setLocalPrefill(queued.text)
            setQueued(null)
          }
        },
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.removeChild(container)
})

// ---------------------------------------------------------------------------
// queue-while-busy
// ---------------------------------------------------------------------------

describe('Composer – queue while busy', () => {
  it('calls onQueueNext with trimmed text when Enter is pressed while isBusy', async () => {
    const onQueueNext = vi.fn()
    await act(() => {
      renderComposer(container, { isBusy: true, onQueueNext })
    })

    await typeAndPressEnter(container, '  hello world  ')

    await vi.waitFor(() => {
      expect(onQueueNext).toHaveBeenCalledTimes(1)
    })
    expect(onQueueNext).toHaveBeenCalledWith('hello world', undefined)
  })

  it('clears the textarea after queuing', async () => {
    const onQueueNext = vi.fn()
    await act(() => {
      renderComposer(container, { isBusy: true, onQueueNext })
    })

    await typeAndPressEnter(container, 'clear me')

    await vi.waitFor(() => expect(onQueueNext).toHaveBeenCalledTimes(1))

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('does not call onQueueNext when text is empty', async () => {
    const onQueueNext = vi.fn()
    await act(() => {
      renderComposer(container, { isBusy: true, onQueueNext })
    })

    await typeAndPressEnter(container, '')

    expect(onQueueNext).not.toHaveBeenCalled()
  })

  it('does not call onSend when busy (queue path wins)', async () => {
    const onQueueNext = vi.fn()
    const onSend = vi.fn().mockResolvedValue(undefined)
    await act(() => {
      renderComposer(container, { isBusy: true, onQueueNext, onSend })
    })

    await typeAndPressEnter(container, 'queue this')

    await vi.waitFor(() => expect(onQueueNext).toHaveBeenCalledTimes(1))
    expect(onSend).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// chip render
// ---------------------------------------------------------------------------

describe('Composer – queued-next chip', () => {
  it('renders queued-next-chip when queuedNext prop is provided', async () => {
    await act(() => {
      renderComposer(container, {
        queuedNext: { text: 'my queued message', attachmentCount: 0 },
      })
    })

    const chip = container.querySelector('[data-testid="queued-next-chip"]')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('my queued message')
  })

  it('does not render chip when queuedNext is null', async () => {
    await act(() => {
      renderComposer(container, { queuedNext: null })
    })
    expect(container.querySelector('[data-testid="queued-next-chip"]')).toBeNull()
  })

  it('does not render chip when queuedNext is omitted', async () => {
    await act(() => {
      renderComposer(container)
    })
    expect(container.querySelector('[data-testid="queued-next-chip"]')).toBeNull()
  })

  it('shows attachment count when attachmentCount > 0', async () => {
    await act(() => {
      renderComposer(container, {
        queuedNext: { text: 'has attachments', attachmentCount: 3 },
      })
    })
    const chip = container.querySelector('[data-testid="queued-next-chip"]')
    expect(chip?.textContent).toContain('3')
  })
})

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('Composer – cancel queued message', () => {
  it('calls onCancelQueued when Cancel button is clicked', async () => {
    const onCancelQueued = vi.fn()
    await act(() => {
      renderComposer(container, {
        queuedNext: { text: 'cancel me', attachmentCount: 0 },
        onCancelQueued,
      })
    })

    const cancelBtn = container.querySelector(
      '[data-testid="queued-next-cancel"]',
    ) as HTMLButtonElement
    expect(cancelBtn).not.toBeNull()

    await act(() => {
      cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onCancelQueued).toHaveBeenCalledTimes(1)
  })

  it('cancel re-fills the textarea with the queued text', async () => {
    await act(() => {
      const root = createRoot(container)
      root.render(createElement(QueueManagerWrapper, { onFinalSend: vi.fn() }))
    })

    // Queue a message while busy.
    await typeAndPressEnter(container, 'restore me please')

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="queued-next-chip"]')).not.toBeNull()
    })

    // Click cancel.
    const cancelBtn = container.querySelector(
      '[data-testid="queued-next-cancel"]',
    ) as HTMLButtonElement
    await act(() => {
      cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Chip should be gone.
    expect(container.querySelector('[data-testid="queued-next-chip"]')).toBeNull()

    // Textarea should be re-filled with the queued text.
    await vi.waitFor(() => {
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement
      expect(textarea.value).toBe('restore me please')
    })
  })
})

// ---------------------------------------------------------------------------
// auto-submit on busy→ready transition
// ---------------------------------------------------------------------------

describe('Composer – auto-submit on busy→ready', () => {
  it('auto-submits the queued message when the run finishes', async () => {
    const onFinalSend = vi.fn()
    await act(() => {
      const root = createRoot(container)
      root.render(createElement(QueueManagerWrapper, { onFinalSend }))
    })

    // Queue a message while the run is busy.
    await typeAndPressEnter(container, 'auto-submit this')

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="queued-next-chip"]')).not.toBeNull()
    })

    // Simulate run finishing (busy→ready).
    const endRunBtn = container.querySelector('[data-testid="end-run"]') as HTMLButtonElement
    await act(() => {
      endRunBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(onFinalSend).toHaveBeenCalledTimes(1)
    })
    expect(onFinalSend).toHaveBeenCalledWith('auto-submit this', undefined)

    // Chip should be cleared after auto-submit.
    expect(container.querySelector('[data-testid="queued-next-chip"]')).toBeNull()
  })

  it('auto-submits exactly once even if the effect re-fires', async () => {
    const onFinalSend = vi.fn()
    await act(() => {
      const root = createRoot(container)
      root.render(createElement(QueueManagerWrapper, { onFinalSend }))
    })

    await typeAndPressEnter(container, 'once only')

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="queued-next-chip"]')).not.toBeNull()
    })

    const endRunBtn = container.querySelector('[data-testid="end-run"]') as HTMLButtonElement
    await act(() => {
      endRunBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => expect(onFinalSend).toHaveBeenCalledTimes(1))
    // Wait a bit more to confirm no double-fire.
    await new Promise((r) => setTimeout(r, 50))
    expect(onFinalSend).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// one-slot invariant
// ---------------------------------------------------------------------------

describe('Composer – one-slot invariant', () => {
  it('onQueueNext is called for each queue attempt (parent replaces with setState)', async () => {
    const onQueueNext = vi.fn()
    await act(() => {
      renderComposer(container, { isBusy: true, onQueueNext })
    })

    // First queue.
    await typeAndPressEnter(container, 'first message')
    await vi.waitFor(() => expect(onQueueNext).toHaveBeenCalledTimes(1))

    // Second queue — onQueueNext should be called again; the parent
    // replaces the state via setQueued (no accumulation).
    await typeAndPressEnter(container, 'second message')
    await vi.waitFor(() => expect(onQueueNext).toHaveBeenCalledTimes(2))

    expect(onQueueNext.mock.calls[0]![0]).toBe('first message')
    expect(onQueueNext.mock.calls[1]![0]).toBe('second message')
  })

  it('the chip shows only one entry at a time (managed by QueueManagerWrapper)', async () => {
    const onFinalSend = vi.fn()
    await act(() => {
      const root = createRoot(container)
      root.render(createElement(QueueManagerWrapper, { onFinalSend }))
    })

    // Queue first.
    await typeAndPressEnter(container, 'first')
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="queued-next-chip"]')).not.toBeNull()
    })

    // Queue second — replaces the first.
    await typeAndPressEnter(container, 'second')
    await vi.waitFor(() => {
      const chip = container.querySelector('[data-testid="queued-next-chip"]')
      expect(chip?.textContent).toContain('second')
    })

    // Still only one chip.
    expect(container.querySelectorAll('[data-testid="queued-next-chip"]')).toHaveLength(1)
  })
})
