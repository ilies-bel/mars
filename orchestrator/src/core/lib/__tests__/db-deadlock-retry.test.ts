import { describe, expect, it } from 'vitest'
import { withDeadlockRetry } from '../db.js'

/**
 * Regression coverage for the deadlock-retry seam (db.ts). A real
 * cross-transaction deadlock cannot be provoked on the PGlite test backend
 * (every op serializes behind a single-session mutex), so we exercise the
 * retry CONTRACT directly: the embedded backend wraps every `query` and
 * `transaction` in `withDeadlockRetry`, which is what unfroze the daemon whose
 * concurrent reconcile / dispatch-poll-fallback / phantom-watchdog passes were
 * all dying as deadlock victims.
 */

const deadlock = (): Error => Object.assign(new Error('deadlock detected'), { code: '40P01' })

describe('withDeadlockRetry', () => {
  it('returns the value without retrying when the op succeeds first try', async () => {
    let calls = 0
    const result = await withDeadlockRetry(async () => {
      calls += 1
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries a deadlock victim and returns once it succeeds', async () => {
    let calls = 0
    const result = await withDeadlockRetry(async () => {
      calls += 1
      if (calls < 4) throw deadlock()
      return calls
    })
    expect(result).toBe(4)
    expect(calls).toBe(4)
  })

  it('does not retry a non-deadlock error — it surfaces immediately', async () => {
    let calls = 0
    await expect(
      withDeadlockRetry(async () => {
        calls += 1
        throw Object.assign(new Error('unique violation'), { code: '23505' })
      }),
    ).rejects.toThrow('unique violation')
    expect(calls).toBe(1)
  })

  it('gives up after the bounded retry budget so a persistent deadlock still surfaces', async () => {
    let calls = 0
    await expect(
      withDeadlockRetry(async () => {
        calls += 1
        throw deadlock()
      }),
    ).rejects.toMatchObject({ code: '40P01' })
    // 1 initial attempt + DEADLOCK_MAX_RETRIES (8) retries = 9 total.
    expect(calls).toBe(9)
  })
})
