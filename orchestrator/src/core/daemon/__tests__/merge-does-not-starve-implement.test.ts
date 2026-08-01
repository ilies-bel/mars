/**
 * Regression test: merge-parked tasks do not starve coder dispatch.
 *
 * When a task enters the merge step it releases its `sems.implement` slot so
 * other coders can proceed. This file verifies:
 *
 *   1. 5 tasks parked in the merge phase hold ZERO implement slots — new
 *      dispatches can acquire `sems.implement` up to cap immediately.
 *   2. `inFlightSnapshot()` reports `kind: 'merge'` for merge-parked tasks
 *      (the phantom-task watchdog therefore sees them correctly).
 *   3. Releasing merge tracking (e.g. when the merge job finishes) removes
 *      the entry from the snapshot.
 *
 * The test is intentionally isolated: it uses only `makeSem`, `acquire`,
 * `release` from server.ts and `createTaskFlightTracker` from
 * task-flight-tracker.ts. No DB, no EventEmitter, no real workflows.
 */

import { describe, expect, it } from 'vitest'
import { makeSem, acquire, release } from '../semaphore'
import { createTaskFlightTracker } from '../task-flight-tracker'

const IMPLEMENT_CAP = 3

/**
 * Simulate what `dispatchImplement` does when a task reaches the merge step:
 *   1. acquire(sem)            — grab the implement slot
 *   2. commitInFlight('implement')
 *   3. releaseImpl()           — release implement tracking
 *   4. release(sem)            — free the implement slot
 *   5. commitInFlight('merge') — register merge tracking
 *
 * Returns the merge release closure so tests can later complete the merge.
 */
async function parkInMergeQueue(
  taskId: string,
  tracker: ReturnType<typeof createTaskFlightTracker>,
  sem: ReturnType<typeof makeSem>,
): Promise<() => void> {
  await acquire(sem)
  const releaseImpl = tracker.commitInFlight(taskId, 'implement')
  // Merge handoff: release implement slot and start merge tracking
  releaseImpl()
  release(sem)
  return tracker.commitInFlight(taskId, 'merge')
}

describe('merge does not starve implement dispatch', () => {
  it('5 tasks parked in merging hold zero implement slots, leaving cap available for new dispatches', async () => {
    const tracker = createTaskFlightTracker()
    const sem = makeSem(IMPLEMENT_CAP)

    // Park 5 tasks in the merge queue phase.
    const mergeReleases: Array<() => void> = []
    for (let i = 0; i < 5; i++) {
      mergeReleases.push(await parkInMergeQueue(`merge-${i}`, tracker, sem))
    }

    // All 5 tasks released their implement slots → semaphore is free
    expect(sem.inUse).toBe(0)
    expect(sem.waiters.length).toBe(0)

    // New implement dispatches fill the cap immediately (no starvation)
    const acquirePromises: Promise<void>[] = []
    for (let i = 0; i < IMPLEMENT_CAP; i++) {
      acquirePromises.push(acquire(sem))
    }
    await Promise.all(acquirePromises)
    expect(sem.inUse).toBe(IMPLEMENT_CAP)
    expect(sem.waiters.length).toBe(0)

    // One further request waits (cap is full)
    let extraResolved = false
    const extra = acquire(sem).then(() => {
      extraResolved = true
    })
    await Promise.resolve()
    expect(extraResolved).toBe(false)
    expect(sem.waiters.length).toBe(1)

    // Releasing one implement slot unblocks the waiter
    release(sem)
    await Promise.resolve()
    expect(extraResolved).toBe(true)

    await extra
  })

  it('inFlightSnapshot reports kind=merge for all merge-parked tasks', async () => {
    const tracker = createTaskFlightTracker()
    const sem = makeSem(IMPLEMENT_CAP)

    for (let i = 0; i < 5; i++) {
      await parkInMergeQueue(`merge-${i}`, tracker, sem)
    }

    const snapshot = tracker.inFlightSnapshot()
    expect(snapshot).toHaveLength(5)
    expect(snapshot.every((e) => e.kind === 'merge')).toBe(true)
    expect(snapshot.map((e) => e.taskId).sort()).toEqual([
      'merge-0',
      'merge-1',
      'merge-2',
      'merge-3',
      'merge-4',
    ])
  })

  it('releasing merge tracking removes the entry so the snapshot stays accurate', async () => {
    const tracker = createTaskFlightTracker()
    const sem = makeSem(IMPLEMENT_CAP)

    const releaseM0 = await parkInMergeQueue('merge-0', tracker, sem)
    await parkInMergeQueue('merge-1', tracker, sem)

    expect(tracker.inFlightSnapshot()).toHaveLength(2)

    // Merge job for merge-0 completes
    releaseM0()

    const snapshot = tracker.inFlightSnapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].taskId).toBe('merge-1')
    expect(snapshot[0].kind).toBe('merge')
  })

  it('merge-parked tasks do not hold implement slots alongside N implement in-flight tasks', async () => {
    const tracker = createTaskFlightTracker()
    const sem = makeSem(IMPLEMENT_CAP)

    // 2 tasks in normal implement phase (holding slots)
    await acquire(sem)
    tracker.commitInFlight('impl-0', 'implement')
    await acquire(sem)
    tracker.commitInFlight('impl-1', 'implement')

    // 3 tasks parked in merge (no implement slots)
    for (let i = 0; i < 3; i++) {
      await parkInMergeQueue(`merge-${i}`, tracker, sem)
    }

    // Only 2 implement slots in use; 1 slot remains free
    expect(sem.inUse).toBe(2)

    // New implement dispatch acquires the remaining slot
    let acquired = false
    void acquire(sem).then(() => {
      acquired = true
    })
    await Promise.resolve()
    expect(acquired).toBe(true)
    expect(sem.inUse).toBe(IMPLEMENT_CAP)

    // Snapshot: 2 implement + 3 merge
    const snapshot = tracker.inFlightSnapshot()
    expect(snapshot.filter((e) => e.kind === 'implement')).toHaveLength(2)
    expect(snapshot.filter((e) => e.kind === 'merge')).toHaveLength(3)
  })
})
