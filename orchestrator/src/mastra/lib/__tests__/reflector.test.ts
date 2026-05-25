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
    const instructionPortion = prompt.split('Cost summary')[0]
    expect(instructionPortion).not.toMatch(/USD/)
  })

  it('contains no dollar-figure thresholds in instruction prose', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Cost summary')[0]
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
    const instructionPortion = prompt.split('Cost summary')[0]
    expect(instructionPortion).not.toMatch(/Cite USD/i)
    expect(instructionPortion).toMatch(/token/i)
  })
})

describe('runReflector output parsing (fixture)', () => {
  it('produces a parsed result whose string fields contain no USD strings when the LLM follows the token-only contract', () => {
    // Simulate the assistant text produced by a model that obeys the
    // updated prompt: rationale and analysis cite token counts only.
    const fixtureAssistantText = JSON.stringify({
      costAnalysis: {
        headline: 'Spend within band; one task ran hot on tokens.',
        expensiveTasks: [
          {
            taskId: 'abcd1234',
            costUsd: 0,
            multipleOfMedian: 3.2,
            rootCause: 'code step burned 80k input tokens re-reading the same files',
          },
        ],
        expensiveSteps: [
          {
            stepId: 'code',
            totalCostUsd: 0,
            verdict: 'wasted',
            evidence: '120k tokens spent on failed verify retries',
          },
        ],
        cacheHealth: { ratio: 0.34, verdict: 'degraded', evidence: 'cache_read_tokens << cache_create_tokens' },
        successVsFailureSpend: { successUsd: 0, failureUsd: 0, verdict: 'failure spend dominates' },
        notes: '',
      },
      suggestions: [
        {
          title: 'Cap read-span on the code step',
          category: 'cost',
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
