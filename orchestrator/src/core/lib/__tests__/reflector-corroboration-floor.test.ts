/**
 * Tests for the ADR-0099 corroboration floor gating applyVerdicts' save path
 * (PRD 1e904a61, slice 11): a single-arc (n=1) deep-reflect suggestion does
 * not create a proposal until its coverage spans
 * `MIN_CORROBORATION_INSTANCES` (3) distinct arcs, unless the call is marked
 * exempt. Below the floor, the suggestion accumulates as a candidate lesson
 * (`candidate-lessons.ts`) instead of being thrown away.
 *
 * Uses the same real-store pattern as reflector-persist.test.ts: a real git
 * repo + the real proposals/candidate-lessons tables (PGlite backend), not
 * mocked collaborators.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { VerdictedSuggestion } from '../reflector'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-corroboration-floor-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const countProposals = async (): Promise<number> => {
  const { listProposals } = await import('../../proposals')
  return (await listProposals()).length
}

const baseOutcome = {
  type: 'leverGap' as const,
  leverGap: {
    proposedLeverId: 'verify.retry-budget',
    family: 'verify',
    whatItWouldControl: 'the verify-step retry budget',
  },
}

const makeSuggestion = (overrides: Partial<VerdictedSuggestion> = {}): VerdictedSuggestion => ({
  title: 'Retry flaky verify step',
  prompt: 'Add a retry to the verify step. Save your work.',
  rationale: 'Verify occasionally fails on a transient network blip.',
  rootCauseKey: 'flaky_verify_retry',
  affectedTaskIds: ['task-a'],
  frequency: 1,
  confidence: 0.6,
  kind: 'mechanical',
  verdict: 'save',
  targetId: null,
  dupOf: null,
  coversInstances: ['task-a'],
  doesNotClaim: 'observed only in this arc; no evidence of fleet-wide frequency',
  outcome: baseOutcome,
  ...overrides,
})

describe('applyVerdicts — corroboration floor (ADR-0099)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('an n=1 (single-arc) suggestion does not create a proposal', async () => {
    const { applyVerdicts } = await import('../reflector')

    const result = await applyVerdicts([makeSuggestion()], 'src-task-1', {
      arcId: 'arc-1',
    })

    expect(result.saved).toBe(0)
    expect(result.heldBelowFloor).toBe(1)
    expect(await countProposals()).toBe(0)
  })

  it('records the held-below-floor suggestion via recordCandidateLesson', async () => {
    const { applyVerdicts } = await import('../reflector')
    const { listCandidateLessons } = await import('../candidate-lessons')

    await applyVerdicts([makeSuggestion()], 'src-task-1', { arcId: 'arc-1' })

    const lessons = await listCandidateLessons()
    expect(lessons).toHaveLength(1)
    expect(lessons[0]!.arcIds).toEqual(['arc-1'])
    expect(lessons[0]!.observationCount).toBe(1)
    expect(lessons[0]!.title).toBe('Retry flaky verify step')
  })

  it('re-inducing from the same arc does not grow corroboration or create a proposal', async () => {
    const { applyVerdicts } = await import('../reflector')
    const { listCandidateLessons } = await import('../candidate-lessons')

    await applyVerdicts([makeSuggestion()], 'src-task-1', { arcId: 'arc-1' })
    const result = await applyVerdicts([makeSuggestion()], 'src-task-1', { arcId: 'arc-1' })

    expect(result.saved).toBe(0)
    expect(result.heldBelowFloor).toBe(1)
    const lessons = await listCandidateLessons()
    expect(lessons[0]!.observationCount).toBe(1)
    expect(await countProposals()).toBe(0)
  })

  it('a candidate lesson reaching 3 distinct arcs is promoted to a proposal on the next observation', async () => {
    const { applyVerdicts } = await import('../reflector')
    const { listCandidateLessons } = await import('../candidate-lessons')

    const first = await applyVerdicts([makeSuggestion()], 'src-task-1', { arcId: 'arc-1' })
    const second = await applyVerdicts([makeSuggestion()], 'src-task-2', { arcId: 'arc-2' })
    expect(first.saved).toBe(0)
    expect(second.saved).toBe(0)
    expect(await countProposals()).toBe(0)

    const third = await applyVerdicts([makeSuggestion()], 'src-task-3', { arcId: 'arc-3' })

    expect(third.saved).toBe(1)
    expect(third.heldBelowFloor).toBe(0)
    expect(await countProposals()).toBe(1)

    const lessons = await listCandidateLessons()
    expect(lessons[0]!.observationCount).toBe(3)
    expect(lessons[0]!.arcIds).toEqual(['arc-1', 'arc-2', 'arc-3'])
  })

  it('writes the corroborating instance count back onto the saved suggestion', async () => {
    const { applyVerdicts } = await import('../reflector')

    await applyVerdicts([makeSuggestion()], 'src-task-1', { arcId: 'arc-1' })
    await applyVerdicts([makeSuggestion()], 'src-task-2', { arcId: 'arc-2' })
    const third = await applyVerdicts([makeSuggestion()], 'src-task-3', { arcId: 'arc-3' })

    expect(third.savedSuggestions[0]?.corroboratingInstanceCount).toBe(3)
  })

  it('exempt:true bypasses the floor and lands an n=1 suggestion immediately', async () => {
    const { applyVerdicts } = await import('../reflector')

    const result = await applyVerdicts([makeSuggestion()], 'src-task-1', {
      arcId: 'arc-1',
      exempt: true,
    })

    expect(result.saved).toBe(1)
    expect(result.heldBelowFloor).toBe(0)
    expect(await countProposals()).toBe(1)
  })

  it('exempt suggestions are never recorded as candidate lessons', async () => {
    const { applyVerdicts } = await import('../reflector')
    const { listCandidateLessons } = await import('../candidate-lessons')

    await applyVerdicts([makeSuggestion()], 'src-task-1', { arcId: 'arc-1', exempt: true })

    expect(await listCandidateLessons()).toHaveLength(0)
  })

  it('drop and absorb verdicts are never gated by the floor', async () => {
    const { applyVerdicts } = await import('../reflector')
    const { listCandidateLessons } = await import('../candidate-lessons')

    const result = await applyVerdicts(
      [
        makeSuggestion({ verdict: 'drop', rootCauseKey: 'dropped_one' }),
        makeSuggestion({ verdict: 'absorb', rootCauseKey: 'absorbed_one' }),
      ],
      'src-task-1',
      { arcId: 'arc-1' },
    )

    expect(result.dropped).toBe(1)
    expect(result.absorbed).toBe(1)
    expect(result.heldBelowFloor).toBe(0)
    expect(await listCandidateLessons()).toHaveLength(0)
    expect(await countProposals()).toBe(0)
  })
})
