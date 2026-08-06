/**
 * DocumentWriteCoordinator — per-unit serialization for structured writes.
 *
 * Acceptance criteria verified here:
 *
 *   AC1. Two operations with DIFFERENT unit paths execute concurrently.
 *   AC2. Two operations with the SAME unit path execute sequentially.
 *   AC3. Vision writes are serialized against other vision writes (same unit path).
 *   AC4. A failure in one operation does not prevent the next from running.
 *   AC5. The coordinator's tail map is cleaned up when operations complete (idle state).
 */

import { describe, expect, it } from 'vitest'
import { DocumentWriteCoordinator } from '../document-write-coordinator'

/** Deferred promise: exposes resolve/reject so tests can control timing. */
const deferred = (): {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
} => {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('DocumentWriteCoordinator — concurrency', () => {
  it('AC1: two operations with DIFFERENT unit paths start concurrently (no artificial serialization)', async () => {
    const coordinator = new DocumentWriteCoordinator()
    const order: string[] = []

    // Both operations block on their own barriers; they should start concurrently.
    const barrierA = deferred()
    const barrierB = deferred()

    const promiseA = coordinator.run('path/to/unit-a.md', async () => {
      order.push('a-start')
      await barrierA.promise
      order.push('a-end')
    })

    const promiseB = coordinator.run('path/to/unit-b.md', async () => {
      order.push('b-start')
      await barrierB.promise
      order.push('b-end')
    })

    // Both operations should have started before either barrier resolves.
    // Give the microtask queue a chance to run both starters.
    await Promise.resolve()
    await Promise.resolve()

    expect(order).toContain('a-start')
    expect(order).toContain('b-start')

    // Now unblock both and await completion.
    barrierA.resolve()
    barrierB.resolve()
    await Promise.all([promiseA, promiseB])

    expect(order).toEqual(['a-start', 'b-start', 'a-end', 'b-end'])
  })

  it('AC2: two operations with the SAME unit path execute sequentially', async () => {
    const coordinator = new DocumentWriteCoordinator()
    const order: string[] = []

    const barrierA = deferred()

    const promiseA = coordinator.run('glossary/CONTEXT.md', async () => {
      order.push('a-start')
      await barrierA.promise
      order.push('a-end')
    })

    const promiseB = coordinator.run('glossary/CONTEXT.md', async () => {
      order.push('b-start')
      order.push('b-end')
    })

    // Flush microtasks — A started but B should NOT start yet (blocked by A).
    await Promise.resolve()
    await Promise.resolve()

    expect(order).toContain('a-start')
    expect(order).not.toContain('b-start')

    // Unblock A; B should now run.
    barrierA.resolve()
    await Promise.all([promiseA, promiseB])

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('AC3: vision writes are serialized against each other via the same VISION_PATH unit', async () => {
    const coordinator = new DocumentWriteCoordinator()
    const VISION_PATH = 'docs/knowledge/vision.md'
    const order: string[] = []

    const firstBarrier = deferred()

    const first = coordinator.run(VISION_PATH, async () => {
      order.push('vision-1-start')
      await firstBarrier.promise
      order.push('vision-1-end')
    })

    const second = coordinator.run(VISION_PATH, async () => {
      order.push('vision-2-start')
      order.push('vision-2-end')
    })

    await Promise.resolve()
    await Promise.resolve()

    // Second must not have started yet.
    expect(order).toEqual(['vision-1-start'])

    firstBarrier.resolve()
    await Promise.all([first, second])

    expect(order).toEqual(['vision-1-start', 'vision-1-end', 'vision-2-start', 'vision-2-end'])
  })
})

describe('DocumentWriteCoordinator — failure containment', () => {
  it('AC4: a failure in one operation does not prevent the next from running', async () => {
    const coordinator = new DocumentWriteCoordinator()
    const ran: string[] = []

    // First operation rejects.
    const first = coordinator.run('path/unit.md', async () => {
      ran.push('first-started')
      throw new Error('first operation failed')
    })

    // Second operation should still run even though first failed.
    const second = coordinator.run('path/unit.md', async () => {
      ran.push('second-started')
    })

    // First rejects — swallow it so the test doesn't fail on an unhandled rejection.
    await first.catch(() => {})
    await second

    expect(ran).toEqual(['first-started', 'second-started'])
  })

  it('AC4: the returned promise from run() rejects when the operation rejects', async () => {
    const coordinator = new DocumentWriteCoordinator()
    const err = new Error('operation failed')
    const result = coordinator.run('unit.md', async () => {
      throw err
    })
    await expect(result).rejects.toBe(err)
  })
})

describe('DocumentWriteCoordinator — idle cleanup', () => {
  it('AC5: the tail map is empty once all operations for a unit complete', async () => {
    const coordinator = new DocumentWriteCoordinator()

    const op = coordinator.run('unit.md', async () => {})
    await op

    // Access the private map via type cast for the single observable invariant:
    // the coordinator must not leak entries indefinitely.
    const tails = (coordinator as unknown as { tails: Map<string, unknown> }).tails
    expect(tails.size).toBe(0)
  })

  it('AC5: idle cleanup still runs when the operation rejects', async () => {
    const coordinator = new DocumentWriteCoordinator()

    const op = coordinator.run('unit.md', async () => {
      throw new Error('fail')
    })
    await op.catch(() => {})

    const tails = (coordinator as unknown as { tails: Map<string, unknown> }).tails
    expect(tails.size).toBe(0)
  })
})

describe('DocumentWriteCoordinator — ADR concurrent model', () => {
  it('AC4 (ADR model): N operations with distinct unit paths all run concurrently', async () => {
    const coordinator = new DocumentWriteCoordinator()
    const started: string[] = []
    const barriers = ['0001-init.md', '0002-arch.md', '0003-db.md'].map(
      (path) => ({ path, barrier: deferred() }),
    )

    const promises = barriers.map(({ path, barrier }) =>
      coordinator.run(`docs/knowledge/decisions/${path}`, async () => {
        started.push(path)
        await barrier.promise
      }),
    )

    // All three should start before any barrier resolves.
    await Promise.resolve()
    await Promise.resolve()

    expect(started).toHaveLength(3)
    expect(started).toContain('0001-init.md')
    expect(started).toContain('0002-arch.md')
    expect(started).toContain('0003-db.md')

    // Unblock all.
    barriers.forEach(({ barrier }) => barrier.resolve())
    await Promise.all(promises)
  })
})
