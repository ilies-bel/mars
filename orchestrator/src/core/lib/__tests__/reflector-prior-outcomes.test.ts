/**
 * Prior-suggestion-outcome section in the reflector prompt (PRD 1e904a61,
 * slice 16): each reflect run should see what happened to the previous
 * run's suggestions — promoted / dismissed / open — so it stops re-proposing
 * rules the operator already rejected.
 */
import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../reflector'
import type { ReflectCorpus } from '../reflect-query'
import type { PriorProposalOutcome } from '../../proposals'

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

const dismissedOutcome: PriorProposalOutcome = {
  fingerprint: 'abc123deadbeef',
  title: 'Lower the implement cap to 8',
  fate: 'dismissed',
}

const promotedOutcome: PriorProposalOutcome = {
  fingerprint: 'def456feedface',
  title: 'Add typecheck verify gate',
  fate: 'promoted',
}

const openOutcome: PriorProposalOutcome = {
  fingerprint: 'ghi789cafebabe',
  title: 'Investigate cache-miss pattern on code step',
  fate: 'open',
}

describe('buildPrompt with priorOutcomes', () => {
  it('output is byte-identical when priorOutcomes is absent', () => {
    const withoutOutcomes = buildPrompt(fixtureCorpus)
    const withEmptyOutcomes = buildPrompt({ ...fixtureCorpus, priorOutcomes: [] })
    expect(withEmptyOutcomes).toBe(withoutOutcomes)
  })

  it('output is byte-identical when priorOutcomes is undefined', () => {
    const base = buildPrompt(fixtureCorpus)
    const withUndefined = buildPrompt({ ...fixtureCorpus, priorOutcomes: undefined })
    expect(withUndefined).toBe(base)
  })

  it('lists a dismissed predecessor with its fate', () => {
    const prompt = buildPrompt({
      ...fixtureCorpus,
      priorOutcomes: [dismissedOutcome],
    })

    expect(prompt).toContain('Prior Reflection Suggestions')
    expect(prompt).toContain(dismissedOutcome.fingerprint)
    expect(prompt).toContain(dismissedOutcome.title)
    expect(prompt).toContain('dismissed')
  })

  it('lists promoted and open predecessors with their own fates', () => {
    const prompt = buildPrompt({
      ...fixtureCorpus,
      priorOutcomes: [promotedOutcome, openOutcome],
    })

    expect(prompt).toContain(`${promotedOutcome.fingerprint} | ${promotedOutcome.title} | promoted`)
    expect(prompt).toContain(`${openOutcome.fingerprint} | ${openOutcome.title} | open`)
  })

  it('instructs the model not to re-emit a dismissed predecessor without new instances', () => {
    const prompt = buildPrompt({
      ...fixtureCorpus,
      priorOutcomes: [dismissedOutcome],
    })

    expect(prompt).toMatch(/Do NOT re-emit a suggestion whose predecessor is listed as "dismissed"/)
    expect(prompt).toMatch(/NEW affected task instances/)
  })

  it('places the prior-outcomes section before the chat feedback section when both are present', () => {
    const prompt = buildPrompt({
      ...fixtureCorpus,
      priorOutcomes: [dismissedOutcome],
      chatFeedback: [
        {
          messageId: 'msg-1',
          threadId: 'thread-aabb',
          rating: 'down',
          note: null,
          userPrompt: 'why is this slow',
          assistantReply: 'because tokens',
          toolsUsed: [],
          createdAt: 0,
        },
      ],
      chatSystemPrompt: 'You are Mars.',
    })

    const priorIdx = prompt.indexOf('Prior Reflection Suggestions')
    const feedbackIdx = prompt.indexOf('Chat Feedback')
    expect(priorIdx).toBeGreaterThan(-1)
    expect(feedbackIdx).toBeGreaterThan(-1)
    expect(priorIdx).toBeLessThan(feedbackIdx)
  })
})
