/**
 * Regression tests for the signature-storm circuit breaker's daemon-side
 * controller.
 *
 * The incident these lock down: the breaker tripped, paused dispatch, and woke
 * a write-capable Steward that exited having produced zero commits, a clean
 * worktree and zero `steward_ledger` rows. Nothing recorded that it had done
 * nothing, and resume was wired only to the success path — so dispatch stayed
 * dead for the full 30-minute fallback bound with 34 tasks queued behind it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPauseController } from '../pause-state'
import type { StewardLedgerEntry } from '../../steward-ledger'
import {
  STORM_FALLBACK_GRACE_MS,
  STORM_STEWARD_ATTEMPTS_PER_SIGNATURE,
  createStormBreaker,
  resolveStormFallbackResumeMs,
  stormEscalationSignature,
  type StormBreakerDeps,
  type StormEscalation,
  type StormStewardReport,
  type StormTrip,
} from '../storm-breaker'

const TRIP: StormTrip = {
  signature: 'code/uncommitted-changes',
  streak: 3,
  lastTaskId: 'mars-deadbeef',
}

const report = (over: Partial<StormStewardReport> = {}): StormStewardReport => ({
  outcome: 'no-op',
  stewardId: 'steward-storm-ms99kw83',
  branch: 'task/steward-storm-ms99kw83',
  worktree: '/tmp/.mars/worktrees/steward-storm-ms99kw83',
  rationale: 'exited clean but left ZERO commits',
  commitSha: null,
  evidenceUsable: true,
  ...over,
})

interface Harness {
  deps: StormBreakerDeps
  ledger: StewardLedgerEntry[]
  escalations: StormEscalation[]
  logs: string[]
  breakerFlagClears: number
  resumedCalls: number
}

const harness = (
  runSteward: (trip: StormTrip) => Promise<StormStewardReport>,
  over: Partial<StormBreakerDeps> = {},
): Harness => {
  const state = {
    ledger: [] as StewardLedgerEntry[],
    escalations: [] as StormEscalation[],
    logs: [] as string[],
    breakerFlagClears: 0,
    resumedCalls: 0,
  }
  const deps: StormBreakerDeps = {
    log: (m) => state.logs.push(m),
    pause: createPauseController(),
    clearBreakerFlag: async () => {
      state.breakerFlagClears += 1
    },
    onResumed: () => {
      state.resumedCalls += 1
    },
    runSteward,
    recordLedger: async (entry) => {
      state.ledger.push(entry)
      return 'ledger-id'
    },
    raiseEscalation: async (escalation) => {
      state.escalations.push(escalation)
    },
    fallbackResumeMs: 12 * 60_000,
    ...over,
  }
  return {
    deps,
    get ledger() {
      return state.ledger
    },
    get escalations() {
      return state.escalations
    },
    get logs() {
      return state.logs
    },
    get breakerFlagClears() {
      return state.breakerFlagClears
    },
    get resumedCalls() {
      return state.resumedCalls
    },
  }
}

const ledgerState = (entry: StewardLedgerEntry): string =>
  (JSON.parse(entry.outcome) as { state: string }).state

describe('storm breaker — a Steward that produces nothing', () => {
  it('resumes dispatch immediately and records a no-op ledger outcome', async () => {
    const h = harness(async () => report({ outcome: 'no-op' }))
    const breaker = createStormBreaker(h.deps)

    breaker.onTrip(TRIP)
    // The pause is taken synchronously so drain() cannot slip work through.
    expect(h.deps.pause.get()).toMatchObject({ paused: true, reason: 'storm' })

    await breaker.settled()

    // Resume happened on the REPORT, with no timer advanced at all.
    expect(h.deps.pause.isPaused()).toBe(false)
    expect(h.breakerFlagClears).toBe(1)
    expect(h.resumedCalls).toBe(1)

    // …and the no-op is now a fact, not an absence of evidence.
    expect(h.ledger).toHaveLength(1)
    expect(h.ledger[0]).toMatchObject({
      targetKind: 'signature-storm',
      targetId: 'code/uncommitted-changes',
      recipeId: 'signature-storm-steward',
      rationale: 'exited clean but left ZERO commits',
      commitSha: null,
    })
    expect(ledgerState(h.ledger[0])).toBe('no-op')
  })

  it('records a terminal outcome even when the Steward run throws', async () => {
    const h = harness(async () => {
      throw new Error('claude: command not found')
    })
    const breaker = createStormBreaker(h.deps)

    breaker.onTrip(TRIP)
    await breaker.settled()

    expect(h.deps.pause.isPaused()).toBe(false)
    expect(h.ledger).toHaveLength(1)
    expect(ledgerState(h.ledger[0])).toBe('failed')
    expect(h.ledger[0].rationale).toContain('claude: command not found')
  })

  it('records a fixed outcome with the landed commit sha', async () => {
    const h = harness(async () =>
      report({ outcome: 'fixed', commitSha: 'abc1234', rationale: 'removed the stale lock' }),
    )
    const breaker = createStormBreaker(h.deps)

    breaker.onTrip(TRIP)
    await breaker.settled()

    expect(ledgerState(h.ledger[0])).toBe('fixed')
    expect(h.ledger[0].commitSha).toBe('abc1234')
    expect(h.deps.pause.isPaused()).toBe(false)
    expect(h.escalations).toHaveLength(0)
  })

  it('marks a no-op caused by a brief with no usable evidence', async () => {
    const h = harness(async () => report({ outcome: 'no-op', evidenceUsable: false }))
    const breaker = createStormBreaker(h.deps)

    breaker.onTrip(TRIP)
    await breaker.settled()

    const outcome = JSON.parse(h.ledger[0].outcome) as { state: string; evidence: string }
    expect(outcome).toMatchObject({ state: 'no-op', evidence: 'insufficient' })
  })
})

describe('storm breaker — the crash/hang fallback', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('resumes a Steward that never reports, after the bounded wait', async () => {
    vi.useFakeTimers()
    try {
      // Never settles: the daemon-level hang the timer exists for.
      const h = harness(() => new Promise<StormStewardReport>(() => {}))
      const breaker = createStormBreaker(h.deps)

      breaker.onTrip(TRIP)
      expect(h.deps.pause.get().reason).toBe('storm')

      // Still paused right up to the bound…
      await vi.advanceTimersByTimeAsync(12 * 60_000 - 1)
      expect(h.deps.pause.isPaused()).toBe(true)

      // …and released on it.
      await vi.advanceTimersByTimeAsync(1)
      expect(h.deps.pause.isPaused()).toBe(false)
      expect(h.breakerFlagClears).toBe(1)
      expect(h.logs.some((l) => l.includes('never reported an outcome'))).toBe(true)

      // A hang leaves no ledger row: there is no outcome to record.
      expect(h.ledger).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire after a reported outcome already resumed dispatch', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(async () => report({ outcome: 'no-op' }))
      const breaker = createStormBreaker(h.deps)

      breaker.onTrip(TRIP)
      await breaker.settled()
      expect(h.resumedCalls).toBe(1)

      await vi.advanceTimersByTimeAsync(60 * 60_000)
      // One resume total — the timer was disarmed, not merely ignored.
      expect(h.resumedCalls).toBe(1)
      expect(h.breakerFlagClears).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('arms the fallback for a storm restored at daemon startup', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(async () => report())
      const breaker = createStormBreaker(h.deps)

      h.deps.pause.pause('storm', 'restored at startup')
      breaker.armFallback('code/uncommitted-changes')

      await vi.advanceTimersByTimeAsync(12 * 60_000)
      expect(h.deps.pause.isPaused()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('derives the bound from the Steward budget so it cannot race a healthy run', () => {
    delete process.env.MARS_STORM_RESUME_MS
    expect(resolveStormFallbackResumeMs(10 * 60_000)).toBe(10 * 60_000 + STORM_FALLBACK_GRACE_MS)
    process.env.MARS_STORM_RESUME_MS = '90000'
    try {
      expect(resolveStormFallbackResumeMs(10 * 60_000)).toBe(90_000)
    } finally {
      delete process.env.MARS_STORM_RESUME_MS
    }
  })
})

describe('storm breaker — pause ownership', () => {
  it('a storm resume never clears an operator pause', async () => {
    const h = harness(async () => report({ outcome: 'no-op' }))
    const breaker = createStormBreaker(h.deps)

    // Operator pause holds the first-cause slot.
    expect(h.deps.pause.pause('operator', 'operator dispatch pause')).toBe(true)

    breaker.onTrip(TRIP)
    await breaker.settled()

    expect(h.deps.pause.get()).toMatchObject({ paused: true, reason: 'operator' })
    // No Steward was dispatched and no half of the pause state was touched.
    expect(h.ledger).toHaveLength(0)
    expect(h.breakerFlagClears).toBe(0)
    expect(h.resumedCalls).toBe(0)
    expect(h.logs.some((l) => l.includes('already paused (operator)'))).toBe(true)
  })

  it('an explicit resume() is a no-op while an operator pause holds dispatch', async () => {
    const h = harness(async () => report())
    const breaker = createStormBreaker(h.deps)

    h.deps.pause.pause('operator', 'operator dispatch pause')
    await breaker.resume('successful task mars-1234')

    expect(h.deps.pause.get()).toMatchObject({ paused: true, reason: 'operator' })
    expect(h.breakerFlagClears).toBe(0)
  })

  it('resumes anyway when the ledger write fails', async () => {
    const h = harness(async () => report({ outcome: 'no-op' }), {
      recordLedger: async () => {
        throw new Error('pg down')
      },
    })
    const breaker = createStormBreaker(h.deps)

    breaker.onTrip(TRIP)
    await breaker.settled()

    expect(h.deps.pause.isPaused()).toBe(false)
    expect(h.logs.some((l) => l.includes('ledger write failed'))).toBe(true)
  })
})

describe('storm breaker — escalation instead of silent cycling', () => {
  it('spends a bounded Steward budget, then escalates and stops pausing', async () => {
    const h = harness(async () => report({ outcome: 'no-op' }))
    const breaker = createStormBreaker(h.deps)

    for (let i = 0; i < STORM_STEWARD_ATTEMPTS_PER_SIGNATURE; i += 1) {
      breaker.onTrip(TRIP)
      await breaker.settled()
      expect(h.deps.pause.isPaused()).toBe(false)
    }
    expect(h.ledger).toHaveLength(STORM_STEWARD_ATTEMPTS_PER_SIGNATURE)
    expect(h.escalations).toHaveLength(1)
    expect(h.escalations[0]).toMatchObject({
      signature: 'code/uncommitted-changes',
      attempts: STORM_STEWARD_ATTEMPTS_PER_SIGNATURE,
      lastOutcome: 'no-op',
    })

    // The next trip on the SAME signature must not pause, must not spawn a
    // third Steward worktree, and must not leave the durable flag set.
    const ledgerBefore = h.ledger.length
    breaker.onTrip({ ...TRIP, streak: 4 })
    expect(h.deps.pause.isPaused()).toBe(false)
    await breaker.settled()

    expect(h.ledger).toHaveLength(ledgerBefore)
    expect(h.escalations).toHaveLength(2)
    expect(h.logs.some((l) => l.includes('re-tripped while escalated'))).toBe(true)
    // Durable breaker flag cleared without a pause, so future trips still fire
    // and a restart does not come up wedged.
    expect(h.breakerFlagClears).toBe(STORM_STEWARD_ATTEMPTS_PER_SIGNATURE + 1)
  })

  it('a fix restores the full Steward budget for that signature', async () => {
    let outcome: StormStewardReport['outcome'] = 'no-op'
    const h = harness(async () => report({ outcome }))
    const breaker = createStormBreaker(h.deps)

    breaker.onTrip(TRIP)
    await breaker.settled()
    expect(h.escalations).toHaveLength(0)

    outcome = 'fixed'
    breaker.onTrip(TRIP)
    await breaker.settled()

    // Budget reset: the next unresolved run is attempt 1 again, not the last.
    outcome = 'no-op'
    breaker.onTrip(TRIP)
    await breaker.settled()
    expect(h.escalations).toHaveLength(0)
  })

  it('keeps distinct signatures on independent budgets', async () => {
    const h = harness(async () => report({ outcome: 'no-op' }))
    const breaker = createStormBreaker(h.deps)

    breaker.onTrip(TRIP)
    await breaker.settled()
    breaker.onTrip({ ...TRIP, signature: 'verify/unclassified' })
    await breaker.settled()

    expect(h.escalations).toHaveLength(0)
    expect(h.deps.pause.isPaused()).toBe(false)
  })

  it('keys the escalation row on its own dedup signature', () => {
    expect(stormEscalationSignature('code/uncommitted-changes')).toBe(
      'signature-storm-unresolved:code/uncommitted-changes',
    )
  })
})
