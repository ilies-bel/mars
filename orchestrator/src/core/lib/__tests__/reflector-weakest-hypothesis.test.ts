/**
 * Tests for the least-specific-valid-rule clause on the token reflector's
 * `suggestions[]` output (PRD 1e904a61, slice 1) — mirrors
 * `deep-reflector-weakest-hypothesis.test.ts`, which covers the same
 * discipline for the deep reflector's arc-level suggestions.
 */
import { describe, expect, it } from 'vitest'
import { buildPrompt, parseReflectionResponse } from '../reflector'
import type { ReflectCorpus } from '../reflect-query'

const emptySummary = {
  totalWeightedTokens: 0,
  taskCount: 0,
  successCount: 0,
  failureCount: 0,
  baselineCaughtCount: 0,
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
      taskId: 'mars-test-task',
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
      baselineCaught: false,
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

/** A synthetic model response carrying one suggestion with a valid outcome. */
const responseWithSuggestion = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    tokenAnalysis: {
      headline: 'Token spend within normal band.',
      tokenHeavyTasks: [],
      tokenHeavySteps: [],
      cacheHealth: null,
      successVsFailureTokens: null,
      notes: '',
    },
    suggestions: [
      {
        title: 'Tighten typecheck flags',
        prompt: 'Add --strict to tsconfig. Verify: npm run typecheck. Save your work.',
        rationale: '1 task failed with TS2345',
        rootCauseKey: 'typecheck_strict_flags',
        affectedTaskIds: ['mars-test-task'],
        frequency: 1,
        confidence: 0.7,
        kind: 'mechanical',
        outcome: {
          type: 'leverGap',
          leverGap: {
            proposedLeverId: 'verify.typecheck-strict',
            family: 'verify',
            whatItWouldControl: 'typecheck strictness flags',
          },
        },
        ...extra,
      },
    ],
  })

describe('reflector least-specific-valid-rule clause', () => {
  it('states the clause requiring the rule to cover every affected task id, no more specifically', () => {
    const prompt = buildPrompt(fixtureCorpus)

    expect(prompt).toContain('Least-specific-valid-rule')
    expect(prompt).toMatch(/MUST cover EVERY task id/)
    expect(prompt).toMatch(/no MORE specific than that coverage\s+requires/)
    expect(prompt).toMatch(/narrowest true claim/)
  })

  it('documents both coverage fields in the suggestions schema block', () => {
    const prompt = buildPrompt(fixtureCorpus)

    expect(prompt).toContain('"coversInstances"')
    expect(prompt).toContain('"doesNotClaim"')
  })
})

describe('parseReflectionResponse — coverage fields on suggestions', () => {
  it('preserves coversInstances and doesNotClaim from a model response', () => {
    const parsed = parseReflectionResponse(
      responseWithSuggestion({
        coversInstances: ['mars-test-task'],
        doesNotClaim: 'does not claim this recurs on other Workflow kinds',
      }),
    )

    expect(parsed.suggestions).toHaveLength(1)
    expect(parsed.suggestions[0].coversInstances).toEqual(['mars-test-task'])
    expect(parsed.suggestions[0].doesNotClaim).toBe(
      'does not claim this recurs on other Workflow kinds',
    )
  })

  it('defaults coversInstances to affectedTaskIds and doesNotClaim to empty when the model omits them', () => {
    const parsed = parseReflectionResponse(responseWithSuggestion({}))

    expect(parsed.suggestions).toHaveLength(1)
    expect(parsed.suggestions[0].coversInstances).toEqual(['mars-test-task'])
    expect(parsed.suggestions[0].doesNotClaim).toBe('')
  })

  it('drops non-string entries rather than propagating malformed coverage', () => {
    const parsed = parseReflectionResponse(
      responseWithSuggestion({
        coversInstances: ['mars-test-task', 42, null, 'mars-other-task'],
        doesNotClaim: 7,
      }),
    )

    expect(parsed.suggestions[0].coversInstances).toEqual([
      'mars-test-task',
      'mars-other-task',
    ])
    expect(parsed.suggestions[0].doesNotClaim).toBe('')
  })
})
