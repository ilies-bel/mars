import { describe, expect, it } from 'vitest'
import {
  emptyUsageTotals,
  summarizeUsage,
  summarizeUsageForSemantics,
  getLatestContextSize,
  getCumulativeTokenSpend,
  extractCumulativeUsage,
  buildContextTokenSignals,
  contextGuardMode,
} from '../claude-usage'
import type { ClaudeEvent } from '../claude-stream'

const assistant = (usage: Record<string, unknown>): ClaudeEvent => ({
  type: 'assistant',
  message: { usage, content: [] },
})

const assistantWithContext = (
  input: number,
  cacheRead = 0,
  cacheCreate = 0,
): ClaudeEvent => ({
  type: 'assistant',
  message: {
    usage: {
      input_tokens: input,
      output_tokens: 10,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
    },
    content: [],
  },
})

describe('UsageTotals shape', () => {
  it('carries no key matching /usd/i or /cost/i', () => {
    const keys = Object.keys(emptyUsageTotals())
    for (const key of keys) {
      expect(key).not.toMatch(/usd/i)
      expect(key).not.toMatch(/cost/i)
    }
  })

  it('summarizeUsage result carries no key matching /usd/i or /cost/i', () => {
    const keys = Object.keys(summarizeUsage([]))
    for (const key of keys) {
      expect(key).not.toMatch(/usd/i)
      expect(key).not.toMatch(/cost/i)
    }
  })
})

describe('summarizeUsage', () => {
  it('returns zeros for empty input', () => {
    expect(summarizeUsage([])).toEqual(emptyUsageTotals())
  })

  it('sums input/output tokens across assistant events', () => {
    const totals = summarizeUsage([
      assistant({ input_tokens: 100, output_tokens: 25 }),
      assistant({ input_tokens: 50, output_tokens: 12 }),
    ])
    expect(totals.inputTokens).toBe(150)
    expect(totals.outputTokens).toBe(37)
    expect(totals.messageCount).toBe(2)
  })

  it('keeps cache_creation and cache_read separate from input', () => {
    const totals = summarizeUsage([
      assistant({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 200,
      }),
    ])
    expect(totals.inputTokens).toBe(10)
    expect(totals.cacheCreateTokens).toBe(1000)
    expect(totals.cacheReadTokens).toBe(200)
  })

  it('treats missing usage fields as zero', () => {
    const totals = summarizeUsage([
      assistant({}),
      { type: 'assistant', message: {} },
      { type: 'assistant' },
    ])
    expect(totals).toEqual({ ...emptyUsageTotals(), messageCount: 1 })
  })

  it('ignores unrelated event types', () => {
    const totals = summarizeUsage([
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { content: [] } },
      { type: 'tool_use', input: {} },
    ])
    expect(totals).toEqual(emptyUsageTotals())
  })

  it('handles a timeout-truncated conversation gracefully', () => {
    const totals = summarizeUsage([
      assistant({ input_tokens: 200, output_tokens: 50 }),
    ])
    expect(totals.inputTokens).toBe(200)
    expect(totals.outputTokens).toBe(50)
  })

  it('rejects non-finite or non-number usage values', () => {
    const totals = summarizeUsage([
      assistant({
        input_tokens: 'oops',
        output_tokens: Number.NaN,
        cache_read_input_tokens: Number.POSITIVE_INFINITY,
      }),
    ])
    expect(totals.inputTokens).toBe(0)
    expect(totals.outputTokens).toBe(0)
    expect(totals.cacheReadTokens).toBe(0)
    expect(totals.messageCount).toBe(1)
  })
})

describe('getLatestContextSize', () => {
  it('returns 0 for an empty event list', () => {
    expect(getLatestContextSize([])).toBe(0)
  })

  it('returns 0 when no assistant events are present', () => {
    const events: ClaudeEvent[] = [
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { content: [] } },
    ]
    expect(getLatestContextSize(events)).toBe(0)
  })

  it('IGNORES a Codex turn.completed usage block — that is spend, not occupancy', () => {
    // This assertion is deliberately the inverse of what it used to be. Reading
    // the terminal result event as context size is the defect: Codex reports
    // usage once, on turn.completed, as CUMULATIVE spend for the whole turn.
    // Treating it as occupancy produced `289216/50000` and ctx% above 300%,
    // and tripped context-overflow handling on runs nowhere near a limit.
    // Cumulative spend is read by getCumulativeTokenSpend instead.
    const events: ClaudeEvent[] = [
      { type: 'assistant', message: { content: [] } },
      {
        type: 'result',
        usage: {
          input_tokens: 180_000,
          cache_read_input_tokens: 2_000,
          cache_creation_input_tokens: 500,
        },
      },
    ]

    expect(getLatestContextSize(events)).toBe(0)
    // Anthropic spelling: input_tokens EXCLUDES the cache buckets, so they add.
    expect(getCumulativeTokenSpend(events)).toBe(182_500)
  })

  it('returns input_tokens alone when no cache tokens are present', () => {
    expect(getLatestContextSize([assistantWithContext(500)])).toBe(500)
  })

  it('sums input + cache_read + cache_creation from the latest assistant event', () => {
    expect(getLatestContextSize([assistantWithContext(1000, 200, 50)])).toBe(1250)
  })

  it('returns the LATEST assistant event, not a cumulative sum', () => {
    // Cumulative would be 100 + 500 = 600; latest is 500.
    const events: ClaudeEvent[] = [
      assistantWithContext(100),
      assistantWithContext(500),
    ]
    expect(getLatestContextSize(events)).toBe(500)
  })

  it('skips non-assistant events after the latest assistant event', () => {
    const events: ClaudeEvent[] = [
      assistantWithContext(300),
      { type: 'user', message: { content: [] } },
      { type: 'system', subtype: 'init' },
    ]
    expect(getLatestContextSize(events)).toBe(300)
  })

  it('treats missing usage fields as zero in the latest event', () => {
    const events: ClaudeEvent[] = [
      assistantWithContext(1000),
      { type: 'assistant', message: {} },
    ]
    // Latest assistant event has no usage object — skip it, use previous.
    // (isObject guard on message.usage fails, so we continue to the prior event.)
    expect(getLatestContextSize(events)).toBe(1000)
  })

  it('does not double-count context across turns (cumulative vs latest contrast)', () => {
    // With 3 turns, cumulative input would be 100+200+300=600.
    // Latest context size is just 300 (what the model currently holds).
    const events: ClaudeEvent[] = [
      assistantWithContext(100),
      assistantWithContext(200),
      assistantWithContext(300),
    ]
    expect(getLatestContextSize(events)).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// Provider-aware usage semantics
// ---------------------------------------------------------------------------

// A `codex exec --json` turn.completed event as parseCodexEventLine normalises
// it: a single result event whose usage is CUMULATIVE spend for the whole turn.
const codexTurnCompleted = (usage: Record<string, unknown>): ClaudeEvent => ({
  type: 'result',
  is_error: false,
  usage,
})

describe('getCumulativeTokenSpend', () => {
  it('returns 0 when no result event carries usage', () => {
    expect(getCumulativeTokenSpend([])).toBe(0)
    expect(getCumulativeTokenSpend([assistantWithContext(500)])).toBe(0)
    expect(getCumulativeTokenSpend([{ type: 'result', is_error: false }])).toBe(0)
  })

  it('does not double-count codex cached input, which is a SUBSET of input_tokens', () => {
    // codex reports `input_tokens` as the TOTAL prompt token count and
    // `cached_input_tokens` as the share of it served from cache (upstream
    // codex derives non_cached_input = input_tokens - cached_input_tokens the
    // same way). Adding both inflates every codex run's spend.
    const events: ClaudeEvent[] = [
      codexTurnCompleted({
        input_tokens: 200_000,
        cached_input_tokens: 80_000,
        output_tokens: 9_216,
      }),
    ]
    expect(getCumulativeTokenSpend(events)).toBe(209_216)
  })

  it('carves cached and cache-write out of codex input so the buckets stay disjoint', () => {
    // Shape captured from a real codex-cli 0.145.0 `codex exec --json` run.
    const totals = extractCumulativeUsage([
      codexTurnCompleted({
        input_tokens: 31_864,
        cached_input_tokens: 25_088,
        cache_write_input_tokens: 0,
        output_tokens: 118,
        reasoning_output_tokens: 0,
      }),
    ])
    expect(totals).toEqual({
      inputTokens: 6_776,
      outputTokens: 118,
      cacheCreateTokens: 0,
      cacheReadTokens: 25_088,
      messageCount: 1,
    })
  })

  it('treats codex reasoning_output_tokens as part of output_tokens, not an addition', () => {
    const totals = extractCumulativeUsage([
      codexTurnCompleted({
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 40,
        reasoning_output_tokens: 30,
      }),
    ])
    expect(totals.outputTokens).toBe(40)
  })

  it('returns empty totals when no result event carries usage', () => {
    expect(extractCumulativeUsage([])).toEqual(emptyUsageTotals())
    expect(extractCumulativeUsage([assistantWithContext(500)])).toEqual(emptyUsageTotals())
  })

  it('also accepts the Anthropic cache_* spelling', () => {
    const events: ClaudeEvent[] = [
      codexTurnCompleted({
        input_tokens: 100,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 10,
      }),
    ]
    expect(getCumulativeTokenSpend(events)).toBe(135)
  })

  it('reads the LATEST result event', () => {
    const events: ClaudeEvent[] = [
      codexTurnCompleted({ input_tokens: 10 }),
      codexTurnCompleted({ input_tokens: 40 }),
    ]
    expect(getCumulativeTokenSpend(events)).toBe(40)
  })
})

describe('buildContextTokenSignals', () => {
  it('per-request provider reports contextTokens (occupancy) and nothing else', () => {
    const signals = buildContextTokenSignals('per-request', [
      assistantWithContext(100),
      assistantWithContext(300),
    ])
    expect(signals).toEqual({ contextTokens: 300 })
    expect(signals.cumulativeTokens).toBeUndefined()
  })

  it('cumulative provider reports cumulativeTokens and NEVER contextTokens', () => {
    // The bug this guards: 289,216 cumulative codex tokens were reported as a
    // context size against a 50,000-token budget (`289216/50000`), tripping
    // context-overflow handling on a run that had overflowed nothing.
    const signals = buildContextTokenSignals('cumulative', [
      codexTurnCompleted({
        input_tokens: 200_000,
        cached_input_tokens: 80_000,
        output_tokens: 9_216,
      }),
    ])
    expect(signals).toEqual({ cumulativeTokens: 209_216 })
    expect(signals.contextTokens).toBeUndefined()
  })

  it('a provider reporting no usage gets neither field', () => {
    expect(buildContextTokenSignals('none', [assistantWithContext(300)])).toEqual({})
  })
})

describe('summarizeUsageForSemantics', () => {
  it('reads assistant events for a per-request provider', () => {
    const totals = summarizeUsageForSemantics('per-request', [
      assistant({ input_tokens: 100, output_tokens: 25 }),
      assistant({ input_tokens: 50, output_tokens: 12 }),
    ])
    expect(totals.inputTokens).toBe(150)
    expect(totals.outputTokens).toBe(37)
    expect(totals.messageCount).toBe(2)
  })

  it('reads the terminal result event for a cumulative provider', () => {
    // The codex conversation: assistant events carry TEXT ONLY. Reading them
    // (as every caller did before) is where `usage_snapshots`'s wall of zeros
    // came from.
    const totals = summarizeUsageForSemantics('cumulative', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
      codexTurnCompleted({
        input_tokens: 31_864,
        cached_input_tokens: 25_088,
        output_tokens: 118,
      }),
    ])
    expect(totals.inputTokens).toBe(6_776)
    expect(totals.cacheReadTokens).toBe(25_088)
    expect(totals.outputTokens).toBe(118)
  })

  it('never counts a result event for a per-request provider (no double count)', () => {
    const totals = summarizeUsageForSemantics('per-request', [
      assistant({ input_tokens: 100, output_tokens: 25 }),
      { type: 'result', usage: { input_tokens: 100, output_tokens: 25 } },
    ])
    expect(totals.inputTokens).toBe(100)
    expect(totals.outputTokens).toBe(25)
  })

  it('returns zeros for a provider that reports no usage', () => {
    expect(
      summarizeUsageForSemantics('none', [assistant({ input_tokens: 10, output_tokens: 5 })]),
    ).toEqual(emptyUsageTotals())
  })
})

describe('contextGuardMode', () => {
  it('arms the in-run ceiling only for a per-request provider', () => {
    expect(contextGuardMode('per-request', 200_000)).toBe('in-run-enforced')
  })

  it('declares the in-run ceiling INAPPLICABLE for a cumulative provider', () => {
    // Not "enforced" and not silently "disabled": codex cannot report
    // occupancy at all, so an operator must be able to see that no mid-run
    // ceiling exists rather than assume the configured budget is armed.
    expect(contextGuardMode('cumulative', 200_000)).toBe('in-run-inapplicable')
    expect(contextGuardMode('none', 200_000)).toBe('in-run-inapplicable')
  })

  it('reports disabled when the worker configures no budget', () => {
    expect(contextGuardMode('per-request', 0)).toBe('disabled')
    expect(contextGuardMode('cumulative', 0)).toBe('disabled')
  })
})
