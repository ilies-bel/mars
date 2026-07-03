export interface ClaudeEvent {
  type: string
  [key: string]: unknown
}

export type ClaudeConversation = ClaudeEvent[]

const TOOL_USE_INPUT_THRESHOLD = 2 * 1024
const TOOL_RESULT_CONTENT_THRESHOLD = 4 * 1024
const HEAD_PREVIEW_BYTES = 2048

interface TruncatedPayload {
  truncated: true
  originalBytes: number
  head: string
}

const truncatePayload = (
  payload: unknown,
  threshold: number,
): unknown | TruncatedPayload => {
  const serialized = JSON.stringify(payload)
  if (serialized === undefined) return payload
  if (serialized.length <= threshold) return payload
  return {
    truncated: true,
    originalBytes: serialized.length,
    head: serialized.slice(0, HEAD_PREVIEW_BYTES),
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const trimContentBlocks = (blocks: unknown): unknown => {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((block) => {
    if (!isObject(block)) return block
    if (block.type === 'tool_use' && 'input' in block) {
      return { ...block, input: truncatePayload(block.input, TOOL_USE_INPUT_THRESHOLD) }
    }
    if (block.type === 'tool_result' && 'content' in block) {
      return {
        ...block,
        content: truncatePayload(block.content, TOOL_RESULT_CONTENT_THRESHOLD),
      }
    }
    return block
  })
}

const trimEvent = (event: ClaudeEvent): ClaudeEvent => {
  if (event.type === 'assistant' || event.type === 'user') {
    const message = event.message
    if (isObject(message) && 'content' in message) {
      const trimmed = trimContentBlocks(message.content)
      return { ...event, message: { ...message, content: trimmed } }
    }
  }
  if (event.type === 'tool_use' && 'input' in event) {
    return { ...event, input: truncatePayload(event.input, TOOL_USE_INPUT_THRESHOLD) }
  }
  if (event.type === 'tool_result' && 'content' in event) {
    return {
      ...event,
      content: truncatePayload(event.content, TOOL_RESULT_CONTENT_THRESHOLD),
    }
  }
  return event
}

export const parseClaudeStreamLine = (line: string): ClaudeEvent | null => {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isObject(parsed) || typeof parsed.type !== 'string') return null
  return trimEvent(parsed as ClaudeEvent)
}

/**
 * Detect whether the event stream represents a provider rate/spend-limit
 * rejection — the global environmental condition that must NOT consume a
 * task's single recovery slot.
 *
 * Detection: the Claude CLI emits a `rate_limit_event` with
 * `rate_limit_info.status === 'rejected'` before the final `result` event.
 * The `resetsAt` timestamp (Unix seconds) is read from that event; when it
 * is absent or zero we fall back to 0.
 *
 * Secondary signal: a `result` event with `is_error: true` and
 * `api_error_status: 429` alone (without a preceding `rate_limit_event`) is
 * also treated as a quota rejection with `resetsAt: 0`.
 *
 * Returns `null` when neither signal is present.
 */
export const extractQuotaRejected = (
  conversation: readonly ClaudeEvent[],
): { resetsAt: number } | null => {
  // Primary: scan for rate_limit_event with rejected status. Use the last
  // occurrence in case multiple appear (e.g. five_hour + monthly in one run).
  let latestResetsAt: number | null = null
  for (const event of conversation) {
    if (event.type === 'rate_limit_event') {
      const info = (event as { rate_limit_info?: unknown }).rate_limit_info
      if (isObject(info) && info.status === 'rejected') {
        const resetsAt =
          typeof info.resetsAt === 'number' && info.resetsAt > 0
            ? info.resetsAt
            : 0
        latestResetsAt = resetsAt
      }
    }
  }
  if (latestResetsAt !== null) return { resetsAt: latestResetsAt }

  // Secondary: result event with 429 status (no rate_limit_event seen).
  for (let i = conversation.length - 1; i >= 0; i--) {
    const event = conversation[i]
    if (
      event.type === 'result' &&
      (event as { is_error?: unknown }).is_error === true &&
      (event as { api_error_status?: unknown }).api_error_status === 429
    ) {
      return { resetsAt: 0 }
    }
  }

  return null
}

/**
 * Extract the last human-readable text from a Claude event stream.
 *
 * Priority:
 * 1. The final `result` event whose `result` field is a non-empty string.
 *    This carries the human-readable error message on API-level rejections
 *    (e.g. "You've hit your monthly spend limit.") and the summary on
 *    successful runs.
 * 2. The text content of the last `assistant` message event.
 *
 * Returns `null` when the conversation is empty or neither source has text.
 * Used as a fallback error label on nonzero exits with empty stderr.
 */
export const extractLastStreamText = (conversation: readonly ClaudeEvent[]): string | null => {
  // Prefer the final result event's result string.
  for (let i = conversation.length - 1; i >= 0; i--) {
    const event = conversation[i]
    if (event.type === 'result') {
      const text = typeof event.result === 'string' ? event.result.trim() : ''
      if (text.length > 0) return text
    }
  }
  // Fall back to the last assistant message's text content.
  for (let i = conversation.length - 1; i >= 0; i--) {
    const event = conversation[i]
    if (event.type === 'assistant') {
      const message = event.message
      if (isObject(message) && Array.isArray(message.content)) {
        for (let j = (message.content as unknown[]).length - 1; j >= 0; j--) {
          const block = (message.content as unknown[])[j]
          if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
            const text = block.text.trim()
            if (text.length > 0) return text
          }
        }
      }
    }
  }
  return null
}
