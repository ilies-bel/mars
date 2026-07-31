/**
 * In-memory token accumulator for the daemon's spend meter.
 *
 * Records cumulative input and output token counts as provider events stream
 * in from running task sessions. The usage-sampler reads these totals on each
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
import { summarizeUsageForSemantics } from '../lib/claude-usage.js'
import type { ProviderUsageSemantics } from '../lib/claude-usage.js'

/** Cumulative token totals since daemon start (or last resetAccumulatedTotals). */
let inputTokens = 0
let outputTokens = 0
let cacheCreateTokens = 0
let cacheReadTokens = 0

/**
 * Record token usage from a single streamed provider event, read the way that
 * provider reports usage:
 *
 *   'per-request' — usage rides every assistant event (Claude Code). Each one
 *                   is added as it streams.
 *   'cumulative'  — usage rides ONE terminal result event and already covers
 *                   the whole run (`codex exec --json`'s `turn.completed`).
 *                   Adding it once is the complete spend for that run.
 *   'none'        — the provider reports nothing; nothing is recorded.
 *
 * The semantics argument is not optional decoration: reading only the
 * assistant shape is why `usage_snapshots` recorded a wall of zeros under the
 * default (Codex) provider, and blindly adding EVERY result event's usage
 * would double-count Claude, whose terminal result restates the run total on
 * top of the per-turn assistant blocks already counted.
 *
 * Called from `runWorkerWithSpan`'s event wrapper, which knows the Worker's
 * Provider and therefore its semantics.
 */
export function recordUsageEvent(
  event: ClaudeEvent,
  semantics: ProviderUsageSemantics,
): void {
  const totals = summarizeUsageForSemantics(semantics, [event])
  inputTokens += totals.inputTokens
  outputTokens += totals.outputTokens
  cacheCreateTokens += totals.cacheCreateTokens
  cacheReadTokens += totals.cacheReadTokens
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
