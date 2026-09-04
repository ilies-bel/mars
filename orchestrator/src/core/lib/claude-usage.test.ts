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
  createUsageBlobState,
  extractContextFromEvent,
  extractLimitsFromEvent,
} from './claude-usage'
import type { AgentEvent } from './claude-stream'

const assistant = (usage: Record<string, unknown>): AgentEvent => ({
  type: 'assistant',
  message: { usage, content: [] },
})

const assistantWithContext = (
  input: number,
  cacheRead = 0,
  cacheCreate = 0,
): AgentEvent => ({
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
    const events: AgentEvent[] = [
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
    const events: AgentEvent[] = [
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
    const events: AgentEvent[] = [
      assistantWithContext(100),
      assistantWithContext(500),
    ]
    expect(getLatestContextSize(events)).toBe(500)
  })

  it('skips non-assistant events after the latest assistant event', () => {
    const events: AgentEvent[] = [
      assistantWithContext(300),
      { type: 'user', message: { content: [] } },
      { type: 'system', subtype: 'init' },
    ]
    expect(getLatestContextSize(events)).toBe(300)
  })

  it('treats missing usage fields as zero in the latest event', () => {
    const events: AgentEvent[] = [
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
    const events: AgentEvent[] = [
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
const codexTurnCompleted = (usage: Record<string, unknown>): AgentEvent => ({
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
    const events: AgentEvent[] = [
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
    const events: AgentEvent[] = [
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
    const events: AgentEvent[] = [
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

// ============================================================
// Usage blob split: independent context + limits refresh
// ============================================================

describe('createUsageBlobState', () => {
  it('returns null when nothing has been set', () => {
    expect(createUsageBlobState('replace').getBlob()).toBeNull()
    expect(createUsageBlobState('upsert-by-id').getBlob()).toBeNull()
    expect(createUsageBlobState('none').getBlob()).toBeNull()
  })

  it('a context-only update leaves previously-recorded limits intact', () => {
    const state = createUsageBlobState('upsert-by-id')
    state.updateLimits({
      windows: [{ id: 'w1', label: 'Requests', usedPct: 42, resetsAt: null }],
    })
    state.updateContext({ usedTokens: 1000, maxTokens: 200_000, costUsd: null })
    const blob = state.getBlob()
    // The limits update must survive the subsequent context update.
    expect(blob?.limits.windows).toHaveLength(1)
    expect(blob?.limits.windows[0].id).toBe('w1')
    expect(blob?.context.usedTokens).toBe(1000)
  })

  it('a limits-only update leaves the previously-recorded context intact', () => {
    const state = createUsageBlobState('replace')
    state.updateContext({ usedTokens: 5000, maxTokens: null, costUsd: 0.05 })
    state.updateLimits({
      windows: [{ id: 'tokens', label: 'Token limit', usedPct: 80, resetsAt: null }],
    })
    const blob = state.getBlob()
    // The context must survive the subsequent limits update.
    expect(blob?.context.usedTokens).toBe(5000)
    expect(blob?.context.costUsd).toBe(0.05)
    expect(blob?.limits.windows).toHaveLength(1)
  })

  it('upsert-by-id: two single-window reports yield TWO windows', () => {
    // Claude sends one window per report; both must accumulate.
    const state = createUsageBlobState('upsert-by-id')
    state.updateContext({ usedTokens: 0, maxTokens: null, costUsd: null })
    state.updateLimits({
      windows: [{ id: 'tokens', label: 'Tokens', usedPct: 50, resetsAt: null }],
    })
    state.updateLimits({
      windows: [{ id: 'requests', label: 'Requests', usedPct: 30, resetsAt: null }],
    })
    expect(state.getBlob()?.limits.windows).toHaveLength(2)
  })

  it('upsert-by-id: a second report for the same id replaces that window', () => {
    const state = createUsageBlobState('upsert-by-id')
    state.updateContext({ usedTokens: 0, maxTokens: null, costUsd: null })
    state.updateLimits({
      windows: [{ id: 'tokens', label: 'Tokens', usedPct: 50, resetsAt: null }],
    })
    state.updateLimits({
      windows: [{ id: 'tokens', label: 'Tokens', usedPct: 80, resetsAt: null }],
    })
    const blob = state.getBlob()
    expect(blob?.limits.windows).toHaveLength(1)
    expect(blob?.limits.windows[0].usedPct).toBe(80)
  })

  it('replace: a two-window snapshot followed by a one-window snapshot yields ONE window', () => {
    // Codex sends full snapshots; a window absent from the latest must vanish.
    const state = createUsageBlobState('replace')
    state.updateContext({ usedTokens: 0, maxTokens: null, costUsd: null })
    state.updateLimits({
      windows: [
        { id: 'tokens', label: 'Tokens', usedPct: 50, resetsAt: null },
        { id: 'requests', label: 'Requests', usedPct: 30, resetsAt: null },
      ],
    })
    state.updateLimits({
      windows: [{ id: 'tokens', label: 'Tokens', usedPct: 60, resetsAt: null }],
    })
    const blob = state.getBlob()
    expect(blob?.limits.windows).toHaveLength(1)
    expect(blob?.limits.windows[0].id).toBe('tokens')
    expect(blob?.limits.windows[0].usedPct).toBe(60)
  })

  it('updatedAt is ISO-8601 UTC', () => {
    const state = createUsageBlobState('replace')
    state.updateContext({ usedTokens: 0, maxTokens: null, costUsd: null })
    expect(state.getBlob()?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('credits survive an upsert-by-id limits update', () => {
    const state = createUsageBlobState('upsert-by-id')
    state.updateContext({ usedTokens: 0, maxTokens: null, costUsd: null })
    state.updateLimits({
      windows: [],
      credits: { unit: 'USD', remaining: 10 },
    })
    state.updateLimits({ windows: [{ id: 'tokens', label: 'T', usedPct: 5, resetsAt: null }] })
    // credits carry forward because the second update did not provide new credits
    expect(state.getBlob()?.limits.credits).toEqual({ unit: 'USD', remaining: 10 })
  })
})

describe('extractContextFromEvent', () => {
  it('returns null for non-assistant events', () => {
    expect(extractContextFromEvent({ type: 'system', subtype: 'init' })).toBeNull()
    expect(extractContextFromEvent({ type: 'result', usage: { input_tokens: 100 } })).toBeNull()
    expect(extractContextFromEvent({ type: 'rate_limits', windows: [] })).toBeNull()
  })

  it('returns null for assistant events with no usage object', () => {
    expect(extractContextFromEvent({ type: 'assistant', message: {} })).toBeNull()
    expect(extractContextFromEvent({ type: 'assistant' })).toBeNull()
  })

  it('sums input + cache buckets into usedTokens', () => {
    const ctx = extractContextFromEvent({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 50,
          output_tokens: 30, // output is not part of context size
        },
      },
    })
    expect(ctx?.usedTokens).toBe(1250)
  })

  it('returns maxTokens from context_window when present', () => {
    const ctx = extractContextFromEvent({
      type: 'assistant',
      message: { usage: { input_tokens: 100, context_window: 200_000 } },
    })
    expect(ctx?.maxTokens).toBe(200_000)
  })

  it('returns maxTokens: null when context_window is absent or not a finite number', () => {
    expect(
      extractContextFromEvent({
        type: 'assistant',
        message: { usage: { input_tokens: 100 } },
      })?.maxTokens,
    ).toBeNull()
    expect(
      extractContextFromEvent({
        type: 'assistant',
        message: { usage: { input_tokens: 100, context_window: 'big' } },
      })?.maxTokens,
    ).toBeNull()
  })

  it('returns costUsd from cost_usd when present', () => {
    const ctx = extractContextFromEvent({
      type: 'assistant',
      message: { usage: { input_tokens: 100, cost_usd: 0.025 } },
    })
    expect(ctx?.costUsd).toBe(0.025)
  })

  it('degrades malformed usage fields to 0 / null without throwing', () => {
    // This is the "malformed event degrades to unknown" guarantee.
    const ctx = extractContextFromEvent({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 'bad',
          context_window: Number.NaN,
          cost_usd: 'oops',
        },
      },
    })
    expect(ctx).not.toBeNull()
    expect(ctx?.usedTokens).toBe(0)
    expect(ctx?.maxTokens).toBeNull()
    expect(ctx?.costUsd).toBeNull()
  })
})

describe('extractLimitsFromEvent', () => {
  it('returns null for non rate_limits events', () => {
    expect(extractLimitsFromEvent({ type: 'assistant', message: {} })).toBeNull()
    expect(extractLimitsFromEvent({ type: 'system', subtype: 'init' })).toBeNull()
    expect(extractLimitsFromEvent({ type: 'result', is_error: false })).toBeNull()
  })

  it('returns empty windows for a rate_limits event with no windows array', () => {
    const limits = extractLimitsFromEvent({ type: 'rate_limits' })
    expect(limits).not.toBeNull()
    expect(limits?.windows).toHaveLength(0)
  })

  it('extracts well-formed window objects', () => {
    const limits = extractLimitsFromEvent({
      type: 'rate_limits',
      windows: [
        { id: 'tokens', label: 'Token limit', usedPct: 75, resetsAt: '2026-01-01T00:00:00Z' },
      ],
    })
    expect(limits?.windows).toHaveLength(1)
    expect(limits?.windows[0]).toEqual({
      id: 'tokens',
      label: 'Token limit',
      usedPct: 75,
      resetsAt: '2026-01-01T00:00:00Z',
    })
  })

  it('skips malformed window entries without throwing', () => {
    // Missing id, bad id type, null entry, string entry — all dropped.
    const limits = extractLimitsFromEvent({
      type: 'rate_limits',
      windows: [
        { label: 'No id', usedPct: 10, resetsAt: null },
        { id: 'ok', label: 'Good', usedPct: 50, resetsAt: null },
        { id: 123, label: 'Bad id type', usedPct: 20, resetsAt: null },
        null,
        'not an object',
      ],
    })
    expect(limits?.windows).toHaveLength(1)
    expect(limits?.windows[0].id).toBe('ok')
  })

  it('uses 0 for non-finite usedPct and null for non-string resetsAt', () => {
    const limits = extractLimitsFromEvent({
      type: 'rate_limits',
      windows: [{ id: 'w', label: 'L', usedPct: 'bad', resetsAt: 42 }],
    })
    expect(limits?.windows[0].usedPct).toBe(0)
    expect(limits?.windows[0].resetsAt).toBeNull()
  })

  it('extracts credits when present and well-formed', () => {
    const limits = extractLimitsFromEvent({
      type: 'rate_limits',
      windows: [],
      credits: { unit: 'USD', remaining: 4.5 },
    })
    expect(limits?.credits).toEqual({ unit: 'USD', remaining: 4.5 })
  })

  it('omits credits when fields are malformed without throwing', () => {
    const limits = extractLimitsFromEvent({
      type: 'rate_limits',
      windows: [],
      credits: { unit: null, remaining: 'bad' },
    })
    expect(limits?.credits).toBeUndefined()
  })
})
