import { afterEach, describe, expect, it } from 'vitest'
import {
  getAccumulatedTotals,
  recordClaudeEvent,
  resetAccumulatedTotals,
} from '../usage-accumulator.js'

describe('usage-accumulator', () => {
  afterEach(() => {
    resetAccumulatedTotals()
  })

  it('starts at zero', () => {
    expect(getAccumulatedTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('accumulates tokens from assistant events', () => {
    recordClaudeEvent({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 10,
        },
      },
    } as unknown as import('../../lib/claude-stream.js').ClaudeEvent)

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
    } as unknown as import('../../lib/claude-stream.js').ClaudeEvent)

    recordClaudeEvent(makeEvent(100, 50))
    recordClaudeEvent(makeEvent(200, 75))

    const totals = getAccumulatedTotals()
    expect(totals.inputTokens).toBe(300)
    expect(totals.outputTokens).toBe(125)
  })

  it('ignores non-assistant events', () => {
    recordClaudeEvent({
      type: 'tool_use',
      id: 'x',
      name: 'Bash',
      input: {},
    } as unknown as import('../../lib/claude-stream.js').ClaudeEvent)

    expect(getAccumulatedTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })
  })

  it('ignores events with missing usage block', () => {
    recordClaudeEvent({
      type: 'assistant',
      message: { content: [] },
    } as unknown as import('../../lib/claude-stream.js').ClaudeEvent)

    expect(getAccumulatedTotals()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
    })
  })
})
