import type { ClaudeEvent } from './claude-stream'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  messageCount: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberOr = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export const emptyUsageTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  messageCount: 0,
})

export const summarizeUsage = (events: readonly ClaudeEvent[]): UsageTotals => {
  const totals = emptyUsageTotals()
  for (const event of events) {
    if (event.type === 'assistant') {
      const message = event.message
      if (!isObject(message)) continue
      const usage = message.usage
      if (!isObject(usage)) continue
      totals.inputTokens += numberOr(usage.input_tokens)
      totals.outputTokens += numberOr(usage.output_tokens)
      totals.cacheCreateTokens += numberOr(usage.cache_creation_input_tokens)
      totals.cacheReadTokens += numberOr(usage.cache_read_input_tokens)
      totals.messageCount += 1
    }
  }
  return totals
}

// Returns the input-side token count carried by the model on the LATEST
// assistant turn or terminal provider result: input_tokens +
// cache_read_input_tokens + cache_creation_input_tokens. This is the current
// context size — how many tokens the model is actually holding — NOT the
// cumulative sum across all turns (which double-counts the context on every
// turn and grows without bound). Codex reports usage on its terminal
// turn.completed event, normalized as a result event, rather than on its
// assistant messages.
export const getLatestContextSize = (events: readonly ClaudeEvent[]): number => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const usage =
      event.type === 'assistant' && isObject(event.message)
        ? event.message.usage
        : event.type === 'result'
          ? event.usage
          : undefined
    if (!isObject(usage)) continue
    return (
      numberOr(usage.input_tokens) +
      numberOr(usage.cache_read_input_tokens) +
      numberOr(usage.cache_creation_input_tokens)
    )
  }
  return 0
}
