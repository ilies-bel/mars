interface ClaudeStreamEvent {
  type?: unknown
  subtype?: unknown
  result?: unknown
  is_error?: unknown
  message?: { content?: unknown }
}

const extractJsonObject = (raw: string): string | null => {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return raw.slice(start, end + 1)
}

const extractAssistantText = (event: ClaudeStreamEvent): string | null => {
  const content = event.message?.content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.length === 0 ? null : parts.join('')
}

const extractModelText = (claudeStdout: string): string => {
  const trimmed = claudeStdout.trim()
  if (!trimmed) throw new Error('claude returned empty output')

  // Stream-json: line-delimited JSON events. Walk lines and prefer the final
  // `result` event's `result` field; fall back to assistant text blocks.
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0)
  let resultText: string | null = null
  let assistantText: string | null = null

  for (const line of lines) {
    let event: ClaudeStreamEvent
    try {
      event = JSON.parse(line) as ClaudeStreamEvent
    } catch {
      continue
    }
    if (event.is_error) {
      throw new Error(`claude reported error: ${String(event.result ?? 'unknown')}`)
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      resultText = event.result
    } else if (event.type === 'assistant') {
      const t = extractAssistantText(event)
      if (t !== null) assistantText = t
    }
  }

  if (resultText !== null) return resultText
  if (assistantText !== null) return assistantText

  // Fallback: maybe it was a single-envelope (non-stream) response.
  try {
    const env = JSON.parse(trimmed) as ClaudeStreamEvent
    if (typeof env.result === 'string') return env.result
  } catch {
    // ignore
  }
  return trimmed
}

export const parseClaudeJsonResult = (claudeStdout: string): unknown => {
  const modelText = extractModelText(claudeStdout)
  const objectText = extractJsonObject(modelText) ?? modelText
  try {
    return JSON.parse(objectText)
  } catch (err) {
    throw new Error(
      `failed to parse claude JSON: ${(err as Error).message}\nraw: ${modelText.slice(0, 400)}`,
    )
  }
}
