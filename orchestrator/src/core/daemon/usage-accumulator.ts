/**
 * In-memory token accumulator for the daemon's spend meter.
 *
 * Records cumulative input and output token counts as provider events stream
 * in from running task sessions. The usage-sampler reads these totals on each
 * tick to write periodic snapshots into `usage_snapshots`, providing the
 * spend-control probe with real data.
 *
 * State survives across calls within a daemon process lifetime but resets to
 * zero on daemon restart. This is acceptable for the spend meter: the first
 * sampling interval after restart reflects only tokens accumulated since boot,
 * and subsequent intervals capture the full rolling picture as usage continues.
 *
 * ── Why the counters hang off `globalThis` and not module scope ─────────────
 *
 * The writer and the reader do NOT share a module instance, even though they
 * run in the same daemon process:
 *
 *   writer — `runWorkerWithSpan`, reached from a user workflow file
 *            (`.mars/workflows/task-workflow.js`). The repo-root package.json
 *            has no `"type": "module"`, so that file is CommonJS, and the whole
 *            graph it pulls in through `mars/workflow` — primitives →
 *            run-worker-with-span → this module — is instantiated in Node's
 *            **CJS registry**.
 *   reader — `startUsageSampler`, reached from `daemon/server.ts` via
 *            `await import('./usage-sampler')`. The orchestrator package IS
 *            `"type": "module"`, so that graph lives in the **ESM registry**.
 *
 * Node keeps one instantiation per registry, so module-level `let` counters
 * exist TWICE: the workflow increments one copy, the sampler reads the other,
 * and `usage_snapshots` records 0/0 forever while real usage flows past. That
 * is not hypothetical — it is the measured cause of the all-zero snapshot
 * table (see the regression test in __tests__/usage-accumulator.test.ts).
 * The workflow loader also cache-busts its import with `?v=<mtime>-<size>`,
 * which can mint further instances on reload.
 *
 * A `Symbol.for()` key on `globalThis` is registry- and cache-buster-proof:
 * every copy of this module, however it was resolved, reads and writes the one
 * per-process object. Do NOT "clean this up" back into module-scoped `let`s.
 */

import type { ClaudeEvent } from '../lib/claude-stream.js'
import { summarizeUsageForSemantics } from '../lib/claude-usage.js'
import type { ProviderUsageSemantics } from '../lib/claude-usage.js'

/** Cumulative token totals since daemon start (or last resetAccumulatedTotals). */
export interface AccumulatedTotals {
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
}

/**
 * Process-global slot shared by every instantiation of this module. Exported
 * so the regression test can assert the state really is registry-proof.
 */
export const ACCUMULATOR_STATE_KEY = Symbol.for('mars.daemon.usage-accumulator.totals')

const zeroTotals = (): AccumulatedTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
})

/** The one per-process totals object, created on first touch. */
const state = (): AccumulatedTotals => {
  const slot = globalThis as typeof globalThis & {
    [ACCUMULATOR_STATE_KEY]?: AccumulatedTotals
  }
  slot[ACCUMULATOR_STATE_KEY] ??= zeroTotals()
  return slot[ACCUMULATOR_STATE_KEY]
}

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
  const current = state()
  current.inputTokens += totals.inputTokens
  current.outputTokens += totals.outputTokens
  current.cacheCreateTokens += totals.cacheCreateTokens
  current.cacheReadTokens += totals.cacheReadTokens
}

/**
 * Return the cumulative token totals accumulated since daemon start (or since
 * the last call to {@link resetAccumulatedTotals}).
 *
 * Called by the usage sampler to write a snapshot on each tick.
 */
export function getAccumulatedTotals(): AccumulatedTotals {
  return { ...state() }
}

/**
 * Reset all counters to zero. **Test-only.** Production code never calls this
 * — the accumulator is meant to grow monotonically over the daemon's lifetime
 * so the usage-sampler always writes the correct cumulative total.
 */
export function resetAccumulatedTotals(): void {
  Object.assign(state(), zeroTotals())
}
