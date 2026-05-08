import type { ClaudeEvent } from './claude-stream'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  totalCostUsd: number
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
  totalCostUsd: 0,
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
      continue
    }
    if (event.type === 'result') {
      totals.totalCostUsd += numberOr(event.total_cost_usd)
    }
  }
  return totals
}
