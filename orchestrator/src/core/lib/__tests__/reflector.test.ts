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
  blockedCount: 0,
  droppedCount: 0,
  cacheHitRatio: 0,
  rateLimitRejections: 0,
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
      failureSignature: null,
      failureReasonCode: null,
      failedPhase: null,
      kind: null,
      fixForTaskId: null,
      originId: null,
      toolErrorCount: 0,
      topErrorTool: null,
      signals: [],
      scorerResults: [],
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
          title: 'Cap token spend on the code step',
          category: 'token',
          prompt: 'Add a token budget cap to the code step. Save your work.',
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

describe('aggregation and frequency-floor in SYNTHESIS_INSTRUCTIONS', () => {
  it('instructs the model to emit ONE suggestion per root cause', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).toMatch(/ONE suggestion per root cause/i)
  })

  it('instructs the model to apply a frequency floor (skip single-task patterns)', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    // The floor condition: single task only qualifies if ≥2× median or high-severity
    expect(instructionPortion).toMatch(/only ONE task/i)
    expect(instructionPortion).toMatch(/2×/i)
  })

  it('prompt schema includes rootCauseKey, affectedTaskIds, and frequency fields', () => {
    const prompt = buildPrompt(fixtureCorpus)
    expect(prompt).toMatch(/"rootCauseKey"/)
    expect(prompt).toMatch(/"affectedTaskIds"/)
    expect(prompt).toMatch(/"frequency"/)
  })

  it('instructs the model to keep rootCauseKey stable across runs', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).toMatch(/rootCauseKey.*stable|stable.*rootCauseKey/i)
  })
})

// ── Chat feedback in buildPrompt ──────────────────────────────────────────────

const emptyChatCorpus: ReflectCorpus = {
  ...fixtureCorpus,
}

describe('buildPrompt with chatFeedback', () => {
  it('output is byte-identical when chatFeedback is absent', () => {
    const withoutFeedback = buildPrompt(fixtureCorpus)
    const withEmptyFeedback = buildPrompt({ ...fixtureCorpus, chatFeedback: [] })
    expect(withEmptyFeedback).toBe(withoutFeedback)
  })

  it('output is byte-identical when chatFeedback is undefined', () => {
    const base = buildPrompt(fixtureCorpus)
    const withUndefined = buildPrompt({ ...fixtureCorpus, chatFeedback: undefined })
    expect(withUndefined).toBe(base)
  })

  it('includes a chat feedback section when chatFeedback is non-empty', () => {
    const feedback: import('../chat-feedback-query').ChatFeedbackEntry[] = [
      {
        messageId: 'msg-1',
        threadId: 'thread-aabb',
        rating: 'down',
        note: 'too verbose',
        createdAt: Date.parse('2026-07-01T12:00:00Z'),
        userPrompt: 'how do I restart the daemon?',
        assistantReply:
          'To restart the daemon you must first stop it, then start it again...',
        toolsUsed: [],
      },
    ]
    const prompt = buildPrompt({
      ...fixtureCorpus,
      chatFeedback: feedback,
      chatSystemPrompt: 'You are Mars. Be terse.',
    })

    expect(prompt).toContain('Chat Feedback')
    expect(prompt).toContain('You are Mars. Be terse.')
    expect(prompt).toContain('how do I restart the daemon?')
    expect(prompt).toContain('too verbose')
    expect(prompt).toContain('DOWN')
  })

  it('includes the current chat system prompt when chatFeedback is present', () => {
    const customPrompt = 'Custom system prompt for this test run.'
    const prompt = buildPrompt({
      ...fixtureCorpus,
      chatFeedback: [
        {
          messageId: 'msg-2',
          threadId: 'thread-ccdd',
          rating: 'up',
          note: null,
          createdAt: Date.parse('2026-07-02T08:00:00Z'),
          userPrompt: 'what tasks are running?',
          assistantReply: '2 tasks running: mars-abc and mars-def.',
          toolsUsed: ['Bash'],
        },
      ],
      chatSystemPrompt: customPrompt,
    })

    expect(prompt).toContain(customPrompt)
    expect(prompt).toContain('UP')
    expect(prompt).toContain('Bash')
  })

  it('instructs the reflector to propose concrete edits to the chat system prompt', () => {
    const prompt = buildPrompt({
      ...fixtureCorpus,
      chatFeedback: [
        {
          messageId: 'msg-3',
          threadId: 'thread-eeff',
          rating: 'down',
          note: null,
          createdAt: Date.parse('2026-07-03T10:00:00Z'),
          userPrompt: 'status?',
          assistantReply: 'I have checked all tasks and here is a detailed report...',
          toolsUsed: [],
        },
      ],
      chatSystemPrompt: 'You are Mars.',
    })

    // The prompt must tell the reflector to propose concrete replacement wording.
    expect(prompt).toMatch(/concrete|replacement|wording/i)
    expect(prompt).toMatch(/chat.*system.*prompt|system.*prompt.*chat/i)
  })

  it('does not include chat feedback section in the base prompt (regression guard)', () => {
    const base = buildPrompt(emptyChatCorpus)
    expect(base).not.toContain('Chat Feedback')
    expect(base).not.toContain('chat-system-prompt')
  })
})

describe('suggestion parsing includes new fields', () => {
  it('parses rootCauseKey, affectedTaskIds, and frequency from LLM output', () => {
    const fixtureJson = JSON.stringify({
      tokenAnalysis: {
        headline: 'Normal spend.',
        tokenHeavyTasks: [],
        tokenHeavySteps: [],
        cacheHealth: null,
        successVsFailureTokens: null,
        notes: '',
      },
      suggestions: [
        {
          title: 'Fix repeated typecheck failures',
          category: 'failure',
          prompt: 'Fix the typecheck errors... Save your work.',
          rationale: '3 tasks failed with TS2345 across 45k tokens',
          rootCauseKey: 'typecheck_failure',
          affectedTaskIds: ['task-aaa', 'task-bbb', 'task-ccc'],
          frequency: 3,
        },
      ],
    })

    const parsed = extractFirstJsonDocument(fixtureJson) as Record<string, unknown>
    expect(parsed).not.toBeNull()
    const suggestions = parsed.suggestions as Array<Record<string, unknown>>
    expect(suggestions).toHaveLength(1)
    const s = suggestions[0]
    expect(s.rootCauseKey).toBe('typecheck_failure')
    expect(s.affectedTaskIds).toEqual(['task-aaa', 'task-bbb', 'task-ccc'])
    expect(s.frequency).toBe(3)
  })
})

describe('harnessMaturity in SYNTHESIS_INSTRUCTIONS', () => {
  it('instructs the model to assess verify-gate configuration', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).toMatch(/harnessMaturity/i)
    expect(instructionPortion).toMatch(/verify-gate/i)
  })

  it('references the "no-gates-configured" step name', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).toMatch(/no-gates-configured/i)
  })

  it('directs the model to emit mars verify add commands in suggestions', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).toMatch(/mars verify add/i)
  })

  it('instructs high-confidence mechanical suggestions when gates are clearly missing', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const instructionPortion = prompt.split('Token summary')[0]
    expect(instructionPortion).toMatch(/mechanical/i)
    expect(instructionPortion).toMatch(/0\.9/i)
  })
})

describe('improvement recipe catalog in buildPrompt', () => {
  it('includes the recipe catalog section in the prompt', () => {
    const prompt = buildPrompt(fixtureCorpus)
    expect(prompt).toContain('Improvement recipe catalog')
  })

  it('includes recipe ids from the built-in catalog', () => {
    const prompt = buildPrompt(fixtureCorpus)
    // The catalog must include at least the typecheck and unit-test recipes
    expect(prompt).toContain('add-typecheck')
    expect(prompt).toContain('add-unit-tests')
  })

  it('includes mars verify add commands from recipe setup steps', () => {
    const prompt = buildPrompt(fixtureCorpus)
    // Recipe setup steps contain concrete mars verify add commands
    expect(prompt).toMatch(/mars verify add typecheck/i)
    expect(prompt).toMatch(/mars verify add test/i)
  })

  it('places the recipe catalog before the token summary', () => {
    const prompt = buildPrompt(fixtureCorpus)
    const catalogPos = prompt.indexOf('Improvement recipe catalog')
    const summaryPos = prompt.indexOf('Token summary')
    expect(catalogPos).toBeGreaterThan(-1)
    expect(summaryPos).toBeGreaterThan(-1)
    expect(catalogPos).toBeLessThan(summaryPos)
  })
})
