import type { AgentEvent } from './claude-stream'

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

export const summarizeUsage = (events: readonly AgentEvent[]): UsageTotals => {
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
export const getLatestContextSize = (events: readonly AgentEvent[]): number => {
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
export const extractCumulativeUsage = (events: readonly AgentEvent[]): UsageTotals => {
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
export const getCumulativeTokenSpend = (events: readonly AgentEvent[]): number => {
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
  events: readonly AgentEvent[],
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
  events: readonly AgentEvent[],
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

// ============================================================
// Usage blob: independent context + limits sub-structures
// ============================================================

/**
 * How a provider's rate-limit windows should be merged when a new report
 * arrives. Declared on the provider descriptor so the merge function never
 * branches on a provider name — a new provider is addable by declaring its
 * strategy here with no edit to the merge code.
 *
 *   'upsert-by-id' — Claude: each report carries one window at a time;
 *                    merge by id so a run that sees N different window ids
 *                    accumulates all N rather than replacing the set.
 *   'replace'      — Codex: each report is a full snapshot; replace the
 *                    existing set wholesale so a window absent from the
 *                    latest snapshot is removed rather than left as stale.
 *   'none'         — Gemini: no rate-limit data is emitted; leave the
 *                    window set untouched.
 */
export type WindowMergeStrategy = 'upsert-by-id' | 'replace' | 'none'

/** One provider rate-limit window as reported on the event stream. */
export interface UsageLimitWindow {
  id: string
  label: string
  /** Fraction of the limit consumed, in [0, 100]. */
  usedPct: number
  /** ISO-8601 UTC reset time, or null when the provider does not report it. */
  resetsAt: string | null
}

export interface UsageLimitCredits {
  unit: string
  remaining: number
}

/**
 * Account-level rate limits sub-structure.
 * Refreshed only when the provider reports a change; never clobbered by a
 * context-only update.
 */
export interface UsageLimits {
  readonly windows: ReadonlyArray<UsageLimitWindow>
  readonly credits?: UsageLimitCredits
}

/**
 * Per-conversation context fill sub-structure.
 * Refreshed on every assistant message; never clobbered by a limits-only
 * update.
 *
 *   usedTokens — current context size (input + cache buckets).
 *   maxTokens  — context-window ceiling reported by the provider, or null
 *                when not reported.
 *   costUsd    — accumulated run cost in USD as reported by the provider,
 *                or null when not reported.
 */
export interface UsageContext {
  usedTokens: number
  maxTokens: number | null
  costUsd: number | null
}

/** The merged usage blob that callers read. */
export interface UsageBlob {
  context: UsageContext
  limits: UsageLimits
  /** ISO-8601 UTC timestamp of the most-recent update (context OR limits). */
  updatedAt: string
}

/**
 * Mutable state object that holds context and limits independently.
 *
 * Two rules enforced by construction:
 *   1. A context-only update never clobbers last-known limits.
 *   2. A limits-only update never clobbers last-known context.
 *
 * Create one per run via {@link createUsageBlobState} with the provider's
 * declared {@link WindowMergeStrategy}.
 */
export interface UsageBlobState {
  /** Returns the merged blob, or null if nothing has been recorded yet. */
  getBlob(): UsageBlob | null
  /** Overwrite the context half. Does not touch the limits half. */
  updateContext(ctx: UsageContext): void
  /**
   * Merge incoming limits into the limits half using the strategy declared
   * at construction. Does not touch the context half.
   */
  updateLimits(incoming: UsageLimits): void
}

/**
 * Create a {@link UsageBlobState} that enforces independent refresh of
 * context and limits, with window merging driven by the provider's declared
 * strategy so the merge code never branches on a provider name.
 */
export const createUsageBlobState = (strategy: WindowMergeStrategy): UsageBlobState => {
  let context: UsageContext | null = null
  let storedWindows: UsageLimitWindow[] = []
  let storedCredits: UsageLimitCredits | undefined = undefined
  let updatedAt: string | null = null

  const touch = (): void => {
    updatedAt = new Date().toISOString()
  }

  return {
    getBlob(): UsageBlob | null {
      if (context === null && storedWindows.length === 0) return null
      return {
        context: context ?? { usedTokens: 0, maxTokens: null, costUsd: null },
        limits: { windows: storedWindows, credits: storedCredits },
        updatedAt: updatedAt ?? new Date().toISOString(),
      }
    },
    updateContext(ctx: UsageContext): void {
      context = ctx
      touch()
    },
    updateLimits(incoming: UsageLimits): void {
      switch (strategy) {
        case 'upsert-by-id': {
          // Each Claude report carries one window; merge by id so N distinct
          // windows accumulate rather than each report replacing the whole set.
          const map = new Map(storedWindows.map((w) => [w.id, w]))
          for (const w of incoming.windows) {
            map.set(w.id, w)
          }
          storedWindows = [...map.values()]
          break
        }
        case 'replace':
          // Codex reports a full snapshot; replace wholesale so a vanished
          // window is removed rather than left as stale data.
          storedWindows = [...incoming.windows]
          break
        case 'none':
          // Gemini emits no rate-limit data; leave the window set untouched.
          break
      }
      if (incoming.credits !== undefined) {
        storedCredits = incoming.credits
      }
      touch()
    },
  }
}

/**
 * Extract a {@link UsageContext} from a single stream event (in-band,
 * no I/O). Returns null for non-assistant events or events with no usage
 * block. Defensive: malformed fields degrade to 0 / null, never throw.
 *
 * `context` is refreshed on every assistant message so a long run shows live
 * fill rather than landing a single update when the turn completes.
 */
export const extractContextFromEvent = (event: AgentEvent): UsageContext | null => {
  if (event.type !== 'assistant') return null
  const message = event.message
  if (!isObject(message)) return null
  const usage = message.usage
  if (!isObject(usage)) return null
  const usedTokens =
    numberOr(usage.input_tokens) +
    numberOr(usage.cache_read_input_tokens) +
    numberOr(usage.cache_creation_input_tokens)
  const maxTokens =
    typeof usage.context_window === 'number' && Number.isFinite(usage.context_window)
      ? (usage.context_window as number)
      : null
  const costUsd =
    typeof usage.cost_usd === 'number' && Number.isFinite(usage.cost_usd)
      ? (usage.cost_usd as number)
      : null
  return { usedTokens, maxTokens, costUsd }
}

/**
 * Extract {@link UsageLimits} from a `rate_limits` stream event (in-band,
 * no I/O). Returns null for any other event type. Defensive: malformed
 * window entries are skipped; missing fields default to 0 / null / undefined
 * — never throws into the run loop.
 *
 * Expected event shape (emitted by provider adapters when they detect a
 * rate-limit change, e.g. via a response header):
 *   { type: 'rate_limits',
 *     windows: [{ id, label, usedPct, resetsAt }],
 *     credits?: { unit, remaining } }
 *
 * `limits` is only updated when this event type is seen, so a run that never
 * triggers a rate-limit report leaves the previous limits intact.
 */
export const extractLimitsFromEvent = (event: AgentEvent): UsageLimits | null => {
  if (event.type !== 'rate_limits') return null
  const parsedWindows: UsageLimitWindow[] = []
  if (Array.isArray(event.windows)) {
    for (const w of event.windows) {
      if (!isObject(w)) continue
      const id = typeof w.id === 'string' ? w.id : null
      const label = typeof w.label === 'string' ? w.label : null
      if (id === null || label === null) continue
      const usedPct =
        typeof w.usedPct === 'number' && Number.isFinite(w.usedPct) ? w.usedPct : 0
      const resetsAt = typeof w.resetsAt === 'string' ? w.resetsAt : null
      parsedWindows.push({ id, label, usedPct, resetsAt })
    }
  }
  let parsedCredits: UsageLimitCredits | undefined
  if (isObject(event.credits)) {
    const unit = typeof event.credits.unit === 'string' ? event.credits.unit : null
    const remaining =
      typeof event.credits.remaining === 'number' && Number.isFinite(event.credits.remaining)
        ? event.credits.remaining
        : null
    if (unit !== null && remaining !== null) {
      parsedCredits = { unit, remaining }
    }
  }
  return { windows: parsedWindows, credits: parsedCredits }
}
