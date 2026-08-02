/**
 * Tests for Slice 3 of PRD 6f02bd06: Run-control cluster
 *
 * Covers:
 *   - Stop preserves queued slot: clicking Stop with a queued message → slot is
 *     preserved and auto-submits once the run settles to ready.
 *   - Stop preserves draft text: clicking Stop while text is in the composer but
 *     no slot is queued → text remains after the run settles.
 *   - Pause button absent when canPause is false or omitted.
 *   - Pause button present when canPause is true.
 *   - onPause is called when the Pause button is clicked.
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
// Mock the API layer (same pattern as ChatPage.composer.test.tsx)
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

function renderComposer(
  container: HTMLElement,
  props: {
    isBusy?: boolean
    onStop?: () => void
    onQueueNext?: (text: string, attachments?: AttachmentInfo[]) => void
    queuedNext?: { text: string; attachmentCount: number } | null
    onCancelQueued?: () => void
    initialText?: string
    onInitialTextConsumed?: () => void
    onSend?: (text: string, att?: AttachmentInfo[]) => Promise<void>
    canPause?: boolean
    onPause?: () => void
  } = {},
) {
  const qc = makeQueryClient()
  const root = createRoot(container)
  root.render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(Composer, {
        threadId: 'thread-rc',
        disabled: false,
        isBusy: props.isBusy ?? false,
        onInitialTextConsumed: props.onInitialTextConsumed ?? (() => {}),
        initialText: props.initialText,
        onSend: props.onSend ?? vi.fn().mockResolvedValue(undefined),
        onStop: props.onStop ?? (() => {}),
        onQueueNext: props.onQueueNext,
        queuedNext: props.queuedNext,
        onCancelQueued: props.onCancelQueued,
        canPause: props.canPause,
        onPause: props.onPause,
      }),
    ),
  )
  return { root }
}

/** Type into the composer textarea and press Enter. */
async function typeAndPressEnter(container: HTMLElement, text: string): Promise<void> {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  if (!textarea) throw new Error('textarea not found')

  Object.defineProperty(textarea, 'value', { value: text, configurable: true, writable: true })
  await act(async () => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('change', { bubbles: true }))
  })

  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true }),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ---------------------------------------------------------------------------
// StopWithQueueWrapper — orchestrates Stop + queued message interaction.
//
// Mirrors ChatConversation's state management:
//   - tracks isBusy and a queued message slot
//   - auto-submits the queued slot when busy→ready transition occurs
//   - exposes "Stop run" and "Settle run" buttons to simulate the stop flow
// ---------------------------------------------------------------------------

function StopWithQueueWrapper({
  onFinalSend,
}: {
  onFinalSend: ReturnType<typeof vi.fn>
}) {
  const [isBusy, setIsBusy] = useState(true)
  const [queued, setQueued] = useState<{ text: string; attachments?: AttachmentInfo[] } | null>(null)
  const [localPrefill, setLocalPrefill] = useState<string | undefined>(undefined)
  const qcRef = useRef(makeQueryClient())
  const prevBusyRef = useRef(true)

  // Auto-submit on busy→ready (mirrors ChatConversation's useEffect).
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
    // "Stop" simulates the user clicking the Stop button (run still in progress)
    createElement('button', {
      type: 'button',
      'data-testid': 'sim-stop',
      onClick: () => {
        // Stop is called, but run hasn't settled yet — isBusy stays true here.
        // Nothing changes in the queue.
      },
    }, 'Stop'),
    // "Settle" simulates the run actually settling to ready after a stop.
    createElement('button', {
      type: 'button',
      'data-testid': 'sim-settle',
      onClick: () => setIsBusy(false),
    }, 'Settle'),
    createElement(
      QueryClientProvider,
      { client: qcRef.current },
      createElement(Composer, {
        threadId: 'thread-rc',
        disabled: false,
        isBusy,
        onInitialTextConsumed: () => setLocalPrefill(undefined),
        initialText: localPrefill,
        onSend: vi.fn().mockResolvedValue(undefined),
        onStop: () => setIsBusy(false), // Stop also settles the run in this fixture
        onQueueNext: (text: string, att?: AttachmentInfo[]) =>
          setQueued({ text, attachments: att }),
        queuedNext: queued
          ? { text: queued.text, attachmentCount: queued.attachments?.length ?? 0 }
          : null,
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
// StopPreservesDraftWrapper — verifies draft text survives a stop.
// ---------------------------------------------------------------------------

function StopPreservesDraftWrapper() {
  const [isBusy, setIsBusy] = useState(true)
  const qcRef = useRef(makeQueryClient())

  return createElement(
    'div',
    null,
    createElement(
      QueryClientProvider,
      { client: qcRef.current },
      createElement(Composer, {
        threadId: 'thread-rc',
        disabled: false,
        isBusy,
        onInitialTextConsumed: () => {},
        onSend: vi.fn().mockResolvedValue(undefined),
        onStop: () => setIsBusy(false), // settle the run
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
// Stop preserves queued slot
// ---------------------------------------------------------------------------

describe('Run-control – Stop preserves queued slot', () => {
  it('queued slot auto-submits when Stop settles the run', async () => {
    const onFinalSend = vi.fn()
    await act(() => {
      const root = createRoot(container)
      root.render(createElement(StopWithQueueWrapper, { onFinalSend }))
    })

    // Queue a message while run is busy.
    await typeAndPressEnter(container, 'after the stop')

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="queued-next-chip"]')).not.toBeNull()
    })

    // Click Stop — the fixture wires onStop to also settle the run.
    const stopBtn = container.querySelector('[data-testid="stop-btn"]') as HTMLButtonElement
    expect(stopBtn).not.toBeNull()
    await act(() => {
      stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The run settled to ready → queued message should auto-submit.
    await vi.waitFor(() => {
      expect(onFinalSend).toHaveBeenCalledTimes(1)
    })
    expect(onFinalSend).toHaveBeenCalledWith('after the stop', undefined)

    // Chip cleared after auto-submit.
    expect(container.querySelector('[data-testid="queued-next-chip"]')).toBeNull()
  })

  it('queued slot is not lost between Stop click and run settle', async () => {
    const onFinalSend = vi.fn()
    await act(() => {
      const root = createRoot(container)
      root.render(createElement(StopWithQueueWrapper, { onFinalSend }))
    })

    await typeAndPressEnter(container, 'preserve me')

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="queued-next-chip"]')).not.toBeNull()
    })

    // Simulate the stop (isBusy stays true in this step).
    const simStop = container.querySelector('[data-testid="sim-stop"]') as HTMLButtonElement
    await act(() => {
      simStop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Chip must still be visible — slot not cleared by a stop click.
    expect(container.querySelector('[data-testid="queued-next-chip"]')).not.toBeNull()

    // Now settle the run.
    const simSettle = container.querySelector('[data-testid="sim-settle"]') as HTMLButtonElement
    await act(() => {
      simSettle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => expect(onFinalSend).toHaveBeenCalledTimes(1))
    expect(onFinalSend).toHaveBeenCalledWith('preserve me', undefined)
  })
})

// ---------------------------------------------------------------------------
// Stop preserves draft text
// ---------------------------------------------------------------------------

describe('Run-control – Stop preserves draft text', () => {
  it('draft text in the composer remains after Stop settles the run', async () => {
    await act(() => {
      const root = createRoot(container)
      root.render(createElement(StopPreservesDraftWrapper))
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).not.toBeNull()

    // Type into the composer but do NOT press Enter (no queue).
    Object.defineProperty(textarea, 'value', {
      value: 'my draft',
      configurable: true,
      writable: true,
    })
    await act(async () => {
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Click Stop (settles the run in our fixture).
    const stopBtn = container.querySelector('[data-testid="stop-btn"]') as HTMLButtonElement
    expect(stopBtn).not.toBeNull()
    await act(() => {
      stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Draft must still be there.
    await vi.waitFor(() => {
      expect(
        (container.querySelector('textarea') as HTMLTextAreaElement).value,
      ).toBe('my draft')
    })
  })
})

// ---------------------------------------------------------------------------
// Pause button visibility
// ---------------------------------------------------------------------------

describe('Run-control – Pause button visibility', () => {
  it('Pause button is absent when canPause is false', async () => {
    await act(() => {
      renderComposer(container, { isBusy: true, canPause: false })
    })
    expect(container.querySelector('[data-testid="pause-btn"]')).toBeNull()
  })

  it('Pause button is absent when canPause is omitted', async () => {
    await act(() => {
      renderComposer(container, { isBusy: true })
    })
    expect(container.querySelector('[data-testid="pause-btn"]')).toBeNull()
  })

  it('Pause button is absent when the thread is not busy (even if canPause is true)', async () => {
    await act(() => {
      renderComposer(container, { isBusy: false, canPause: true })
    })
    expect(container.querySelector('[data-testid="pause-btn"]')).toBeNull()
  })

  it('Pause button is present when canPause is true and thread is busy', async () => {
    await act(() => {
      renderComposer(container, { isBusy: true, canPause: true })
    })
    expect(container.querySelector('[data-testid="pause-btn"]')).not.toBeNull()
  })

  it('clicking Pause calls onPause', async () => {
    const onPause = vi.fn()
    await act(() => {
      renderComposer(container, { isBusy: true, canPause: true, onPause })
    })

    const pauseBtn = container.querySelector('[data-testid="pause-btn"]') as HTMLButtonElement
    expect(pauseBtn).not.toBeNull()

    await act(() => {
      pauseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onPause).toHaveBeenCalledTimes(1)
  })
})
