import { describe, expect, it } from 'vitest'
import { blamedPhaseOf, buildStepRail } from './stepRailModel'
import type { StepCardEntry } from './TaskDetailDrawer'

const card = (over: Partial<StepCardEntry> & { stepName: string }): StepCardEntry => ({
  key: over.stepName,
  phase: null,
  outcome: 'completed',
  startedAt: '2026-01-01T00:00:00Z',
  endedAt: '2026-01-01T00:00:03Z',
  durationMs: 3200,
  workerName: null,
  ...over,
})

describe('buildStepRail', () => {
  it('formats a fully-completed arc in order', () => {
    const rail = buildStepRail([
      card({ stepName: 'setup', durationMs: 117 }),
      card({ stepName: 'code', durationMs: 53 * 60_000 + 26_000, inputTokens: 100, outputTokens: 50 }),
      card({ stepName: 'verify', durationMs: 3200 }),
    ])
    expect(rail.rows.map((r) => r.card.stepName)).toEqual(['setup', 'code', 'verify'])
    expect(rail.rows.map((r) => r.durationLabel)).toEqual(['117ms', '53m 26s', '3.2s'])
    expect(rail.rows.every((r) => r.outcomeLabel === 'done')).toBe(true)
    expect(rail.rows[1]!.tokensLabel).toContain('out')
    expect(rail.rows[0]!.tokensLabel).toBeNull()
    expect(rail.blamedPhaseGap).toBeNull()
  })

  it('leaves the duration empty for a step in flight', () => {
    const rail = buildStepRail([
      card({ stepName: 'setup' }),
      card({ stepName: 'code', outcome: 'running', endedAt: null, durationMs: null }),
    ])
    expect(rail.rows[1]!.durationLabel).toBeNull()
    expect(rail.rows[1]!.outcomeLabel).toBe('running…')
  })

  it('names the blamed phase when it left no step of its own', () => {
    const rail = buildStepRail(
      [card({ stepName: 'setup' }), card({ stepName: 'verify', outcome: 'failed' })],
      blamedPhaseOf('merge:preflight'),
    )
    expect(rail.blamedPhaseGap).toBe('merge')
    expect(rail.rows[1]!.outcomeLabel).toBe('failed')
  })

  it('does not report a gap when a step carries the blamed name', () => {
    const rail = buildStepRail([card({ stepName: 'verify', outcome: 'failed' })], 'verify')
    expect(rail.blamedPhaseGap).toBeNull()
  })

  it('numbers attempts only for repeated steps', () => {
    const rail = buildStepRail([
      card({ key: 'a', stepName: 'setup-worktree', outcome: 'failed' }),
      card({ key: 'b', stepName: 'setup-worktree', outcome: 'failed' }),
      card({ key: 'c', stepName: 'code' }),
    ])
    expect(rail.rows.map((r) => [r.attempt, r.attemptsTotal])).toEqual([
      [1, 2],
      [2, 2],
      [undefined, undefined],
    ])
  })

  it('handles a single-task arc with one step and no blame', () => {
    const rail = buildStepRail([card({ stepName: 'code' })], null)
    expect(rail.rows).toHaveLength(1)
    expect(rail.rows[0]!.attempt).toBeUndefined()
    expect(rail.blamedPhaseGap).toBeNull()
  })
})

describe('blamedPhaseOf', () => {
  it('extracts a known phase before the colon', () => {
    expect(blamedPhaseOf('Merge:preflight')).toBe('merge')
  })
  it('returns null for unknown or empty signatures', () => {
    expect(blamedPhaseOf('boom:x')).toBeNull()
    expect(blamedPhaseOf('')).toBeNull()
    expect(blamedPhaseOf(null)).toBeNull()
  })
})
