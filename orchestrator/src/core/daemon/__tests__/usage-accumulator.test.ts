import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCUMULATOR_STATE_KEY,
  getAccumulatedTotals,
  recordUsageEvent,
  resetAccumulatedTotals,
} from '../usage-accumulator.js'
import type { ClaudeEvent } from '../../lib/claude-stream.js'

const ZERO = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
}

describe('usage-accumulator', () => {
  afterEach(() => {
    resetAccumulatedTotals()
  })

  it('starts at zero', () => {
    expect(getAccumulatedTotals()).toEqual(ZERO)
  })

  it('accumulates tokens from assistant events on a per-request provider', () => {
    recordUsageEvent(
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 10,
          },
        },
      } as unknown as ClaudeEvent,
      'per-request',
    )

    expect(getAccumulatedTotals()).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreateTokens: 200,
      cacheReadTokens: 10,
    })
  })

  it('sums across multiple events', () => {
    const makeEvent = (input: number, output: number) => ({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as ClaudeEvent)

    recordUsageEvent(makeEvent(100, 50), 'per-request')
    recordUsageEvent(makeEvent(200, 75), 'per-request')

    const totals = getAccumulatedTotals()
    expect(totals.inputTokens).toBe(300)
    expect(totals.outputTokens).toBe(125)
  })

  it('ignores non-assistant events', () => {
    recordUsageEvent(
      { type: 'tool_use', id: 'x', name: 'Bash', input: {} } as unknown as ClaudeEvent,
      'per-request',
    )

    expect(getAccumulatedTotals()).toEqual(ZERO)
  })

  it('ignores events with missing usage block', () => {
    recordUsageEvent(
      { type: 'assistant', message: { content: [] } } as unknown as ClaudeEvent,
      'per-request',
    )

    expect(getAccumulatedTotals()).toEqual(ZERO)
  })

  // ── cumulative providers (codex — the default Worker provider) ─────────────

  it('records the terminal turn.completed usage of a cumulative provider', () => {
    // THE zero-row defect: under codex the assistant events carry only text,
    // so an assistant-only accumulator wrote `{0,0,0,0}` into usage_snapshots
    // once a minute forever, and the dispatch spend-control probe read it as
    // "no spend at all". Shape is a real codex-cli 0.145.0 turn.completed.
    recordUsageEvent(
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      } as unknown as ClaudeEvent,
      'cumulative',
    )
    recordUsageEvent(
      {
        type: 'result',
        is_error: false,
        usage: {
          input_tokens: 31_864,
          cached_input_tokens: 25_088,
          cache_write_input_tokens: 0,
          output_tokens: 118,
          reasoning_output_tokens: 0,
        },
      } as unknown as ClaudeEvent,
      'cumulative',
    )

    expect(getAccumulatedTotals()).toEqual({
      // input_tokens INCLUDES cached_input_tokens on the codex wire format, so
      // the cached share is carved out rather than counted twice.
      inputTokens: 6_776,
      outputTokens: 118,
      cacheCreateTokens: 0,
      cacheReadTokens: 25_088,
    })
  })

  it('does NOT count a result event for a per-request provider', () => {
    // Claude restates run totals on its terminal result event on top of the
    // per-turn assistant blocks. Counting both would double every Claude run.
    recordUsageEvent(
      {
        type: 'assistant',
        message: { usage: { input_tokens: 100, output_tokens: 50 } },
      } as unknown as ClaudeEvent,
      'per-request',
    )
    recordUsageEvent(
      {
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 },
      } as unknown as ClaudeEvent,
      'per-request',
    )

    expect(getAccumulatedTotals()).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('records nothing for a provider that reports no usage', () => {
    recordUsageEvent(
      {
        type: 'result',
        usage: { input_tokens: 100, output_tokens: 50 },
      } as unknown as ClaudeEvent,
      'none',
    )
    expect(getAccumulatedTotals()).toEqual(ZERO)
  })
})

// ── the defect that made this table all-zero in production ──────────────────
//
// The writer (runWorkerWithSpan, reached from the CommonJS user-workflow graph)
// and the reader (usage-sampler, reached from the daemon's ESM graph) do not
// share a module instance. Module-scoped `let` counters therefore existed
// twice: the workflow incremented one copy, the sampler read the other, and
// `usage_snapshots` recorded 0/0 for every run while real Codex usage
// (input_tokens: 933252 on one observed run) streamed past.
//
// These tests fail against module-scoped state and pass against the
// globalThis-keyed state.
describe('accumulator state survives a second module instantiation', () => {
  afterEach(() => {
    resetAccumulatedTotals()
    vi.resetModules()
  })

  it('a freshly re-evaluated copy of the module sees tokens the first copy recorded', async () => {
    resetAccumulatedTotals()
    recordUsageEvent(
      {
        type: 'result',
        is_error: false,
        usage: { input_tokens: 31_864, cached_input_tokens: 25_088, output_tokens: 118 },
      } as unknown as ClaudeEvent,
      'cumulative',
    )

    // Force a second, independent evaluation of the module — the same thing
    // that happens when one graph loads it as CJS and another as ESM.
    vi.resetModules()
    const secondInstance = await import('../usage-accumulator.js')

    expect(secondInstance.getAccumulatedTotals()).toEqual({
      inputTokens: 6_776,
      outputTokens: 118,
      cacheCreateTokens: 0,
      cacheReadTokens: 25_088,
    })
  })

  it('writes made through a second instance are visible to the first', async () => {
    resetAccumulatedTotals()
    vi.resetModules()
    const secondInstance = await import('../usage-accumulator.js')

    secondInstance.recordUsageEvent(
      {
        type: 'result',
        is_error: false,
        usage: { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 40 },
      } as unknown as ClaudeEvent,
      'cumulative',
    )

    // The sampler reads through the ORIGINAL instance.
    expect(getAccumulatedTotals().inputTokens).toBe(1_000)
    expect(getAccumulatedTotals().outputTokens).toBe(40)
  })

  it('keeps its counters on a process-global slot, not in module scope', () => {
    resetAccumulatedTotals()
    recordUsageEvent(
      {
        type: 'assistant',
        message: { usage: { input_tokens: 7, output_tokens: 3 } },
      } as unknown as ClaudeEvent,
      'per-request',
    )
    const slot = (globalThis as Record<symbol, unknown>)[ACCUMULATOR_STATE_KEY]
    expect(slot).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  })
})
