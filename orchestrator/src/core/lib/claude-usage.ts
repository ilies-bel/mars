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

/**
 * Decompose the usage block on the terminal result event of a 'cumulative'
 * provider into {@link UsageTotals}. Returns zeros (messageCount 0) when no
 * result event carries usage.
 *
 * Two wire formats are accepted, and they nest DIFFERENTLY — reading one with
 * the other's rules double-counts:
 *
 *   codex (`turn.completed`)  — `input_tokens` is the TOTAL prompt token count.
 *     `cached_input_tokens` and `cache_write_input_tokens` are SUBSETS of it
 *     describing how those input tokens were served (upstream codex derives
 *     `non_cached_input = input_tokens - cached_input_tokens` the same way),
 *     and `reasoning_output_tokens` is a subset of `output_tokens`.
 *     Verified against codex-cli 0.145.0: a real `codex exec --json` run
 *     reported `input_tokens: 31864, cached_input_tokens: 25088,
 *     cache_write_input_tokens: 0, output_tokens: 118`.
 *   Anthropic (`result`)      — `input_tokens` EXCLUDES the cache buckets;
 *     `cache_read_input_tokens` / `cache_creation_input_tokens` are additive.
 *
 * The codex spelling is detected by the presence of `cached_input_tokens` or
 * `cache_write_input_tokens`; the cache buckets are then carved OUT of
 * `inputTokens` so the four buckets stay disjoint and summing them (or
 * weighting them, as the spend meter does) never counts a token twice.
 */
export const extractCumulativeUsage = (events: readonly ClaudeEvent[]): UsageTotals => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'result') continue
    const usage = event.usage
    if (!isObject(usage)) continue
    const isCodexSpelling =
      'cached_input_tokens' in usage || 'cache_write_input_tokens' in usage
    const cacheReadTokens = isCodexSpelling
      ? numberOr(usage.cached_input_tokens)
      : numberOr(usage.cache_read_input_tokens)
    const cacheCreateTokens = isCodexSpelling
      ? numberOr(usage.cache_write_input_tokens)
      : numberOr(usage.cache_creation_input_tokens)
    const rawInput = numberOr(usage.input_tokens)
    return {
      inputTokens: isCodexSpelling
        ? Math.max(0, rawInput - cacheReadTokens - cacheCreateTokens)
        : rawInput,
      outputTokens: isCodexSpelling
        ? numberOr(usage.output_tokens)
        : numberOr(usage.output_tokens) + numberOr(usage.reasoning_output_tokens),
      cacheCreateTokens,
      cacheReadTokens,
      // One terminal usage block describes one completed run.
      messageCount: 1,
    }
  }
  return emptyUsageTotals()
}

// Returns total token SPEND for the run as reported by a 'cumulative'
// provider: every disjoint bucket of the terminal usage block, summed.
//
// This is money spent, NOT context occupancy — it must never be compared
// against a context window. Returns 0 when no result event carries usage.
export const getCumulativeTokenSpend = (events: readonly ClaudeEvent[]): number => {
  const totals = extractCumulativeUsage(events)
  return (
    totals.inputTokens +
    totals.outputTokens +
    totals.cacheCreateTokens +
    totals.cacheReadTokens
  )
}

/**
 * Token totals for a run, read the way the PROVIDER reports them.
 *
 * This is the one place that decides where usage lives on an event stream:
 * per-request providers carry it on every assistant event, cumulative
 * providers carry it once on the terminal result event, and a 'none' provider
 * carries none at all. Every consumer of run-level token counts (the spend
 * meter's step_ended signals, the daemon usage accumulator behind
 * `usage_snapshots`, reflect signals) must go through here — reading only the
 * assistant shape is what made every Codex run report zero tokens.
 */
export const summarizeUsageForSemantics = (
  semantics: ProviderUsageSemantics,
  events: readonly ClaudeEvent[],
): UsageTotals => {
  switch (semantics) {
    case 'per-request':
      return summarizeUsage(events)
    case 'cumulative':
      return extractCumulativeUsage(events)
    case 'none':
      return emptyUsageTotals()
  }
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

/**
 * Whether a run's `maxContextTokens` ceiling is actually armed IN-RUN, and if
 * not, why. Stamped on every worker span so "is the ceiling enforced?" is an
 * observable fact rather than an assumption:
 *
 *   'in-run-enforced'    — per-request provider: occupancy is observable on
 *                          every turn, so the run is warned at 80% and killed
 *                          at 100% of the budget.
 *   'in-run-inapplicable' — cumulative / no-usage provider: occupancy is NOT
 *                          observable at all (codex reports one cumulative
 *                          spend block, and only after the turn has ended), so
 *                          nothing can abort the run on occupancy. The budget
 *                          still gates the run on the INPUT side (pre-flight
 *                          prompt fit) and spend is still ceilinged after the
 *                          fact by the window/arc budgets.
 *   'disabled'            — the worker configures no budget at all.
 */
export type ContextGuardMode = 'in-run-enforced' | 'in-run-inapplicable' | 'disabled'

export const contextGuardMode = (
  semantics: ProviderUsageSemantics,
  maxContextTokens: number,
): ContextGuardMode => {
  if (!(maxContextTokens > 0)) return 'disabled'
  return semantics === 'per-request' ? 'in-run-enforced' : 'in-run-inapplicable'
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
