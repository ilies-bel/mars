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
import { createMarsChatTransport, type MarsUIMessage } from './marsChatTransport'

export interface UseMarsChatOptions {
  /** The thread to bind this chat instance to. */
  threadId: string
  /** Focused project id, forwarded to every daemon mutation. */
  projectId?: string
  /** Persisted history mapped to UIMessages, used to seed the chat. */
  initialMessages?: MarsUIMessage[]
}

/**
 * Bind `useChat` to `threadId`. The transport is memoised on
 * `threadId`/`projectId` so switching threads swaps the underlying stream
 * source cleanly.
 */
export const useMarsChat = (
  options: UseMarsChatOptions,
): UseChatHelpers<MarsUIMessage> => {
  const { threadId, projectId, initialMessages } = options

  const transport = useMemo(
    () => createMarsChatTransport({ threadId, projectId }),
    [threadId, projectId],
  )

  return useChat<MarsUIMessage>({
    id: threadId,
    transport,
    messages: initialMessages,
  })
}
