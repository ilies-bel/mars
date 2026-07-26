/**
 * Unit tests for decideDispatchControl — the pure spend-controller decision function.
 *
 * Tests verify observable behaviour through the public interface only.
 * No mocking of internal state; the function is pure, so we pass all signals
 * explicitly and assert on the returned decision object.
 */

import { describe, expect, it } from 'vitest'
import { decideDispatchControl } from './decide.js'
import type { DecisionInputs } from './decide.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseLevers = {
  perKindCeilings: null,
  pauseThresholdPct: 90,
  resumeThresholdPct: 70,
  suppressRecovery: false,
  rampBackStepPct: 10,
}

const healthOk = { recentRecoveryFailures: 0 }
const breakerClosed = { open: false, reason: null, openedAt: null }

function makeInputs(overrides: Partial<DecisionInputs> = {}): DecisionInputs {
  return {
    spendWindow: { usedPct: 50, wasPaused: false },
    breaker: breakerClosed,
    health: healthOk,
    levers: baseLevers,
    nowMs: 1_700_000_000_000,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('decideDispatchControl — below pause threshold (allow)', () => {
  it('returns paused=false when spend is comfortably below the pause threshold', () => {
    const decision = decideDispatchControl(makeInputs({ spendWindow: { usedPct: 50, wasPaused: false } }))

    expect(decision.paused).toBe(false)
    expect(decision.rampBackFactor).toBe(1)
    expect(decision.suppressRecovery).toBe(false)
    expect(decision.reason).toMatch(/within budget/i)
  })

  it('passes through perKindCeilings from levers when set', () => {
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 40, wasPaused: false },
        levers: { ...baseLevers, perKindCeilings: { coder: 8, triage: 4 } },
      }),
    )

    expect(decision.paused).toBe(false)
    expect(decision.perKindCeilings).toEqual({ coder: 8, triage: 4 })
  })

  it('returns empty perKindCeilings record when levers.perKindCeilings is null', () => {
    const decision = decideDispatchControl(makeInputs({ levers: { ...baseLevers, perKindCeilings: null } }))

    expect(decision.perKindCeilings).toEqual({})
  })
})

describe('decideDispatchControl — crossing pause threshold', () => {
  it('pauses when usedPct equals the pause threshold', () => {
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 90, wasPaused: false } }),
    )

    expect(decision.paused).toBe(true)
    expect(decision.suppressRecovery).toBe(true)
  })

  it('pauses when usedPct exceeds the pause threshold', () => {
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 95, wasPaused: false } }),
    )

    expect(decision.paused).toBe(true)
  })

  it('reason string cites spend when paused due to threshold', () => {
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 92, wasPaused: false } }),
    )

    expect(decision.reason).toMatch(/spend/i)
    expect(decision.reason).toMatch(/92/)
  })

  it('rampBackFactor is 0 when paused due to spend threshold', () => {
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 91, wasPaused: false } }),
    )

    expect(decision.rampBackFactor).toBe(0)
  })
})

describe('decideDispatchControl — circuit-breaker tripped', () => {
  it('pauses when the circuit breaker is open', () => {
    const decision = decideDispatchControl(
      makeInputs({
        breaker: { open: true, reason: 'connection refused', openedAt: 1_700_000_000_000 },
      }),
    )

    expect(decision.paused).toBe(true)
    expect(decision.suppressRecovery).toBe(true)
  })

  it('reason cites the breaker when paused due to circuit breaker', () => {
    const decision = decideDispatchControl(
      makeInputs({
        breaker: { open: true, reason: 'connection refused', openedAt: 1_700_000_000_000 },
      }),
    )

    expect(decision.reason).toMatch(/circuit breaker/i)
    expect(decision.reason).toMatch(/connection refused/)
  })

  it('breaker takes priority over spend threshold', () => {
    // Both the breaker and spend threshold are triggered — breaker should win.
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 95, wasPaused: false },
        breaker: { open: true, reason: 'quota exhausted', openedAt: 1_700_000_000_000 },
      }),
    )

    expect(decision.paused).toBe(true)
    expect(decision.reason).toMatch(/circuit breaker/i)
  })
})

describe('decideDispatchControl — health degraded', () => {
  it('sets suppressRecovery=true when recentRecoveryFailures reaches 3', () => {
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 50, wasPaused: false },
        health: { recentRecoveryFailures: 3 },
      }),
    )

    expect(decision.paused).toBe(false)
    expect(decision.suppressRecovery).toBe(true)
  })

  it('sets suppressRecovery=true when recentRecoveryFailures exceeds 3', () => {
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 50, wasPaused: false },
        health: { recentRecoveryFailures: 5 },
      }),
    )

    expect(decision.suppressRecovery).toBe(true)
  })

  it('suppressRecovery is false when recentRecoveryFailures is below 3', () => {
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 50, wasPaused: false },
        health: { recentRecoveryFailures: 2 },
      }),
    )

    expect(decision.suppressRecovery).toBe(false)
  })

  it('levers.suppressRecovery overrides health counter check', () => {
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 50, wasPaused: false },
        health: { recentRecoveryFailures: 0 },
        levers: { ...baseLevers, suppressRecovery: true },
      }),
    )

    expect(decision.suppressRecovery).toBe(true)
  })
})

describe('decideDispatchControl — returning below resume threshold after pause', () => {
  it('unpauses when spend drops below resume threshold after being paused', () => {
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 65, wasPaused: true } }),
    )

    expect(decision.paused).toBe(false)
  })

  it('rampBackFactor is less than 1 when ramping back after a pause', () => {
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 65, wasPaused: true } }),
    )

    expect(decision.rampBackFactor).toBeGreaterThan(0)
    expect(decision.rampBackFactor).toBeLessThan(1)
  })

  it('rampBackFactor equals rampBackStepPct / 100', () => {
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 65, wasPaused: true },
        levers: { ...baseLevers, rampBackStepPct: 20 },
      }),
    )

    expect(decision.rampBackFactor).toBe(0.2)
  })

  it('stays paused while wasPaused=true and spend is in the hysteresis band', () => {
    // usedPct=75 is below pauseThreshold (90) but above resumeThreshold (70) — hold.
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 75, wasPaused: true } }),
    )

    expect(decision.paused).toBe(true)
  })

  it('reason string mentions resume threshold when ramping back', () => {
    const decision = decideDispatchControl(
      makeInputs({ spendWindow: { usedPct: 65, wasPaused: true } }),
    )

    expect(decision.reason).toMatch(/resume threshold/i)
  })
})

describe('decideDispatchControl — suppressRecovery derivation', () => {
  it('is always true when paused', () => {
    // Paused via spend threshold, levers.suppressRecovery=false
    const decision = decideDispatchControl(
      makeInputs({
        spendWindow: { usedPct: 91, wasPaused: false },
        levers: { ...baseLevers, suppressRecovery: false },
        health: { recentRecoveryFailures: 0 },
      }),
    )

    expect(decision.paused).toBe(true)
    expect(decision.suppressRecovery).toBe(true)
  })
})
