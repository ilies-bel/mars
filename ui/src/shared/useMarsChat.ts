/**
 * useMarsChat — constructs a `useChat` instance bound to one Mars chat thread,
 * driven by the custom `MarsChatTransport`.
 *
 * ChatPage will consume this (step 3): pass the `threadId`, the focused
 * `projectId`, and the persisted history (already mapped to `MarsUIMessage[]`)
 * as `initialMessages`. The transport translates the daemon `chat-delta` stream
 * into the `UIMessage` parts `useChat` renders.
 */
import { useMemo } from 'react'
import { useChat, type UseChatHelpers } from '@ai-sdk/react'
import { ApiError } from './api'
import { createMarsChatTransport, type MarsUIMessage } from './marsChatTransport'

export interface UseMarsChatOptions {
  /** The thread to bind this chat instance to. */
  threadId: string
  /** Focused project id, forwarded to every daemon mutation. */
  projectId?: string
  /** Persisted history mapped to UIMessages, used to seed the chat. */
  initialMessages?: MarsUIMessage[]
  /**
   * Called when `postChatMessage` fails — either a non-2xx response
   * (`ApiError`) or a network failure (`TypeError`). Fires synchronously
   * inside the AI SDK's makeRequest catch block, BEFORE `sendMessage`
   * resolves, so the caller can re-throw from `handleSend` to prevent
   * the Composer from clearing the typed text on failure.
   *
   * Errors from the SSE stream phase (which arrive as plain `Error`
   * instances from error chunks) are intentionally NOT forwarded here
   * because the message was already persisted by that point — clearing
   * the input is correct behaviour.
   */
  onSendError?: (err: ApiError | TypeError) => void
}

/**
 * Bind `useChat` to `threadId`. The transport is memoised on
 * `threadId`/`projectId` so switching threads swaps the underlying stream
 * source cleanly.
 */
export const useMarsChat = (
  options: UseMarsChatOptions,
): UseChatHelpers<MarsUIMessage> => {
  const { threadId, projectId, initialMessages, onSendError } = options

  const transport = useMemo(
    () => createMarsChatTransport({ threadId, projectId }),
    [threadId, projectId],
  )

  return useChat<MarsUIMessage>({
    id: threadId,
    transport,
    messages: initialMessages,
    onError: onSendError
      ? (err: Error) => {
          // Forward only send-phase errors (ApiError = non-2xx, TypeError = network).
          // Stream-phase errors arrive as plain Error instances and are excluded.
          if (err instanceof ApiError || err instanceof TypeError) {
            onSendError(err as ApiError | TypeError)
          }
        }
      : undefined,
  })
}
