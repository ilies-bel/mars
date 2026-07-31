import { afterEach, describe, expect, it } from 'vitest'
import {
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
