import { describe, expect, it } from 'vitest'
import { RELEVANCE_WEIGHTS, scoreSubjectRelevance } from './relevance-scorer.js'

// Fixed reference timestamp used across all tests for deterministic results.
const NOW = 1_700_000_000_000

const MS_PER_DAY = 86_400_000

describe('scoreSubjectRelevance', () => {
  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('returns exactly 1.0 for a zero-age closure with no other signals', () => {
    const score = scoreSubjectRelevance({
      closedAtMs: NOW,
      nowMs: NOW,
      taskCount: 0,
      resolvedAlert: false,
      producedTokens: 0,
    })
    expect(score).toBe(1.0)
  })

  it('returns below 0.3 for a 28-day-old closure with no activity', () => {
    // exp(-28/14) = exp(-2) ≈ 0.1353 — well under 0.3
    const score = scoreSubjectRelevance({
      closedAtMs: NOW - 28 * MS_PER_DAY,
      nowMs: NOW,
      taskCount: 0,
      resolvedAlert: false,
      producedTokens: 0,
    })
    expect(score).toBeLessThan(0.3)
  })

  it('returns exactly 1.0 when all signals are maxed (clamped)', () => {
    // ageDecay = 1.0 (zero age); taskCount = 5 (≥ threshold); alert = true;
    // tokens = 8000 (≥ threshold). Sum = 1.0 + 0.3 + 0.2 + 0.1 = 1.6 → clamped to 1.0.
    const score = scoreSubjectRelevance({
      closedAtMs: NOW,
      nowMs: NOW,
      taskCount: 5,
      resolvedAlert: true,
      producedTokens: 8_000,
    })
    expect(score).toBe(1.0)
  })

  it('never returns a value above 1.0 regardless of inputs', () => {
    const score = scoreSubjectRelevance({
      closedAtMs: NOW,
      nowMs: NOW,
      taskCount: 100,
      resolvedAlert: true,
      producedTokens: 1_000_000,
    })
    expect(score).toBeLessThanOrEqual(1.0)
  })

  it('never returns a value below 0.0', () => {
    // Negative age (nowMs < closedAtMs) should still be clamped to ≥ 0.
    const score = scoreSubjectRelevance({
      closedAtMs: NOW + 10 * MS_PER_DAY, // closed in the "future"
      nowMs: NOW,
      taskCount: 0,
      resolvedAlert: false,
      producedTokens: 0,
    })
    expect(score).toBeGreaterThanOrEqual(0.0)
  })

  // ── Age-decay dimension ────────────────────────────────────────────────────

  it('score decreases as the Subject ages (age-decay signal)', () => {
    const base = { taskCount: 0, resolvedAlert: false, producedTokens: 0 }
    const fresh = scoreSubjectRelevance({ closedAtMs: NOW - 1 * MS_PER_DAY, nowMs: NOW, ...base })
    const week = scoreSubjectRelevance({ closedAtMs: NOW - 7 * MS_PER_DAY, nowMs: NOW, ...base })
    const month = scoreSubjectRelevance({ closedAtMs: NOW - 28 * MS_PER_DAY, nowMs: NOW, ...base })

    expect(fresh).toBeGreaterThan(week)
    expect(week).toBeGreaterThan(month)
  })

  // ── taskCount dimension ────────────────────────────────────────────────────

  it('score increases when the Subject queued tasks (taskCount signal)', () => {
    const base = { closedAtMs: NOW - 7 * MS_PER_DAY, nowMs: NOW, resolvedAlert: false, producedTokens: 0 }
    const noTasks = scoreSubjectRelevance({ ...base, taskCount: 0 })
    const someTasks = scoreSubjectRelevance({ ...base, taskCount: 3 })

    expect(someTasks).toBeGreaterThan(noTasks)
    // Difference should be proportional to the weight.
    expect(someTasks - noTasks).toBeCloseTo((3 / 5) * RELEVANCE_WEIGHTS.taskCount, 10)
  })

  it('taskCount bonus caps at RELEVANCE_WEIGHTS.taskCount when count ≥ 5', () => {
    const base = { closedAtMs: NOW - 7 * MS_PER_DAY, nowMs: NOW, resolvedAlert: false, producedTokens: 0 }
    const five = scoreSubjectRelevance({ ...base, taskCount: 5 })
    const ten = scoreSubjectRelevance({ ...base, taskCount: 10 })

    // Beyond the saturation threshold the bonus stops growing.
    expect(five).toBe(ten)
  })

  // ── resolvedAlert dimension ────────────────────────────────────────────────

  it('score increases when the Subject resolved an alert (alert signal)', () => {
    const base = { closedAtMs: NOW - 7 * MS_PER_DAY, nowMs: NOW, taskCount: 0, producedTokens: 0 }
    const noAlert = scoreSubjectRelevance({ ...base, resolvedAlert: false })
    const withAlert = scoreSubjectRelevance({ ...base, resolvedAlert: true })

    expect(withAlert).toBeGreaterThan(noAlert)
    expect(withAlert - noAlert).toBeCloseTo(RELEVANCE_WEIGHTS.alert, 10)
  })

  // ── producedTokens dimension ───────────────────────────────────────────────

  it('score increases with higher producedTokens (tokens signal)', () => {
    const base = { closedAtMs: NOW - 7 * MS_PER_DAY, nowMs: NOW, taskCount: 0, resolvedAlert: false }
    const noTokens = scoreSubjectRelevance({ ...base, producedTokens: 0 })
    const someTokens = scoreSubjectRelevance({ ...base, producedTokens: 4_000 })

    expect(someTokens).toBeGreaterThan(noTokens)
    expect(someTokens - noTokens).toBeCloseTo((4_000 / 8_000) * RELEVANCE_WEIGHTS.tokens, 10)
  })

  it('token bonus exhibits diminishing returns (caps at RELEVANCE_WEIGHTS.tokens)', () => {
    const base = { closedAtMs: NOW - 7 * MS_PER_DAY, nowMs: NOW, taskCount: 0, resolvedAlert: false }
    const saturated = scoreSubjectRelevance({ ...base, producedTokens: 8_000 })
    const beyond = scoreSubjectRelevance({ ...base, producedTokens: 80_000 })

    expect(saturated).toBe(beyond)
  })
})
