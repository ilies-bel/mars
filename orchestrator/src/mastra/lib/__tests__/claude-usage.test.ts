import { describe, expect, it } from 'vitest'
import { emptyUsageTotals, summarizeUsage } from '../claude-usage'
import type { ClaudeEvent } from '../claude-stream'

const assistant = (usage: Record<string, unknown>): ClaudeEvent => ({
  type: 'assistant',
  message: { usage, content: [] },
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
