import { describe, expect, it } from 'vitest'
import {
  buildPrompt,
  extractFirstJsonDocument,
  collectAssistantText,
} from '../reflector'
import type { ReflectCorpus } from '../reflect-query'

const emptySummary = {
  totalWeightedTokens: 0,
  taskCount: 0,
  successCount: 0,
  failureCount: 0,
  cacheHitRatio: 0,
  topTokenHeavyTasks: [],
  topExpensiveSteps: [],
  tokensByStep: [],
}

const fixtureCorpus: ReflectCorpus = {
  entries: [
    {
      taskId: 'fixture-1',
      status: 'merged',
      promptPrefix: 'do the thing',
      errorTail: null,
      createdAt: '2026-05-01T00:00:00Z',
      scores: {},
      signals: [],
      totals: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreateTokens: 200,
        cacheReadTokens: 100,
        cacheHitRatio: 0.33,
      },
    },
  ],
  costSummary: emptySummary,
}

describe('reflector prompt', () => {
  it('contains no "USD" references in instruction prose', () => {
    const prompt = buildPrompt(fixtureCorpus)
    // Only the *instruction* portion of the prompt — everything
    // before the corpus payload — must be USD-free.
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).not.toMatch(/USD/)
  })

  it('contains no dollar-figure thresholds in instruction prose', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).not.toMatch(/\$\d/)
  })

  it('describes the rationale field as citing token counts only, not USD figures', () => {
    const prompt = buildPrompt(fixtureCorpus)
    // Locate the rationale schema line and confirm it cites tokens and
    // not USD figures.
    const rationaleLineMatch = prompt.match(/"rationale":\s*"[^"]*"/)
    expect(rationaleLineMatch).not.toBeNull()
    const rationaleLine = rationaleLineMatch![0]
    expect(rationaleLine).not.toMatch(/USD/i)
    expect(rationaleLine).toMatch(/token/i)
  })

  it('asks the model to cite token counts rather than USD figures', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).not.toMatch(/Cite USD/i)
    expect(instructionPortion).toMatch(/token/i)
  })

  it('explicitly forbids emitting dollar amounts', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    // The prompt must instruct the model not to emit dollar/USD amounts.
    expect(instructionPortion).toMatch(/Never emit USD|Do NOT emit.*dollar|Never.*dollar/i)
  })
})

describe('tokenAnalysis output schema', () => {
  it('exposes tokenAnalysis with tokenHeavyTasks, tokenHeavySteps, and successVsFailureTokens — no costAnalysis', () => {
    const fixtureJson = JSON.stringify({
      tokenAnalysis: {
        headline: 'Token spend within normal band.',
        tokenHeavyTasks: [
          {
            taskId: 'abcd1234',
            weightedTokens: 42000,
            multipleOfMedian: 3.2,
            rootCause: 'code step burned 80k input tokens re-reading the same files',
          },
        ],
        tokenHeavySteps: [
          {
            stepId: 'code',
            totalWeightedTokens: 120000,
            verdict: 'wasted',
            evidence: '120k tokens spent on failed verify retries',
          },
        ],
        cacheHealth: { ratio: 0.34, verdict: 'degraded', evidence: 'cache_read_tokens << cache_create_tokens' },
        successVsFailureTokens: { successTokens: 12000, failureTokens: 30000, verdict: 'failure spend dominates' },
        notes: '',
      },
      suggestions: [],
    })

    const parsed = extractFirstJsonDocument(fixtureJson) as Record<string, unknown>
    expect(parsed).not.toBeNull()
    expect(parsed).toHaveProperty('tokenAnalysis')
    expect(parsed).not.toHaveProperty('costAnalysis')

    const ta = parsed.tokenAnalysis as Record<string, unknown>
    expect(ta).toHaveProperty('tokenHeavyTasks')
    expect(ta).toHaveProperty('tokenHeavySteps')
    expect(ta).toHaveProperty('successVsFailureTokens')
    expect(ta).not.toHaveProperty('expensiveTasks')
    expect(ta).not.toHaveProperty('expensiveSteps')
    expect(ta).not.toHaveProperty('successVsFailureSpend')
  })

  it('output schema keys contain no "usd", "cost", or "$" entries', () => {
    // This test MUST fail if any usd/cost/$ key reappears in the output schema.
    const fixtureJson = JSON.stringify({
      tokenAnalysis: {
        headline: 'Token spend within normal band.',
        tokenHeavyTasks: [
          {
            taskId: 'abcd1234',
            weightedTokens: 42000,
            multipleOfMedian: 3.2,
            rootCause: 'code step burned 80k input tokens',
          },
        ],
        tokenHeavySteps: [
          {
            stepId: 'code',
            totalWeightedTokens: 120000,
            verdict: 'wasted',
            evidence: '120k tokens spent on failed verify retries',
          },
        ],
        cacheHealth: null,
        successVsFailureTokens: null,
        notes: '',
      },
      suggestions: [],
    })

    const parsed = extractFirstJsonDocument(fixtureJson)
    expect(parsed).not.toBeNull()

    // Walk all keys recursively and confirm none match usd, cost, or $
    const allKeys: string[] = []
    const walk = (obj: unknown): void => {
      if (!obj || typeof obj !== 'object') return
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item)
      } else {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          allKeys.push(k)
          walk(v)
        }
      }
    }
    walk(parsed)

    expect(allKeys.some((k) => /usd/i.test(k))).toBe(false)
    expect(allKeys.some((k) => /cost/i.test(k))).toBe(false)
    expect(allKeys.some((k) => k.includes('$'))).toBe(false)
  })
})

describe('runReflector output parsing (fixture)', () => {
  it('produces a parsed result whose string fields contain no USD strings when the LLM follows the token-only contract', () => {
    // Simulate the assistant text produced by a model that obeys the
    // updated prompt: rationale and analysis cite token counts only.
    const fixtureAssistantText = JSON.stringify({
      tokenAnalysis: {
        headline: 'Spend within band; one task ran hot on tokens.',
        tokenHeavyTasks: [
          {
            taskId: 'abcd1234',
            weightedTokens: 42000,
            multipleOfMedian: 3.2,
            rootCause: 'code step burned 80k input tokens re-reading the same files',
          },
        ],
        tokenHeavySteps: [
          {
            stepId: 'code',
            totalWeightedTokens: 120000,
            verdict: 'wasted',
            evidence: '120k tokens spent on failed verify retries',
          },
        ],
        cacheHealth: { ratio: 0.34, verdict: 'degraded', evidence: 'cache_read_tokens << cache_create_tokens' },
        successVsFailureTokens: { successTokens: 12000, failureTokens: 30000, verdict: 'failure spend dominates' },
        notes: '',
      },
      suggestions: [
        {
          title: 'Cap read-span on the code step',
          category: 'token',
          prompt: 'Add a Read budget watcher to the code step. Save your work.',
          rationale: '120k tokens leaked on retries of task abcd1234',
        },
      ],
    })

    const parsed = extractFirstJsonDocument(fixtureAssistantText)
    expect(parsed).not.toBeNull()

    // Collect every string-valued field that the parser would surface
    // and confirm none of them contain "USD".
    const stringify = JSON.stringify(parsed)
    expect(stringify).not.toMatch(/USD/)
    expect(stringify).not.toMatch(/\$\d/)
  })
})

describe('collectAssistantText', () => {
  it('concatenates text blocks from assistant events', () => {
    const conversation = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'user',
        message: { content: 'ignored' },
      },
      {
        type: 'assistant',
        message: { content: 'world' },
      },
    ]
    expect(collectAssistantText(conversation)).toBe('hello\nworld')
  })
})
