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

/**
 * How a provider's agent CLI reports token usage on its event stream. This is
 * a property of the PROVIDER, not of the run — reading a usage block without
 * knowing which of these applies is how the orchestrator ended up reporting
 * fabricated context sizes (e.g. `289216/50000`, ctx% above 300%).
 *
 *  'per-request' — every usage block describes the context of THAT request,
 *                  so the latest one IS current context occupancy. Claude Code
 *                  emits usage on every assistant event this way.
 *  'cumulative'  — the (single, terminal) usage block is total spend for the
 *                  whole turn. It says NOTHING about occupancy: it grows with
 *                  every tool round-trip and can exceed the context window
 *                  many times over. `codex exec --json` reports this way, on
 *                  its `turn.completed` event.
 *  'none'        — the provider emits no usage at all (gemini CLI).
 */
export type ProviderUsageSemantics = 'per-request' | 'cumulative' | 'none'

// Returns the input-side token count carried by the model on the LATEST
// assistant turn: input_tokens + cache_read_input_tokens +
// cache_creation_input_tokens. This is the current context size — how many
// tokens the model is actually holding — NOT the cumulative sum across all
// turns (which double-counts the context on every turn and grows without
// bound). Returns 0 when no assistant event has been seen yet.
//
// ONLY valid for a 'per-request' provider. Calling this on a 'cumulative'
// provider's stream yields nonsense; use getCumulativeTokenSpend instead.
//
// Deliberately assistant-only. Falling through to the terminal `result`
// event picked up Codex's turn.completed usage — which is cumulative turn
// SPEND — and reported it as occupancy; that is the source of the
// `289216/50000` readouts and the ctx% figures above 300%.
export const getLatestContextSize = (events: readonly ClaudeEvent[]): number => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'assistant') continue
    const message = event.message
    if (!isObject(message)) continue
    const usage = message.usage
    if (!isObject(usage)) continue
    return (
      numberOr(usage.input_tokens) +
      numberOr(usage.cache_read_input_tokens) +
      numberOr(usage.cache_creation_input_tokens)
    )
  }
  return 0
}

// Returns total token SPEND for the run as reported by a 'cumulative'
// provider: the usage block on the terminal result event, summed across every
// token bucket it names (both the codex `cached_input_tokens` spelling and the
// Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`
// spellings are accepted so the helper is not tied to one wire format).
//
// This is money spent, NOT context occupancy — it must never be compared
// against a context window. Returns 0 when no result event carries usage.
export const getCumulativeTokenSpend = (events: readonly ClaudeEvent[]): number => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'result') continue
    const usage = event.usage
    if (!isObject(usage)) continue
    return (
      numberOr(usage.input_tokens) +
      numberOr(usage.cached_input_tokens) +
      numberOr(usage.cache_read_input_tokens) +
      numberOr(usage.cache_creation_input_tokens) +
      numberOr(usage.output_tokens) +
      numberOr(usage.reasoning_output_tokens)
    )
  }
  return 0
}

/**
 * Token signals attached to a step_ended payload. The two fields are mutually
 * exclusive by construction, and which one is present is decided by the
 * provider's usage semantics:
 *
 *   contextTokens    — current context occupancy. Present ONLY for a
 *                      'per-request' provider. Consumers may divide it by a
 *                      context window (that is what `ctx%` does).
 *   cumulativeTokens — total token spend for the run. Present ONLY for a
 *                      'cumulative' provider. It is NOT occupancy; nothing may
 *                      compare it against a context window.
 *
 * A 'none' provider gets neither field, so `ctx%` correctly reports nothing
 * rather than a fabricated 0%.
 */
export interface ContextTokenSignals {
  contextTokens?: number
  cumulativeTokens?: number
}

export const buildContextTokenSignals = (
  semantics: ProviderUsageSemantics,
  events: readonly ClaudeEvent[],
): ContextTokenSignals => {
  switch (semantics) {
    case 'per-request':
      return { contextTokens: getLatestContextSize(events) }
    case 'cumulative':
      return { cumulativeTokens: getCumulativeTokenSpend(events) }
    case 'none':
      return {}
  }
}
