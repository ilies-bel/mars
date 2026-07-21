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
  uploadAttachment: vi.fn().mockResolvedValue({ id: 'upload-1' }),
  renameChatThread: vi.fn().mockResolvedValue({}),
  deleteChatThread: vi.fn().mockResolvedValue({}),
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
  props?: { threadId?: string; disabled?: boolean; onSend?: (text: string, ids?: string[]) => Promise<void> },
) {
  const qc = makeQueryClient()
  const root = createRoot(container)
  const onSend = props?.onSend ?? vi.fn().mockResolvedValue(undefined)
  root.render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(Composer, {
        threadId: props?.threadId ?? 'thread-1',
        disabled: props?.disabled ?? false,
        onInitialTextConsumed: () => {},
        onSend,
      }),
    ),
  )
  return { root, onSend }
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
  it('uploads attachments then hands the resulting ids to onSend (postChatMessage lives in the transport now)', async () => {
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

    // onSend then receives the upload id from uploadAttachment's return value.
    await vi.waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1)
    })
    const [calledText, calledAttachmentIds] = onSend.mock.calls[0] as [string, string[] | undefined]
    expect(calledText).toBe('')
    expect(calledAttachmentIds).toEqual(['upload-1'])
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
