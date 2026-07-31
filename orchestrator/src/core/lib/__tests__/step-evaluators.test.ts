import { describe, expect, it } from 'vitest'
import { evaluateStep } from '../step-evaluators'

// Minimal payload builder for LLM steps — only usageSignals matters for these
// evaluators; the rest is irrelevant noise that step-evaluators ignores.
function makePayload(signals: Record<string, unknown>): Record<string, unknown> {
  return { usageSignals: signals }
}

describe('ctx% evaluator', () => {
  it('reports 50% when contextTokens is half the context window', () => {
    const results = evaluateStep('run-claude-code', makePayload({ contextTokens: 100_000 }))
    const ctxResult = results.find((r) => r.label === 'ctx%')
    expect(ctxResult).toBeDefined()
    expect(ctxResult!.value).toBe('50%')
    expect(ctxResult!.warn).toBe(false)
  })

  it('reports 90% and warns when contextTokens is 180k', () => {
    const results = evaluateStep('run-claude-code', makePayload({ contextTokens: 180_000 }))
    const ctxResult = results.find((r) => r.label === 'ctx%')
    expect(ctxResult).toBeDefined()
    expect(ctxResult!.value).toBe('90%')
    expect(ctxResult!.warn).toBe(true)
  })

  it('does not recur the old cumulative-sum bug: large inputTokens with small contextTokens still reports the correct ctx%', () => {
    // Old behaviour: inputTokens=800_000 would give 400%, proving 4x overcounting.
    // New behaviour: evaluator ignores cumulative inputTokens and reads contextTokens only.
    const results = evaluateStep(
      'run-claude-code',
      makePayload({ inputTokens: 800_000, contextTokens: 100_000 }),
    )
    const ctxResult = results.find((r) => r.label === 'ctx%')
    expect(ctxResult).toBeDefined()
    expect(ctxResult!.value).toBe('50%')
    expect(ctxResult!.warn).toBe(false)
  })

  it('returns null (no result) when usageSignals is absent', () => {
    const results = evaluateStep('run-claude-code', {})
    const ctxResult = results.find((r) => r.label === 'ctx%')
    expect(ctxResult).toBeUndefined()
  })

  it('reports 0% when contextTokens is 0', () => {
    const results = evaluateStep('run-claude-code', makePayload({ contextTokens: 0 }))
    const ctxResult = results.find((r) => r.label === 'ctx%')
    expect(ctxResult).toBeDefined()
    expect(ctxResult!.value).toBe('0%')
    expect(ctxResult!.warn).toBe(false)
  })

  it('can exceed 100% without clamping when context overflows the window', () => {
    const results = evaluateStep('run-claude-code', makePayload({ contextTokens: 220_000 }))
    const ctxResult = results.find((r) => r.label === 'ctx%')
    expect(ctxResult).toBeDefined()
    // 220_000 / 200_000 * 100 = 110%
    expect(ctxResult!.value).toBe('110%')
    expect(ctxResult!.warn).toBe(true)
  })
})

describe('ctx% evaluator — provider-blind readings are refused', () => {
  it('reports nothing when contextTokens is absent (provider cannot report occupancy)', () => {
    // A cumulative-usage provider (codex) or a no-usage provider (gemini)
    // never emits contextTokens. The evaluator must stay silent rather than
    // report a fabricated 0%.
    const results = evaluateStep('run-claude-code', makePayload({ inputTokens: 500 }))
    expect(results.find((r) => r.label === 'ctx%')).toBeUndefined()
  })

  it('never derives ctx% from cumulativeTokens', () => {
    // The production bug: 289,216 cumulative codex tokens read as occupancy
    // against a 200k window reported >140%, tripping context-overflow handling
    // on a run nowhere near the limit.
    const results = evaluateStep('run-claude-code', makePayload({ cumulativeTokens: 289_216 }))
    expect(results.find((r) => r.label === 'ctx%')).toBeUndefined()
  })
})

describe('spend evaluator', () => {
  it('reports cumulative token spend as spend, not as a percentage', () => {
    const results = evaluateStep('run-claude-code', makePayload({ cumulativeTokens: 289_216 }))
    const spend = results.find((r) => r.label === 'spend')
    expect(spend).toBeDefined()
    expect(spend!.value).toBe('289.2k tok')
    expect(spend!.warn).toBe(false)
  })

  it('reports nothing for a per-request provider (contextTokens only)', () => {
    const results = evaluateStep('run-claude-code', makePayload({ contextTokens: 100_000 }))
    expect(results.find((r) => r.label === 'spend')).toBeUndefined()
  })
})

describe('out/in evaluator', () => {
  it('computes output/input ratio from cumulative inputTokens and outputTokens', () => {
    const results = evaluateStep(
      'run-claude-code',
      makePayload({ inputTokens: 1000, outputTokens: 100 }),
    )
    const outIn = results.find((r) => r.label === 'out/in')
    expect(outIn).toBeDefined()
    expect(outIn!.value).toBe('0.1')
  })

  it('returns no result when inputTokens is 0', () => {
    const results = evaluateStep('run-claude-code', makePayload({ inputTokens: 0, outputTokens: 50 }))
    const outIn = results.find((r) => r.label === 'out/in')
    expect(outIn).toBeUndefined()
  })
})

describe('msgs evaluator', () => {
  it('reports message count from usageSignals.messageCount', () => {
    const results = evaluateStep('run-claude-code', makePayload({ messageCount: 7 }))
    const msgs = results.find((r) => r.label === 'msgs')
    expect(msgs).toBeDefined()
    expect(msgs!.value).toBe('7')
  })

  it('returns no result when messageCount is not a number', () => {
    const results = evaluateStep('run-claude-code', makePayload({}))
    const msgs = results.find((r) => r.label === 'msgs')
    expect(msgs).toBeUndefined()
  })
})

describe('evaluateStep step registration', () => {
  it('returns results for all LLM step names', () => {
    const steps = ['run-claude-code', 'slicer', 'triage', 'plan', 'slice']
    const payload = makePayload({ contextTokens: 100_000, inputTokens: 500, outputTokens: 50, messageCount: 3 })
    for (const step of steps) {
      const results = evaluateStep(step, payload)
      expect(results.find((r) => r.label === 'ctx%')).toBeDefined()
      expect(results.find((r) => r.label === 'out/in')).toBeDefined()
      expect(results.find((r) => r.label === 'msgs')).toBeDefined()
    }
  })
})
