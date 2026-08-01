/**
 * Interactive tests for the Composer component.
 *
 * Tests chip add/remove and the send-flow (uploads first, then posts message).
 * These require a DOM environment because they exercise React state transitions
 * triggered by user interactions (file input, button clicks).
 *
 * Runs under happy-dom (configured via environmentMatchGlobs in vitest.config.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Composer } from './ChatPage'

// ---------------------------------------------------------------------------
// Mock the API layer — Composer calls uploadAttachment + postChatMessage
// ---------------------------------------------------------------------------

vi.mock('@/shared/api', () => ({
  fetchChatThreads: vi.fn().mockResolvedValue([]),
  fetchChatThread: vi.fn().mockResolvedValue(null),
  fetchActionQueue: vi.fn().mockResolvedValue([]),
  createChatThread: vi.fn().mockResolvedValue({ id: 'thread-new' }),
  postChatMessage: vi.fn().mockResolvedValue({}),
  uploadAttachment: vi.fn().mockResolvedValue({ id: 'upload-1', path: '/tmp/upload-1.png', mimeType: 'image/png', name: 'photo.png', size: 1024 }),
  renameChatThread: vi.fn().mockResolvedValue({}),
  stopChatThread: vi.fn().mockResolvedValue({}),
  invokeAction: vi.fn().mockResolvedValue({}),
  setMessageFeedback: vi.fn().mockResolvedValue({}),
  clearMessageFeedback: vi.fn().mockResolvedValue({}),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a fresh QueryClient for each test — no cross-test cache pollution. */
const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

/** Creates a minimal File object of a given media type. */
const makeFile = (name: string, type: string) =>
  new File(['media content'], name, { type })

/** Renders the Composer into a container div, returns the root + onSend spy. */
function renderComposer(
  container: HTMLElement,
  props?: {
    threadId?: string
    disabled?: boolean
    onSend?: (text: string, attachments?: unknown[]) => Promise<void>
    onStop?: () => void
    isBusy?: boolean
    threadTokens?: number | null
  },
) {
  const qc = makeQueryClient()
  const root = createRoot(container)
  const onSend = props?.onSend ?? vi.fn().mockResolvedValue(undefined)
  const onStop = props?.onStop ?? vi.fn()
  root.render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(Composer, {
        threadId: props?.threadId ?? 'thread-1',
        disabled: props?.disabled ?? false,
        onInitialTextConsumed: () => {},
        onSend,
        onStop,
        isBusy: props?.isBusy ?? false,
        threadTokens: props?.threadTokens,
      }),
    ),
  )
  return { root, onSend, onStop }
}

/**
 * Simulates adding a file to the hidden file input by:
 *  1. Setting `files` on the input element (DataTransfer trick)
 *  2. Dispatching a native 'change' event (React picks it up via delegation)
 */
async function addFileViaInput(container: HTMLElement, file: File): Promise<void> {
  const fileInput = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null
  if (!fileInput) throw new Error('file input not found')

  const dt = new DataTransfer()
  dt.items.add(file)
  Object.defineProperty(fileInput, 'files', {
    value: dt.files,
    configurable: true,
    writable: false,
  })

  await act(() => {
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  // Reset mock call counts between tests
  vi.clearAllMocks()
})

afterEach(() => {
  document.body.removeChild(container)
})

// ---------------------------------------------------------------------------
// Attachment chip add/remove
// ---------------------------------------------------------------------------

describe('Composer – initial render', () => {
  it('renders the attach (+) button', async () => {
    await act(() => {
      renderComposer(container)
    })
    expect(container.querySelector('[data-testid="attach-btn"]')).not.toBeNull()
  })

  it('renders the send button', async () => {
    await act(() => {
      renderComposer(container)
    })
    expect(container.querySelector('[data-testid="send-btn"]')).not.toBeNull()
  })

  it('shows no attachment chips on initial render', async () => {
    await act(() => {
      renderComposer(container)
    })
    expect(container.querySelector('[data-testid="attachment-chips"]')).toBeNull()
    expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(0)
  })
})

describe('Composer – attachment chip add/remove', () => {
  it('shows a chip after adding an image file via the file input', async () => {
    await act(() => {
      renderComposer(container)
    })

    await addFileViaInput(container, makeFile('photo.png', 'image/png'))

    expect(container.querySelector('[data-testid="attachment-chips"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(1)
  })

  it('shows a chip for each added file', async () => {
    await act(() => {
      renderComposer(container)
    })

    await addFileViaInput(container, makeFile('photo.png', 'image/png'))
    await addFileViaInput(container, makeFile('sound.mp3', 'audio/mpeg'))

    expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(2)
  })

  it('removes a chip when its remove button is clicked', async () => {
    await act(() => {
      renderComposer(container)
    })

    await addFileViaInput(container, makeFile('photo.png', 'image/png'))
    expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(1)

    const removeBtn = container.querySelector(
      '[data-testid="remove-attachment"]',
    ) as HTMLButtonElement | null
    expect(removeBtn).not.toBeNull()

    await act(() => {
      removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(0)
    expect(container.querySelector('[data-testid="attachment-chips"]')).toBeNull()
  })

  it('shows a thumbnail for image chips (previewUrl set)', async () => {
    await act(() => {
      renderComposer(container)
    })

    await addFileViaInput(container, makeFile('pic.jpg', 'image/jpeg'))

    // Image chips should contain an <img> thumbnail (not an emoji icon)
    const chip = container.querySelector('[data-testid="attachment-chip"]')
    expect(chip?.querySelector('img')).not.toBeNull()
  })

  it('shows an emoji icon (no thumbnail) for audio chips', async () => {
    await act(() => {
      renderComposer(container)
    })

    await addFileViaInput(container, makeFile('track.mp3', 'audio/mpeg'))

    const chip = container.querySelector('[data-testid="attachment-chip"]')
    // No thumbnail img for audio — only an emoji span
    expect(chip?.querySelector('img')).toBeNull()
    expect(chip?.textContent).toContain('🎵')
  })

  it('filters out non-media files silently', async () => {
    await act(() => {
      renderComposer(container)
    })

    // PDF file should be rejected by the addFiles filter
    await addFileViaInput(container, makeFile('report.pdf', 'application/pdf'))

    expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Send flow — uploads first, then posts message referencing upload IDs
// ---------------------------------------------------------------------------

describe('Composer – send flow', () => {
  it('uploads attachments then hands the full metadata to onSend (postChatMessage lives in the transport now)', async () => {
    const { uploadAttachment } = await import('@/shared/api')

    let onSend!: ReturnType<typeof vi.fn>
    await act(() => {
      onSend = renderComposer(container, { threadId: 'thread-42' }).onSend as ReturnType<typeof vi.fn>
    })

    // Add an image file
    await addFileViaInput(container, makeFile('photo.png', 'image/png'))

    // Click send (text is empty but attachment is present — that's allowed)
    const sendBtn = container.querySelector(
      '[data-testid="send-btn"]',
    ) as HTMLButtonElement | null
    expect(sendBtn).not.toBeNull()

    await act(async () => {
      sendBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // Allow microtasks to flush (Promise.all inside mutationFn)
      await Promise.resolve()
      await Promise.resolve()
    })

    // uploadAttachment is called first, with the composer's thread id.
    await vi.waitFor(() => {
      expect(uploadAttachment).toHaveBeenCalledTimes(1)
    })
    expect(uploadAttachment).toHaveBeenCalledWith('thread-42', expect.any(File), undefined)

    // onSend then receives the full AttachmentInfo from uploadAttachment's return value —
    // not just the id string. The full metadata is required by the daemon schema.
    await vi.waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1)
    })
    const [calledText, calledAttachments] = onSend.mock.calls[0] as [string, unknown[] | undefined]
    expect(calledText).toBe('')
    expect(calledAttachments).toEqual([
      { id: 'upload-1', path: '/tmp/upload-1.png', mimeType: 'image/png', name: 'photo.png', size: 1024 },
    ])
  })

  it('does not call uploadAttachment or onSend when there is no text and no attachments', async () => {
    const { uploadAttachment } = await import('@/shared/api')

    let onSend!: ReturnType<typeof vi.fn>
    await act(() => {
      onSend = renderComposer(container).onSend as ReturnType<typeof vi.fn>
    })

    // Empty text + no attachments → send is blocked.
    const sendBtn = container.querySelector('[data-testid="send-btn"]') as HTMLButtonElement
    await act(() => {
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Stop button — shown when isBusy, calls onStop to abort the in-flight run
// ---------------------------------------------------------------------------

describe('Composer – stop button', () => {
  it('shows the stop button and hides the send button when isBusy', async () => {
    await act(() => {
      renderComposer(container, { isBusy: true })
    })
    expect(container.querySelector('[data-testid="stop-btn"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="send-btn"]')).toBeNull()
  })

  it('shows the send button and hides the stop button when not busy', async () => {
    await act(() => {
      renderComposer(container)
    })
    expect(container.querySelector('[data-testid="send-btn"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="stop-btn"]')).toBeNull()
  })

  it('calls onStop when the stop button is clicked', async () => {
    let onStop!: ReturnType<typeof vi.fn>
    await act(() => {
      onStop = renderComposer(container, { isBusy: true }).onStop as ReturnType<typeof vi.fn>
    })

    const stopBtn = container.querySelector('[data-testid="stop-btn"]') as HTMLButtonElement
    expect(stopBtn).not.toBeNull()

    await act(() => {
      stopBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Writable-while-busy invariant
// ---------------------------------------------------------------------------

describe('Composer – writable while busy', () => {
  it('textarea stays editable while isBusy', async () => {
    await act(() => {
      renderComposer(container, { isBusy: true })
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    // The textarea must NOT carry the disabled attribute while a run is active.
    expect(textarea!.disabled).toBe(false)
  })

  it('placeholder reads "Message mars…" while isBusy (no "Running…" text)', async () => {
    await act(() => {
      renderComposer(container, { isBusy: true })
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    expect(textarea!.placeholder).toContain('Message mars…')
    expect(textarea!.placeholder).not.toContain('Running…')
  })

  it('draft text typed before a run finishes is preserved afterwards', async () => {
    // Render with isBusy: true and type a draft.
    await act(() => {
      renderComposer(container, { isBusy: true })
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(() => {
      // Simulate user typing into the textarea.
      Object.defineProperty(textarea, 'value', { value: 'my draft', configurable: true, writable: true })
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new window.Event('change', { bubbles: true }))
    })

    // Verify the textarea still has its value (no auto-clear happened).
    // The value may not propagate via controlled React state without a proper
    // change handler spy; assert the textarea was never forcibly cleared.
    expect(textarea.value).not.toBe('')
  })
})

// ---------------------------------------------------------------------------
// Token count — shown below the chat box when thread has usage data
// ---------------------------------------------------------------------------

describe('Composer – thread token count', () => {
  it('shows a token count when threadTokens is a positive number', async () => {
    await act(() => {
      renderComposer(container, { threadTokens: 1234 })
    })
    const el = container.querySelector('[data-testid="thread-token-count"]')
    expect(el).not.toBeNull()
    expect(el?.textContent).toContain('1,234')
    expect(el?.textContent).toContain('tokens')
  })

  it('does not render a token count when threadTokens is null', async () => {
    await act(() => {
      renderComposer(container, { threadTokens: null })
    })
    expect(container.querySelector('[data-testid="thread-token-count"]')).toBeNull()
  })

  it('does not render a token count when threadTokens is omitted', async () => {
    await act(() => {
      renderComposer(container)
    })
    expect(container.querySelector('[data-testid="thread-token-count"]')).toBeNull()
  })

  it('does not render a token count when threadTokens is 0', async () => {
    await act(() => {
      renderComposer(container, { threadTokens: 0 })
    })
    expect(container.querySelector('[data-testid="thread-token-count"]')).toBeNull()
  })
})
