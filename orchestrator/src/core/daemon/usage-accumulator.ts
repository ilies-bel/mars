/**
 * In-memory token accumulator for the daemon's spend meter.
 *
 * Records cumulative input and output token counts as Claude events stream in
 * from running task sessions. The usage-sampler reads these totals on each
 * tick to write periodic snapshots into `usage_snapshots`, providing the
 * spend-control probe with real data.
 *
 * Module-level state survives across calls within a daemon process lifetime
 * but resets to zero on daemon restart. This is acceptable for the spend
 * meter: the first sampling interval after restart will reflect only tokens
 * accumulated since boot, and subsequent intervals will capture the full
 * rolling picture as usage continues.
 */

import type { ClaudeEvent } from '../lib/claude-stream.js'

/** Cumulative token totals since daemon start (or last resetAccumulatedTotals). */
let inputTokens = 0
let outputTokens = 0
let cacheCreateTokens = 0
let cacheReadTokens = 0

/** Whether `event.message` has the expected object shape. */
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const numberOr = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Record token usage from a single Claude event. No-ops for non-assistant
 * events or events whose `message.usage` block is absent or malformed.
 *
 * Called from the daemon's `onEvent` callback on every `claude-event`
 * emitted by a running coder session.
 */
export function recordClaudeEvent(event: ClaudeEvent): void {
  if (event.type !== 'assistant') return
  const message = (event as Record<string, unknown>).message
  if (!isObject(message)) return
  const usage = message.usage
  if (!isObject(usage)) return
  inputTokens += numberOr(usage.input_tokens)
  outputTokens += numberOr(usage.output_tokens)
  cacheCreateTokens += numberOr(usage.cache_creation_input_tokens)
  cacheReadTokens += numberOr(usage.cache_read_input_tokens)
}

/**
 * Return the cumulative token totals accumulated since daemon start (or since
 * the last call to {@link resetAccumulatedTotals}).
 *
 * Called by the usage sampler to write a snapshot on each tick.
 */
export function getAccumulatedTotals(): {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
} {
  return { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens }
}

/**
 * Reset all counters to zero. **Test-only.** Production code never calls this
 * — the accumulator is meant to grow monotonically over the daemon's lifetime
 * so the usage-sampler always writes the correct cumulative total.
 */
export function resetAccumulatedTotals(): void {
  inputTokens = 0
  outputTokens = 0
  cacheCreateTokens = 0
  cacheReadTokens = 0
}
