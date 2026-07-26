import type { ChatMessage } from '@/shared/schemas'

/** Mars task-id pattern: "mars-" followed by at least 8 lowercase hex chars. */
const TASK_ID_RE = /\bmars-[a-f0-9]{8,}\b/g

/** Coerce an unknown value to a plain string for regex matching. */
const toText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Best-effort pure parser: extract task IDs created during a chat thread.
 *
 * Scans `tool_use` segments whose input mentions "mars task add" and collects
 * any task-ID–shaped strings (`mars-[0-9a-f]{8,}`) from those segments'
 * result fields. Returns unique IDs in discovery order.
 */
export function parseCreatedTaskIds(messages: ChatMessage[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const msg of messages) {
    for (const seg of msg.segments) {
      if (seg.type !== 'tool_use') continue
      const inputText = toText(seg.input)
      if (!inputText.includes('mars task add')) continue
      const resultText = toText(seg.result)
      for (const match of resultText.matchAll(TASK_ID_RE)) {
        const id = match[0]
        if (!seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
      }
    }
  }
  return ids
}
