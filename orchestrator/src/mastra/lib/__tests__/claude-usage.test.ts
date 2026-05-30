import { describe, expect, it } from 'vitest'
import { emptyUsageTotals, summarizeUsage, getLatestContextSize } from '../claude-usage'
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
