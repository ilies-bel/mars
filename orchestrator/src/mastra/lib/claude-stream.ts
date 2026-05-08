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
