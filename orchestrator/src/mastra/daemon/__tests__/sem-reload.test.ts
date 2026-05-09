import { describe, expect, it } from 'vitest'
import { acquire, makeSem, release, setSemLimit } from '../server'

describe('setSemLimit', () => {
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
