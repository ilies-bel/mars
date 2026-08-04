import { describe, expect, it } from 'vitest'
import { createTaskFlightTracker } from '../task-flight-tracker'

describe('TaskFlightTracker — dispatch-storm invariant', () => {
  it('a claimed-but-not-yet-committed task is still "held" (claim covers the await-acquire gap)', () => {
    const tracker = createTaskFlightTracker()
    tracker.enqueuePending('t1', 'implement')

    // Simulate a drain pass that claimed the task but has NOT yet awaited the
    // semaphore / called commitInFlight — the exact window the bug lived in.
    expect(tracker.claim('t1', 'implement')).toBe(true)

    // It is NOT in flight yet…
    expect(tracker.isInFlight('t1')).toBe(false)
    // …but it IS claimed, so a second drain pass sees it as held.
    expect(tracker.isClaimed('t1', 'implement')).toBe(true)
  })

  it('double-claim is rejected: at most one claim per (taskId, kind)', () => {
    const tracker = createTaskFlightTracker()
    expect(tracker.claim('t1', 'implement')).toBe(true)
    // A concurrent drain pass trying to claim the same id is refused.
    expect(tracker.claim('t1', 'implement')).toBe(false)
    expect(tracker.claim('t1', 'triage')).toBe(true) // different kind is its own set
    expect(tracker.claim('t1', 'triage')).toBe(false)
  })

  it('claim is refused once the task is already committed in flight', () => {
    const tracker = createTaskFlightTracker()
    expect(tracker.claim('t1', 'implement')).toBe(true)
    tracker.commitInFlight('t1', 'implement')
    // Now in flight; the claim was cleared by commit, but a fresh claim must
    // still be refused because the inFlight entry holds the id.
    expect(tracker.isClaimed('t1', 'implement')).toBe(false)
    expect(tracker.claim('t1', 'implement')).toBe(false)
  })

  it('commitInFlight clears the claim AFTER recording inFlight (claim → commit handoff)', () => {
    const tracker = createTaskFlightTracker()
    tracker.claim('t1', 'implement')
    expect(tracker.isClaimed('t1', 'implement')).toBe(true)

    tracker.commitInFlight('t1', 'implement')

    // The handoff is atomic from the caller's view: in flight, not claimed.
    expect(tracker.isInFlight('t1')).toBe(true)
    expect(tracker.isClaimed('t1', 'implement')).toBe(false)
    expect(tracker.inFlightKind('t1')).toBe('implement')
  })

  it('the release closure is the only way to clear inFlight, and clears it after commit', () => {
    const tracker = createTaskFlightTracker()
    const release = tracker.commitInFlight('t1', 'triage')
    expect(tracker.isInFlight('t1')).toBe(true)
    expect(tracker.inFlightCount()).toBe(1)

    release()
    expect(tracker.isInFlight('t1')).toBe(false)
    expect(tracker.inFlightCount()).toBe(0)
  })

  it('the release closure is idempotent', () => {
    const tracker = createTaskFlightTracker()
    const release = tracker.commitInFlight('t1', 'refine')
    release()
    release() // no throw, no underflow
    expect(tracker.inFlightCount()).toBe(0)
  })

  it('aborts the controller owned by an in-flight task', () => {
    const tracker = createTaskFlightTracker()
    const controller = new AbortController()
    tracker.commitInFlight('t1', 'implement', controller)

    expect(tracker.abort('t1')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  it('drops the controller when an in-flight task completes normally', () => {
    const tracker = createTaskFlightTracker()
    const controller = new AbortController()
    const release = tracker.commitInFlight('t1', 'implement', controller)

    release()
    expect(tracker.abort('t1')).toBe(false)
    expect(controller.signal.aborted).toBe(false)
  })

  it('a stale release does NOT evict a newer entry re-committed under the same id', () => {
    const tracker = createTaskFlightTracker()
    const firstRelease = tracker.commitInFlight('t1', 'implement')

    // A force-drop reclaims the slot while the worker keeps running…
    expect(tracker.forceRelease('t1')).toBe(true)
    expect(tracker.isInFlight('t1')).toBe(false)

    // …then the id is dispatched again and re-committed.
    tracker.commitInFlight('t1', 'triage')
    expect(tracker.isInFlight('t1')).toBe(true)
    expect(tracker.inFlightKind('t1')).toBe('triage')

    // The first run finally finishes and calls its release closure. It must
    // NOT evict the newer (triage) entry — identity check protects it.
    firstRelease()
    expect(tracker.isInFlight('t1')).toBe(true)
    expect(tracker.inFlightKind('t1')).toBe('triage')
  })

  it('unclaim drops a claim that will not be committed (drain bail path)', () => {
    const tracker = createTaskFlightTracker()
    tracker.claim('t1', 'implement')
    expect(tracker.isClaimed('t1', 'implement')).toBe(true)

    // Row turned out to be non-queued / blocked — drain unclaims and moves on.
    tracker.unclaim('t1', 'implement')
    expect(tracker.isClaimed('t1', 'implement')).toBe(false)
    // The id is free again: a later drain may re-claim it.
    expect(tracker.claim('t1', 'implement')).toBe(true)
  })

  it('the invariant holds end-to-end: at most one slot holds an id at any instant', () => {
    const tracker = createTaskFlightTracker()
    tracker.enqueuePending('t1', 'implement')

    // claim removes it from "free", before any await.
    expect(tracker.claim('t1', 'implement')).toBe(true)
    tracker.removePending('t1', 'implement')
    // While claimed-not-committed, both a re-claim and an isInFlight read agree
    // the id is held by exactly one slot (the claim).
    expect(tracker.claim('t1', 'implement')).toBe(false)
    expect(tracker.isInFlight('t1')).toBe(false)

    // commit moves the single hold from claim → inFlight (never both, never neither).
    const release = tracker.commitInFlight('t1', 'implement')
    expect(tracker.isClaimed('t1', 'implement')).toBe(false)
    expect(tracker.isInFlight('t1')).toBe(true)
    expect(tracker.inFlightCount()).toBe(1)

    // release frees it entirely.
    release()
    expect(tracker.isInFlight('t1')).toBe(false)
    expect(tracker.claim('t1', 'implement')).toBe(true)
  })

  it('inFlightSnapshot returns a point-in-time copy of every committed entry', () => {
    const tracker = createTaskFlightTracker()
    tracker.commitInFlight('t1', 'implement')
    tracker.commitInFlight('t2', 'triage')

    const snap = tracker.inFlightSnapshot()
    expect(snap).toHaveLength(2)
    expect(snap).toContainEqual(expect.objectContaining({ taskId: 't1', kind: 'implement' }))
    expect(snap).toContainEqual(expect.objectContaining({ taskId: 't2', kind: 'triage' }))
    // Each entry carries a startedAt timestamp.
    for (const entry of snap) {
      expect(typeof entry.startedAt).toBe('number')
    }

    // Mutating the snapshot does not affect the tracker (it is a copy).
    snap.pop()
    expect(tracker.inFlightCount()).toBe(2)
  })

  it('recordPid stores the PID on an existing in-flight entry', () => {
    const tracker = createTaskFlightTracker()
    tracker.commitInFlight('t1', 'implement')

    tracker.recordPid('t1', 42)

    const snap = tracker.inFlightSnapshot()
    const entry = snap.find((e) => e.taskId === 't1')
    expect(entry?.pid).toBe(42)
  })

  it('recordPid is a no-op for a task not in flight', () => {
    const tracker = createTaskFlightTracker()
    // Should not throw even if the task isn't in flight.
    expect(() => tracker.recordPid('nobody', 99)).not.toThrow()
  })

  it('recordActivity stores lastActivityMs on an existing in-flight entry', () => {
    const tracker = createTaskFlightTracker()
    tracker.commitInFlight('t1', 'implement')

    tracker.recordActivity('t1', 1_700_000_000_000)

    const snap = tracker.inFlightSnapshot()
    const entry = snap.find((e) => e.taskId === 't1')
    expect(entry?.lastActivityMs).toBe(1_700_000_000_000)
  })

  it('recordActivity updates lastActivityMs on repeated calls', () => {
    const tracker = createTaskFlightTracker()
    tracker.commitInFlight('t1', 'implement')

    tracker.recordActivity('t1', 1_000)
    tracker.recordActivity('t1', 2_000)

    const snap = tracker.inFlightSnapshot()
    const entry = snap.find((e) => e.taskId === 't1')
    expect(entry?.lastActivityMs).toBe(2_000)
  })

  it('recordActivity is a no-op for a task not in flight', () => {
    const tracker = createTaskFlightTracker()
    // Should not throw even if the task is not in flight.
    expect(() => tracker.recordActivity('nobody', Date.now())).not.toThrow()
  })

  it('pending sets are per-kind, drainable in insertion order, and clearable', () => {
    const tracker = createTaskFlightTracker()
    tracker.enqueuePending('a', 'triage')
    tracker.enqueuePending('b', 'triage')
    tracker.enqueuePending('c', 'implement')

    expect(Array.from(tracker.drainPending('triage'))).toEqual(['a', 'b'])
    expect(Array.from(tracker.drainPending('implement'))).toEqual(['c'])

    tracker.removePending('a', 'triage')
    expect(Array.from(tracker.drainPending('triage'))).toEqual(['b'])

    tracker.clearPending()
    expect(Array.from(tracker.drainPending('triage'))).toEqual([])
    expect(Array.from(tracker.drainPending('implement'))).toEqual([])
  })

  it('forceRelease returns false when nothing was in flight', () => {
    const tracker = createTaskFlightTracker()
    expect(tracker.forceRelease('nope')).toBe(false)
    tracker.commitInFlight('t1', 'implement')
    expect(tracker.forceRelease('t1')).toBe(true)
    expect(tracker.forceRelease('t1')).toBe(false)
  })
})
