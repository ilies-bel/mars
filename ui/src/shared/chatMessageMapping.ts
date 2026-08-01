/**
 * chatMessageMapping — the persisted-history normaliser.
 *
 * Maps a persisted `ChatMessage` (a list of `ChatSegment`s) onto the AI-SDK
 * `UIMessage` parts model that `useChat` renders. This is the history-side twin
 * of the live `LiveEvent -> UIMessageChunk` mapping in `marsChatTransport.ts`:
 * both land on the *same* `MarsUIMessage.parts` shape so history and live render
 * identically.
 *
 * The segment-folding rules are carried over verbatim from the old
 * `groupMessageSegments`:
 *   - `tool_result` folds into the preceding `tool_use` (matched by
 *     `tool_use_id`, else the last tool),
 *   - empty `thinking` / empty `text` segments are dropped,
 *   - `result` usage stats ride as message metadata (not a part),
 *   - `alert` / `attachment` / `error` become typed `data-*` parts.
 */
import type { ChatMessage } from './schemas'
import type { MarsMessageMetadata, MarsUIMessage } from './marsChatTransport'

type Part = MarsUIMessage['parts'][number]

/** Render arbitrary tool content to a string for the `output-error` branch. */
const stringify = (content: unknown): string => {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/**
 * Map one persisted `ChatMessage` to a `MarsUIMessage`. The persisted `id`,
 * `role` and `feedback` are carried through so `useChat` renders it in place and
 * the feedback controls stay wired to the real message id.
 */
export function chatMessageToUIMessage(msg: ChatMessage): MarsUIMessage {
  const parts: Part[] = []
  const toolIndexById = new Map<string, number>()
  let lastToolIndex: number | null = null
  let usage: MarsMessageMetadata['usage']

  for (const seg of msg.segments) {
    switch (seg.type) {
      case 'text': {
        if (seg.text.length === 0) break
        parts.push({ type: 'text', text: seg.text, state: 'done' })
        break
      }
      case 'thinking': {
        if (seg.text.length === 0) break
        parts.push({ type: 'reasoning', text: seg.text, state: 'done' })
        break
      }
      case 'tool_use': {
        const toolCallId = seg.id ?? `${msg.id}-tool-${parts.length}`
        // Proposed tool calls render as a pending confirmation card and must never
        // have a tool_result folded in — even if one arrives later. Using a
        // data-proposedToolCall type ensures the fold guard in the tool_result
        // branch (`!existing.type.startsWith('tool-')`) naturally skips them.
        if (seg.status === 'proposed') {
          lastToolIndex = parts.push({ type: 'data-proposedToolCall', data: { toolName: seg.toolName, input: seg.input, toolCallId } }) - 1
          toolIndexById.set(toolCallId, lastToolIndex)
          break
        }
        const type = `tool-${seg.toolName}` as const
        let part: Part
        if (seg.result !== undefined) {
          part = seg.isError
            ? { type, toolCallId, state: 'output-error', input: seg.input, errorText: stringify(seg.result) }
            : { type, toolCallId, state: 'output-available', input: seg.input, output: seg.result }
        } else {
          part = { type, toolCallId, state: 'input-available', input: seg.input }
        }
        lastToolIndex = parts.push(part) - 1
        toolIndexById.set(toolCallId, lastToolIndex)
        break
      }
      case 'tool_result': {
        const idx =
          (seg.tool_use_id !== undefined ? toolIndexById.get(seg.tool_use_id) : undefined) ??
          lastToolIndex
        if (idx === null || idx === undefined) break
        const existing = parts[idx]
        // Guard: the folded target is always a tool part written just above.
        if (!existing || !existing.type.startsWith('tool-')) break
        const type = existing.type as `tool-${string}`
        const toolCallId = (existing as { toolCallId: string }).toolCallId
        const input = (existing as { input?: unknown }).input
        parts[idx] = seg.isError
          ? { type, toolCallId, state: 'output-error', input, errorText: stringify(seg.content) }
          : { type, toolCallId, state: 'output-available', input, output: seg.content }
        break
      }
      case 'alert': {
        parts.push({ type: 'data-alert', data: seg })
        break
      }
      case 'attachment': {
        parts.push({ type: 'data-attachment', data: seg })
        break
      }
      case 'error': {
        parts.push({ type: 'data-chatError', data: { message: seg.message } })
        break
      }
      case 'result': {
        usage = {
          durationMs: seg.durationMs ?? null,
          inputTokens: seg.inputTokens ?? null,
          outputTokens: seg.outputTokens ?? null,
          cacheReadTokens: seg.cacheReadTokens ?? null,
          cost: seg.cost ?? null,
        }
        break
      }
    }
  }

  return {
    id: msg.id,
    role: msg.role,
    parts,
    metadata: { turnTokens: msg.turnTokens, usage, feedback: msg.feedback ?? null },
  }
}

/** Map a full persisted transcript to `MarsUIMessage[]` for `useChat` seeding. */
export function chatMessagesToUIMessages(messages: ChatMessage[]): MarsUIMessage[] {
  return messages.map(chatMessageToUIMessage)
}

/**
 * Cheap change signature for a persisted transcript. Used by the ChatPage
 * reconcile effect to detect when a refetch actually changed the history (so it
 * can `setMessages` without clobbering an in-flight streamed reply on every
 * render).
 */
export function transcriptSignature(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.id}:${m.segments.length}:${m.feedback?.rating ?? ''}:${m.feedback?.note ?? ''}`)
    .join('|')
}
