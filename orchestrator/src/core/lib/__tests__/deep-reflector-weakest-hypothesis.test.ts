import { describe, expect, it } from 'vitest'
import { buildArcPrompt, parseDeepReflectionReport } from '../deep-reflector'
import type { DeepReflectArc } from '../deep-reflect-query'

/** Minimal valid DeepReflectArc fixture — one done task, empty conversation. */
const makeArc = (): DeepReflectArc => ({
  originId: 'mars-test-arc',
  tasks: [
    {
      taskId: 'mars-test-task',
      status: 'done',
      prompt: 'test task prompt',
      error: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T01:00:00.000Z',
      kind: 'task',
      fixForTaskId: null,
      signals: [],
      scorerResults: [],
      totals: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        cacheHitRatio: 0,
      },
      conversation: [],
      verifyOutput: null,
      hasTranscript: true,
      toolCallCounts: {},
      transcriptNotes: [],
    },
  ],
  statusMix: { done: 1 },
  taskCount: 1,
  totals: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalWeightedTokens: 1050,
    cacheHitRatio: 0,
    eventCount: 0,
  },
  lastActivity: '2025-01-01T01:00:00.000Z',
  stepTimeline: [],
  toolInvokedErrors: [],
  operatorContext: null,
})

/** A synthetic model response carrying one suggestion with a valid outcome. */
const responseWithSuggestion = (
  extra: Record<string, unknown>,
): string =>
  JSON.stringify({
    summary: 'arc finished but repeated a failing verify',
    toolCallStats: { total: 4, byName: { Bash: 4 } },
    dissonantCalls: [],
    thrashingPatterns: [],
    rootCause: 'verify command was re-run without changing the diff',
    suggestions: [
      {
        title: 'Stop re-running an unchanged verify',
        prompt: 'Detect an unchanged diff before re-running verify. Save your work.',
        rationale: 'verify ran 3 times on an identical tree',
        verdict: 'save',
        outcome: {
          type: 'leverGap',
          leverGap: {
            proposedLeverId: 'verify.unchanged-diff-guard',
            family: 'verify',
            whatItWouldControl: 'skipping a verify re-run on an unchanged tree',
          },
        },
        ...extra,
      },
    ],
  })

describe('deep-reflector least-specific-valid-rule clause', () => {
  it('states the clause for suggestions[], not only scorerSuggestions', () => {
    const prompt = buildArcPrompt(makeArc())

    expect(prompt).toContain('Least-specific-valid-rule')
    // The clause must scope itself to `suggestions[]` explicitly, so it is not
    // read as applying only to the scorer rubric rules further down.
    expect(prompt).toContain('applies to every entry in `suggestions[]`')
    expect(prompt).toContain('not\nonly `scorerSuggestions`')
    expect(prompt).toMatch(/narrowest true claim/)
  })

  it('documents both coverage fields in the suggestions schema block', () => {
    const prompt = buildArcPrompt(makeArc())

    expect(prompt).toContain('"coversInstances"')
    expect(prompt).toContain('"doesNotClaim"')
  })
})

describe('parseDeepReflectionReport — coverage fields on suggestions', () => {
  it('preserves coversInstances and doesNotClaim from a model response', () => {
    const report = parseDeepReflectionReport(
      responseWithSuggestion({
        coversInstances: ['mars-test-task', 'mars-other-task'],
        doesNotClaim: 'does not claim this recurs on other workflow kinds',
      }),
    )

    expect(report).not.toBeNull()
    expect(report?.suggestions).toHaveLength(1)
    expect(report?.suggestions[0].coversInstances).toEqual([
      'mars-test-task',
      'mars-other-task',
    ])
    expect(report?.suggestions[0].doesNotClaim).toBe(
      'does not claim this recurs on other workflow kinds',
    )
  })

  it('defaults both fields when the model omits them', () => {
    const report = parseDeepReflectionReport(responseWithSuggestion({}))

    expect(report?.suggestions).toHaveLength(1)
    expect(report?.suggestions[0].coversInstances).toEqual([])
    expect(report?.suggestions[0].doesNotClaim).toBe('')
  })

  it('drops non-string entries rather than propagating malformed coverage', () => {
    const report = parseDeepReflectionReport(
      responseWithSuggestion({
        coversInstances: ['mars-test-task', 42, null, 'mars-other-task'],
        doesNotClaim: 7,
      }),
    )

    expect(report?.suggestions[0].coversInstances).toEqual([
      'mars-test-task',
      'mars-other-task',
    ])
    expect(report?.suggestions[0].doesNotClaim).toBe('')
  })
})
