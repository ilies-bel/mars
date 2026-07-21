/**
 * marsChatTransport — a custom AI-SDK `ChatTransport` that bridges the daemon's
 * existing `chat-delta` SSE protocol onto the `useChat` (`@ai-sdk/react`)
 * `UIMessage`/parts model.
 *
 * The daemon streaming protocol is unchanged: the transport POSTs the user turn
 * through the existing `postChatMessage` and then translates the daemon's
 * `LiveEvent` stream (delivered via `chatDeltaBus`) into a
 * `ReadableStream<UIMessageChunk>`. This is the single normaliser — the same
 * `LiveEvent -> UIMessageChunk` mapping used for live streaming will back the
 * persisted-history mapping when ChatPage is rewired.
 *
 * A daemon-native AI-SDK data-stream endpoint is an explicit follow-up, not
 * part of this migration; hence `reconnectToStream` returns `null` (no
 * resumable-stream endpoint) and history reconciliation is left to
 * `fetchChatThread`.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { ApiError, postChatMessage, stopChatThread } from './api'
import { subscribeChatDelta } from './chatDeltaBus'
import type { LiveEvent } from './liveEvent'
import type { ChatFeedback, ChatSegmentAlert, ChatSegmentAttachment } from './schemas'

/** Usage stats carried on the terminal `result` event, surfaced as metadata. */
export interface MarsMessageMetadata {
  usage?: {
    durationMs: number | null
    inputTokens: number | null
    outputTokens: number | null
    cacheReadTokens: number | null
    cost: number | null
  }
  /**
   * Thumbs feedback for a persisted assistant message. Carried on the mapped
   * history message (live streamed messages have no feedback until reconciled
   * from `fetchChatThread`).
   */
  feedback?: ChatFeedback | null
}

/**
 * Mars-specific `data-*` parts. The live transport never emits these — they are
 * produced only by the persisted-history normaliser (`chatMessageMapping.ts`)
 * for segment kinds that have no first-class AI-SDK part (`alert`, `attachment`,
 * `error`). Rendering narrows on the `data-<name>` discriminant.
 */
export type MarsDataParts = {
  alert: ChatSegmentAlert
  attachment: ChatSegmentAttachment
  chatError: { message: string }
}

/** The concrete `UIMessage` shape Mars chat uses (typed metadata + data parts). */
export type MarsUIMessage = UIMessage<MarsMessageMetadata, MarsDataParts>

export interface MarsChatTransportOptions {
  /** The thread this transport instance is bound to. */
  threadId: string
  /** Focused project id, forwarded to every daemon mutation. */
  projectId?: string
}

/** Extract `attachmentIds` passed via `sendMessage(msg, { body })`. */
const readAttachmentIds = (body: unknown): string[] | undefined => {
  if (typeof body !== 'object' || body === null) return undefined
  const raw = (body as { attachmentIds?: unknown }).attachmentIds
  if (!Array.isArray(raw)) return undefined
  const ids = raw.filter((x): x is string => typeof x === 'string')
  return ids.length > 0 ? ids : undefined
}

/** Flatten the text parts of a `UIMessage` into a single content string. */
const flattenText = (message: MarsUIMessage | undefined): string => {
  if (!message) return ''
  return message.parts
    .filter((p): p is Extract<MarsUIMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * Create a `ChatTransport` bound to a single thread. `useChat` calls
 * `sendMessages` on submit/regenerate; the returned stream drives the message.
 */
export const createMarsChatTransport = (
  options: MarsChatTransportOptions,
): ChatTransport<MarsUIMessage> => {
  const { threadId, projectId } = options

  return {
    sendMessages: ({ messages, abortSignal, body }) => {
      // Last user turn -> daemon content + attachment ids.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const content = flattenText(lastUser)
      const attachmentIds = readAttachmentIds(body)

      const stream = new ReadableStream<UIMessageChunk>({
        start(controller) {
          let closed = false
          let textId: string | null = null

          const enqueue = (chunk: UIMessageChunk): void => {
            if (!closed) controller.enqueue(chunk)
          }

          const openTextIfNeeded = (): string => {
            if (textId === null) {
              textId = crypto.randomUUID()
              enqueue({ type: 'text-start', id: textId })
            }
            return textId
          }

          const closeText = (): void => {
            if (textId !== null) {
              enqueue({ type: 'text-end', id: textId })
              textId = null
            }
          }

          let unsubscribe: (() => void) | null = null

          const cleanup = (): void => {
            if (unsubscribe) {
              unsubscribe()
              unsubscribe = null
            }
            abortSignal?.removeEventListener('abort', onAbort)
          }

          const closeStream = (): void => {
            if (closed) return
            closed = true
            cleanup()
            controller.close()
          }

          // Fold one daemon LiveEvent into UIMessageChunk(s).
          const onEvent = (event: LiveEvent): void => {
            if (closed) return
            switch (event.type) {
              case 'text': {
                if (event.text.length === 0) return // drop empty text blocks
                const id = openTextIfNeeded()
                enqueue({ type: 'text-delta', id, delta: event.text })
                return
              }
              case 'thinking': {
                if (event.thinking.length === 0) return // drop empty reasoning
                closeText()
                const rId = crypto.randomUUID()
                enqueue({ type: 'reasoning-start', id: rId })
                enqueue({ type: 'reasoning-delta', id: rId, delta: event.thinking })
                enqueue({ type: 'reasoning-end', id: rId })
                return
              }
              case 'tool_use': {
                enqueue({ type: 'tool-input-start', toolCallId: event.id, toolName: event.name })
                enqueue({
                  type: 'tool-input-available',
                  toolCallId: event.id,
                  toolName: event.name,
                  input: event.input,
                })
                return
              }
              case 'tool_result': {
                // A tool result ends any open prose run before the tool panel resolves.
                closeText()
                if (event.isError) {
                  enqueue({
                    type: 'tool-output-error',
                    toolCallId: event.tool_use_id,
                    errorText: stringifyError(event.content),
                  })
                } else {
                  enqueue({
                    type: 'tool-output-available',
                    toolCallId: event.tool_use_id,
                    output: event.content,
                  })
                }
                return
              }
              case 'result': {
                closeText()
                enqueue({ type: 'finish-step' })
                enqueue({
                  type: 'finish',
                  finishReason: 'stop',
                  messageMetadata: {
                    usage: {
                      durationMs: event.durationMs,
                      inputTokens: event.inputTokens,
                      outputTokens: event.outputTokens,
                      cacheReadTokens: event.cacheReadTokens,
                      cost: event.cost,
                    },
                  },
                })
                closeStream()
                return
              }
              case 'error': {
                closeText()
                enqueue({ type: 'error', errorText: event.message })
                enqueue({ type: 'finish', finishReason: 'error' })
                closeStream()
                return
              }
            }
          }

          // Stop button / unmount: ask the daemon to stop, then settle useChat.
          function onAbort(): void {
            void stopChatThread(threadId, projectId).catch(() => {
              // Best-effort — the run may already be finishing.
            })
            closeText()
            enqueue({ type: 'finish', finishReason: 'stop' })
            closeStream()
          }

          if (abortSignal?.aborted) {
            // Already aborted before we started: settle immediately.
            enqueue({ type: 'start' })
            enqueue({ type: 'start-step' })
            onAbort()
            return
          }
          abortSignal?.addEventListener('abort', onAbort)

          // Subscribe BEFORE posting so a fast `result` cannot race past attach.
          unsubscribe = subscribeChatDelta(threadId, onEvent)

          enqueue({ type: 'start' })
          enqueue({ type: 'start-step' })

          void postChatMessage(threadId, content, projectId, attachmentIds).catch((err: unknown) => {
            // 409 "already running" is a valid race: keep reading the existing
            // run's live stream instead of surfacing an error.
            if (err instanceof ApiError && err.status === 409) return
            const message = err instanceof Error ? err.message : String(err)
            enqueue({ type: 'error', errorText: message })
            enqueue({ type: 'finish', finishReason: 'error' })
            closeStream()
          })
        },
      })

      return Promise.resolve(stream)
    },

    // No resumable-stream endpoint on the daemon yet — reconciliation happens
    // via `fetchChatThread`, driven by ChatPage on reconnect.
    reconnectToStream: () => Promise.resolve(null),
  }
}

/** Render arbitrary tool-error content to a string for `errorText`. */
const stringifyError = (content: unknown): string => {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}
