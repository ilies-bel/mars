import { describe, expect, it } from 'vitest'
import { acquire, makeSem, release, setSemLimit } from '../semaphore'

describe('setSemLimit', () => {
  it('re-drives queued dispatch when a cap increase creates capacity without semaphore waiters', async () => {
    const sem = makeSem(1)
    const queued = ['already-running', 'next', 'after-next']
    const dispatched: string[] = []
    const drain = (): void => {
      while (sem.inUse < sem.limit && queued.length > 0) {
        const taskId = queued.shift()
        if (!taskId) break
        void acquire(sem).then(() => dispatched.push(taskId))
      }
    }

    // The initial drain starts one task and leaves eligible work in its own
    // pending queue, not parked in the semaphore's waiter list.
    drain()
    await Promise.resolve()
    expect(dispatched).toEqual(['already-running'])
    expect(queued).toEqual(['next', 'after-next'])

    ;(sem as typeof sem & { onLimitIncrease?: () => void }).onLimitIncrease = drain
    setSemLimit(sem, 3)

    await Promise.resolve()
    expect(dispatched).toEqual(['already-running', 'next', 'after-next'])
    expect(queued).toEqual([])
  })

  it('wakes min(delta, waiters) waiters when raising the cap', async () => {
    const sem = makeSem(1)
    // Saturate
    await acquire(sem)
    expect(sem.inUse).toBe(1)

    // Two waiters queued
    let resolved1 = false
    let resolved2 = false
    const w1 = acquire(sem).then(() => {
      resolved1 = true
    })
    const w2 = acquire(sem).then(() => {
      resolved2 = true
    })
    expect(sem.waiters.length).toBe(2)

    // Raise by 1: should wake exactly one waiter
    setSemLimit(sem, 2)
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved1).toBe(true)
    expect(resolved2).toBe(false)
    expect(sem.inUse).toBe(2)
    expect(sem.waiters.length).toBe(1)

    // Raise by 1 again: wake the second
    setSemLimit(sem, 3)
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved2).toBe(true)
    expect(sem.inUse).toBe(3)
    expect(sem.waiters.length).toBe(0)

    await Promise.all([w1, w2])
  })

  it('wakes at most `waiters.length` even if delta is larger', async () => {
    const sem = makeSem(1)
    await acquire(sem)
    let resolved = false
    const w = acquire(sem).then(() => {
      resolved = true
    })
    expect(sem.waiters.length).toBe(1)

    // Raise by 10 with only 1 waiter
    setSemLimit(sem, 11)
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(true)
    expect(sem.waiters.length).toBe(0)
    // inUse only ticks up by the count actually woken (1), not by delta (10)
    expect(sem.inUse).toBe(2)

    await w
  })

  it('lowering the limit while inUse > newLimit does not crash and does not cancel in-flight work', async () => {
    const sem = makeSem(4)
    await acquire(sem)
    await acquire(sem)
    await acquire(sem)
    expect(sem.inUse).toBe(3)

    setSemLimit(sem, 1)
    expect(sem.limit).toBe(1)
    // No crash; in-flight count untouched.
    expect(sem.inUse).toBe(3)

    // A new acquire while inUse > limit must queue.
    let acquired = false
    const w = acquire(sem).then(() => {
      acquired = true
    })
    await Promise.resolve()
    expect(acquired).toBe(false)
    expect(sem.waiters.length).toBe(1)

    // Releasing one slot at a time: inUse=3->2 (still > 1, no hand-off via the
    // pure-decrement path). With the existing release() implementation, the
    // waiter is handed the freed slot directly and resolves.
    release(sem)
    await Promise.resolve()
    expect(acquired).toBe(true)

    await w
  })

  it('throws on non-positive newLimit', () => {
    const sem = makeSem(1)
    expect(() => setSemLimit(sem, 0)).toThrow('limit must be a positive integer')
    expect(() => setSemLimit(sem, -1)).toThrow('limit must be a positive integer')
    expect(() => setSemLimit(sem, 1.5)).toThrow(
      'limit must be a positive integer',
    )
  })
})

describe('phantom-watchdog reclaim must not double-release the implement sem', () => {
  // Regression: the phantom-task watchdog's reclaim callback used to call BOTH
  // tracker.forceRelease(id) AND release(sems[kind]). But for an alive-but-
  // stalled verify the task's own dispatchImplement is still awaiting its
  // workflow and WILL release the sem in its `finally`. Releasing in the
  // watchdog too is a second release for one acquire — each spurious release
  // wakes an extra waiter (dispatch past the cap) or drives inUse below the
  // true in-flight count, permanently defeating the implement cap. The fix
  // makes reclaim tracker-only (mirroring handleDrop(force=true)); the
  // dispatcher `finally` is the SOLE sem releaser. These tests model both
  // failure modes with the pure sem primitives.

  it('single releaser keeps inUse correct when a permit is held across a phantom sweep', async () => {
    // cap=1 saturated by one dispatcher holding a permit.
    const sem = makeSem(1)
    await acquire(sem)
    expect(sem.inUse).toBe(1)

    // A second dispatch is queued, correctly blocked by the cap.
    let secondAcquired = false
    const queued = acquire(sem).then(() => {
      secondAcquired = true
    })
    expect(sem.waiters.length).toBe(1)
    expect(secondAcquired).toBe(false)

    // Phantom watchdog fires for the in-flight task. With the fix it does NOT
    // touch the sem (tracker-only forceRelease). So the queued acquire stays
    // blocked — the cap still holds.
    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    expect(sem.waiters.length).toBe(1)

    // The stalled dispatcher's workflow eventually settles; its `finally`
    // releases exactly once, handing the slot to the one waiter.
    release(sem)
    await Promise.resolve()
    expect(secondAcquired).toBe(true)
    expect(sem.inUse).toBe(1) // one out, one in — never above cap, never below 0
    expect(sem.waiters.length).toBe(0)

    await queued
  })

  it('the buggy DOUBLE release would over-dispatch past the cap (guards the regression)', async () => {
    // This test documents WHY the extra release is wrong: if the watchdog
    // released the sem AND the dispatcher `finally` released it, one acquire
    // yields two releases → two waiters wake → concurrency exceeds the cap.
    const sem = makeSem(1)
    await acquire(sem) // the phantom task holds the only permit

    let a = false
    let b = false
    const wa = acquire(sem).then(() => {
      a = true
    })
    const wb = acquire(sem).then(() => {
      b = true
    })
    expect(sem.waiters.length).toBe(2)

    // Simulate the OLD bug: watchdog release + dispatcher finally release = 2.
    // Each release() hands the freed slot directly to a waiter (no inUse bump),
    // so BOTH waiters wake even though only one permit was ever legitimately
    // freed.
    release(sem) // watchdog (the erroneous extra one)
    release(sem) // dispatcher finally
    await Promise.resolve()

    // Both waiters woke: 2 tasks now "running" under a cap of 1 — the exact
    // over-dispatch the fix prevents. And inUse (still 1) now UNDERSTATES the
    // true holder count (2), so the drain gate `inUse < limit` reads false-open
    // and keeps admitting more work — the self-reinforcing cap corruption.
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(sem.inUse).toBe(1) // corrupted: understates the 2 live holders
    expect(sem.limit).toBe(1)

    await Promise.all([wa, wb])
  })
})
