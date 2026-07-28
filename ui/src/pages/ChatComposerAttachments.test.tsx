// @vitest-environment happy-dom
/**
 * DOM interaction tests for the Composer's attachment and mic features.
 *
 * Covers:
 * 1. Attachment chip appears when a file is selected via the "+" file picker.
 * 2. Removing a chip removes it from the list.
 * 3. Send flow: uploadChatAttachment is called before postChatMessage.
 * 4. Mic button is hidden when the Web Speech API is not available.
 *
 * Uses the happy-dom environment for DOM APIs and vi.mock to prevent real
 * network requests. All API calls are replaced with vi.fn() stubs.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { Composer } from './ChatPage'

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports run.
// ---------------------------------------------------------------------------

const mockUploadAttachment = vi.fn().mockResolvedValue({
  id: 'att-1',
  path: 'uploads/test.png',
  mimeType: 'image/png',
  name: 'test.png',
})
const mockStopThread = vi.fn().mockResolvedValue(undefined)

vi.mock('@/shared/api', () => ({
  uploadAttachment: (...args: unknown[]) => mockUploadAttachment(...args),
  postChatMessage: vi.fn().mockResolvedValue(undefined),
  stopChatThread: (...args: unknown[]) => mockStopThread(...args),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeQc = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

/** Mount a Composer with sensible defaults and return the container. */
const mountComposer = (
  overrides: Partial<{
    disabled: boolean
    onSendOverride: (msg: string) => void
    onSend: (text: string, attachments?: unknown[]) => Promise<void>
  }> = {},
): { container: HTMLDivElement; unmount: () => void } => {
  const div = document.createElement('div')
  document.body.appendChild(div)
  const qc = makeQc()
  const root = createRoot(div)

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: qc },
        createElement(Composer, {
          threadId: 'thread-1',
          disabled: overrides.disabled ?? false,
          onInitialTextConsumed: () => {},
          onSendOverride: overrides.onSendOverride,
          onSend: overrides.onSend,
        }),
      ),
    )
  })

  return {
    container: div,
    unmount: () => {
      act(() => root.unmount())
      div.remove()
    },
  }
}

/** Create a fake File for testing. */
const makeFile = (name: string, type: string): File =>
  new File(['data'], name, { type })

// ---------------------------------------------------------------------------
// Attachment chip add / remove
// ---------------------------------------------------------------------------

describe('Composer – attachment chips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the attach button and file input', () => {
    const { container, unmount } = mountComposer()
    expect(container.querySelector('[data-testid="attach-btn"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="file-input"]')).toBeTruthy()
    unmount()
  })

  it('shows a chip when a file is selected via the file input', async () => {
    const { container, unmount } = mountComposer()
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!

    const file = makeFile('photo.png', 'image/png')
    const dt = new DataTransfer()
    dt.items.add(file)

    await act(async () => {
      // Simulate file input change
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const chips = container.querySelectorAll('[data-testid="attachment-chip"]')
    expect(chips.length).toBe(1)

    unmount()
  })

  it('removes a chip when its remove button is clicked', async () => {
    const { container, unmount } = mountComposer()
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!

    const file = makeFile('photo.png', 'image/png')
    const dt = new DataTransfer()
    dt.items.add(file)

    await act(async () => {
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // One chip should be visible
    expect(container.querySelectorAll('[data-testid="attachment-chip"]').length).toBe(1)

    // Click the remove button on the chip
    const removeBtn = container.querySelector<HTMLButtonElement>('[data-testid="remove-attachment"]')!
    await act(async () => {
      removeBtn.click()
    })

    expect(container.querySelectorAll('[data-testid="attachment-chip"]').length).toBe(0)

    unmount()
  })

  it('ignores files that are not image/audio/video', async () => {
    const { container, unmount } = mountComposer()
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!

    const dt = new DataTransfer()
    dt.items.add(makeFile('data.csv', 'text/csv'))
    dt.items.add(makeFile('photo.jpg', 'image/jpeg'))

    await act(async () => {
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Only the image file should produce a chip (CSV is rejected)
    expect(container.querySelectorAll('[data-testid="attachment-chip"]').length).toBe(1)

    unmount()
  })
})

// ---------------------------------------------------------------------------
// Send flow: upload first, then message
// ---------------------------------------------------------------------------

describe('Composer – send flow with attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls uploadAttachment before onSend when an attachment is present', async () => {
    const mockOnSend = vi.fn().mockResolvedValue(undefined)
    const { container, unmount } = mountComposer({ onSend: mockOnSend })
    const input = container.querySelector<HTMLInputElement>('[data-testid="file-input"]')!
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!

    // Add a file
    const file = makeFile('audio.mp3', 'audio/mpeg')
    const dt = new DataTransfer()
    dt.items.add(file)

    await act(async () => {
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Type a message
    await act(async () => {
      // Directly set the textarea value via React's event system
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value',
      )?.set
      nativeInputValueSetter?.call(textarea, 'hello with audio')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Click Send (the Composer uses PromptInputSubmit with data-testid="send-btn")
    const sendBtn = container.querySelector<HTMLButtonElement>('[data-testid="send-btn"]')!

    await act(async () => {
      sendBtn.click()
      // Allow microtasks and async upload to complete
      await new Promise(r => setTimeout(r, 100))
    })

    // Upload was called with the right file
    expect(mockUploadAttachment).toHaveBeenCalledWith('thread-1', file, undefined)
    // onSend was called — the attachment ID only appears if upload ran first and
    // returned it, proving the upload-before-send ordering.
    expect(mockOnSend).toHaveBeenCalledWith('hello with audio', [
      expect.objectContaining({ id: 'att-1' }),
    ])

    unmount()
  })

  it('does not call uploadAttachment when no attachments are selected', async () => {
    const mockOnSend = vi.fn().mockResolvedValue(undefined)
    const { container, unmount } = mountComposer({ onSend: mockOnSend })
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value',
      )?.set
      setter?.call(textarea, 'just text')
      textarea.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const sendBtn = container.querySelector<HTMLButtonElement>('[data-testid="send-btn"]')!

    await act(async () => {
      sendBtn.click()
      await new Promise(r => setTimeout(r, 50))
    })

    expect(mockUploadAttachment).not.toHaveBeenCalled()
    // No attachments → onSend called without attachments
    expect(mockOnSend).toHaveBeenCalledWith('just text', undefined)

    unmount()
  })
})

// ---------------------------------------------------------------------------
// Mic button visibility
// ---------------------------------------------------------------------------

describe('Composer – mic button', () => {
  it('hides the mic button when SpeechRecognition is not available', () => {
    // happy-dom does not expose SpeechRecognition
    const { container, unmount } = mountComposer()
    const micBtn = container.querySelector('[data-testid="mic-button"]')
    // If the API isn't available, the button should not be rendered
    expect(micBtn).toBeNull()
    unmount()
  })
})
