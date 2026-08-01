/**
 * marsChatTransport — a custom AI-SDK `ChatTransport` that is now a THIN PIPE
 * over the daemon's native UIMessage-chunk stream.
 *
 * The `LiveEvent -> UIMessageChunk` mapping used to live here, folding the
 * daemon's `chat-delta` SSE (via `chatDeltaBus`) client-side. That mapping moved
 * SERVER-SIDE (orchestrator `ui-message-chunks.ts` + `chat-stream-hub.ts`): the
 * daemon now emits mapped, buffered `UIMessageChunk`s over
 * `GET /chat/threads/:id/ui-stream` (proxied to `/api/chat/thread/:id/ui-stream`).
 * This transport just POSTs the user turn and pipes that stream into `useChat`.
 *
 * Wire contract (small, explicit, versioned — both ends are ours):
 *   text/event-stream frames
 *     event: protocol\ndata: {"v":1}\n\n          (once, first)
 *     id: <gen>.<seq>\ndata: <UIMessageChunk JSON>\n\n
 *     : ping\n\n                                   (heartbeat, ignored)
 * The `id` is a `<generation>.<sequence>` cursor. On a mid-run drop the pipe
 * reconnects with `?lastEventId=<gen>.<seq>` and the daemon replays only chunks
 * after it — so the stream is RESUMABLE. `reconnectToStream` uses the same
 * endpoint (mode=resume) so `useChat.resumeStream()` can attach to an in-flight
 * daemon-initiated (alert-origin) run.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { ApiError, chatUiStreamUrl, postChatMessage, stopChatThread } from './api'
import type { AttachmentInfo } from './api'
import type { ChatFeedback, ChatSegmentAlert, ChatSegmentAttachment } from './schemas'

/** Usage stats carried on the terminal `finish` chunk's metadata. */
export interface MarsMessageMetadata {
  /** Provider input + output tokens spent to produce this turn. */
  turnTokens: number
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
 * Mars-specific `data-*` parts. The live stream never emits these — they are
 * produced only by the persisted-history normaliser (`chatMessageMapping.ts`)
 * for segment kinds that have no first-class AI-SDK part (`alert`, `attachment`,
 * `error`). Rendering narrows on the `data-<name>` discriminant.
 */
export type MarsDataParts = {
  alert: ChatSegmentAlert
  attachment: ChatSegmentAttachment
  chatError: { message: string }
  /** A tool call proposed by the agent but awaiting operator confirmation. Never gets a result folded in. */
  proposedToolCall: { toolName: string; input: unknown; toolCallId: string }
}

/** The concrete `UIMessage` shape Mars chat uses (typed metadata + data parts). */
export type MarsUIMessage = UIMessage<MarsMessageMetadata, MarsDataParts>

export interface MarsChatTransportOptions {
  /** The thread this transport instance is bound to. */
  threadId: string
  /** Focused project id, forwarded to every daemon mutation. */
  projectId?: string
}

/** Extract `attachments` (full `AttachmentInfo` objects) passed via `sendMessage(msg, { body })`. */
const readAttachments = (body: unknown): AttachmentInfo[] | undefined => {
  if (typeof body !== 'object' || body === null) return undefined
  const raw = (body as { attachments?: unknown }).attachments
  if (!Array.isArray(raw)) return undefined
  const items = raw.filter(
    (x): x is AttachmentInfo =>
      typeof x === 'object' && x !== null && typeof (x as AttachmentInfo).id === 'string',
  )
  return items.length > 0 ? items : undefined
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
 * Open the ui-stream endpoint. Resolves to the streaming `Response`, or `null`
 * when the daemon reports no run to attach to (HTTP 204 — resume mode with no
 * active run, or no stream hub available).
 */
const openUiStream = async (url: string, signal?: AbortSignal): Promise<Response | null> => {
  const resp = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    ...(signal ? { signal } : {}),
  })
  if (resp.status === 204) return null
  if (!resp.ok || resp.body === null) {
    throw new ApiError(`GET ${url} → ${resp.status}`, 'other', resp.status)
  }
  return resp
}

/**
 * Read a ui-stream `Response`, enqueueing each parsed `UIMessageChunk` and
 * tracking the `<gen>.<seq>` cursor. When the body ends WITHOUT a terminal
 * `finish` chunk (a mid-run network drop) it reconnects from the last cursor —
 * the daemon replays only newer chunks. Returns once a `finish` chunk is seen,
 * the signal aborts, or a reconnect yields 204 (run gone).
 */
const pumpUiStream = async (
  initial: Response,
  threadId: string,
  projectId: string | undefined,
  enqueue: (chunk: UIMessageChunk) => void,
  isClosed: () => boolean,
  signal?: AbortSignal,
): Promise<void> => {
  let resp: Response | null = initial
  let lastId = ''
  let sawFinish = false

  while (resp && !sawFinish && !isClosed() && !signal?.aborted) {
    const reader = resp.body!.pipeThrough(new TextDecoderStream()).getReader()
    let lineBuffer = ''
    let evName = ''
    let dataField = ''
    let idField = ''
    try {
      while (!isClosed() && !signal?.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuffer += value
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.replace(/\r$/, '')
          if (t.startsWith('event: ')) {
            evName = t.slice('event: '.length)
          } else if (t.startsWith('id: ')) {
            idField = t.slice('id: '.length)
          } else if (t.startsWith('data: ')) {
            dataField = t.slice('data: '.length)
          } else if (t === '') {
            // Blank line terminates one SSE event.
            if (dataField && evName !== 'protocol') {
              try {
                const chunk = JSON.parse(dataField) as UIMessageChunk
                if (idField) lastId = idField
                enqueue(chunk)
                if ((chunk as { type: string }).type === 'finish') sawFinish = true
              } catch {
                // Malformed chunk — ignore.
              }
            }
            evName = ''
            dataField = ''
            idField = ''
          }
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* already released */ }
    }

    if (sawFinish || isClosed() || signal?.aborted) {
      resp = null
    } else {
      // Premature end mid-run: reconnect and replay from the last cursor. Always
      // use send-mode so a run that finished during the drop still replays its
      // terminal `finish` (resume-mode would 204 once the run is no longer active).
      resp = await openUiStream(
        chatUiStreamUrl(threadId, { mode: 'send', lastEventId: lastId, projectId }),
        signal,
      )
    }
  }
}

/**
 * Create a `ChatTransport` bound to a single thread. `useChat` calls
 * `sendMessages` on submit/regenerate and `reconnectToStream` on `resumeStream`.
 */
export const createMarsChatTransport = (
  options: MarsChatTransportOptions,
): ChatTransport<MarsUIMessage> => {
  const { threadId, projectId } = options

  return {
    sendMessages: ({ messages, abortSignal, body }) => {
      // Last user turn -> daemon content + full attachment metadata.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')
      const content = flattenText(lastUser)
      const attachments = readAttachments(body)

      const stream = new ReadableStream<UIMessageChunk>({
        start(controller) {
          let closed = false
          const isClosed = (): boolean => closed
          const enqueue = (chunk: UIMessageChunk): void => {
            if (!closed) controller.enqueue(chunk)
          }
          const close = (): void => {
            if (closed) return
            closed = true
            abortSignal?.removeEventListener('abort', onAbort)
            controller.close()
          }

          // Stop button / unmount: ask the daemon to stop, then settle useChat.
          function onAbort(): void {
            void stopChatThread(threadId, projectId).catch(() => {
              // Best-effort — the run may already be finishing.
            })
            enqueue({ type: 'finish', finishReason: 'stop' } as UIMessageChunk)
            close()
          }

          if (abortSignal?.aborted) {
            onAbort()
            return
          }
          abortSignal?.addEventListener('abort', onAbort)

          void (async () => {
            // Post the user turn. A 409 "already running" is a valid race — attach
            // to the existing run's stream instead of surfacing an error.
            try {
              await postChatMessage(threadId, content, projectId, attachments)
            } catch (err: unknown) {
              if (!(err instanceof ApiError && err.status === 409)) {
                const message = err instanceof Error ? err.message : String(err)
                enqueue({ type: 'error', errorText: message } as UIMessageChunk)
                enqueue({ type: 'finish', finishReason: 'error' } as UIMessageChunk)
                close()
                return
              }
            }

            // Follow the run's UIMessage-chunk stream (buffer replay covers a run
            // that started/finished before we connected).
            try {
              const first = await openUiStream(
                chatUiStreamUrl(threadId, { mode: 'send', projectId }),
                abortSignal,
              )
              if (first === null) {
                // No stream available (hub absent) — settle cleanly.
                enqueue({ type: 'finish', finishReason: 'stop' } as UIMessageChunk)
              } else {
                await pumpUiStream(first, threadId, projectId, enqueue, isClosed, abortSignal)
              }
            } catch (err: unknown) {
              if (!closed && !abortSignal?.aborted) {
                const message = err instanceof Error ? err.message : String(err)
                enqueue({ type: 'error', errorText: message } as UIMessageChunk)
                enqueue({ type: 'finish', finishReason: 'error' } as UIMessageChunk)
              }
            } finally {
              close()
            }
          })()
        },
      })

      return Promise.resolve(stream)
    },

    // Resume an in-flight run (e.g. a daemon-initiated alert-origin run) for
    // `useChat.resumeStream()`. Returns null when no run is active to attach to.
    reconnectToStream: async () => {
      let first: Response | null
      try {
        first = await openUiStream(chatUiStreamUrl(threadId, { mode: 'resume', projectId }))
      } catch {
        return null
      }
      if (first === null) return null
      const initial = first
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          let closed = false
          const isClosed = (): boolean => closed
          const enqueue = (chunk: UIMessageChunk): void => {
            if (!closed) controller.enqueue(chunk)
          }
          const close = (): void => {
            if (closed) return
            closed = true
            controller.close()
          }
          void pumpUiStream(initial, threadId, projectId, enqueue, isClosed)
            .catch(() => {
              // Best-effort resume — the history refetch reconciles on failure.
            })
            .finally(close)
        },
      })
    },
  }
}
