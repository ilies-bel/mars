import { describe, expect, it } from 'vitest'
import {
  arcRaisesAlert,
  type ArcRestingState,
  type ArcTaskRow,
  type ArcBlockerEdge,
} from '../arc-alert-predicate'

/**
 * Table-driven verification of the resting-state alert invariant.
 * Every row the operator confirmed is covered exactly once. The whole
 * point of using a literal table is that the invariant's name is the
 * test name — when this file changes, the invariant changed.
 */

const origin = (
  id: string,
  status: ArcTaskRow['status'],
): ArcTaskRow => ({ id, status, kind: 'task', fixForTaskId: null })

const fix = (
  id: string,
  status: ArcTaskRow['status'],
  fixForTaskId: string,
): ArcTaskRow => ({ id, status, kind: 'fix', fixForTaskId })

const edge = (
  blocked: string,
  blocker: string,
  blockerStatus: ArcBlockerEdge['blockerStatus'],
  blockerHasInFlightRecovery: boolean,
): ArcBlockerEdge => ({
  blockedTaskId: blocked,
  blockerTaskId: blocker,
  blockerStatus,
  blockerHasInFlightRecovery,
})

const arc = (
  arcId: string,
  tasks: ArcTaskRow[],
  blockerEdges: ArcBlockerEdge[] = [],
): ArcRestingState => ({ arcId, tasks, blockerEdges })

interface Row {
  name: string
  state: ArcRestingState
  expected: boolean
}

const ROWS: Row[] = [
  // ----- ALERT rows -----
  {
    name: 'failed-no-recovery — bare origin failure with no fix spawned',
    state: arc('A', [origin('A', 'failed')]),
    expected: true,
  },
  {
    name: 'fix-failed — origin failed AND its fix is also failed (recovery spent, ADR-0061)',
    state: arc('A', [origin('A', 'failed'), fix('A-fix', 'failed', 'A')]),
    expected: true,
  },
  {
    name: 'fix-done-but-origin-failed — origin row still says failed, must NOT be cleared by stale origin-done eviction',
    state: arc('A', [origin('A', 'failed'), fix('A-fix', 'done', 'A')]),
    expected: true,
  },
  {
    name: 'blocked-on-DEAD-blocker (same arc) — wedged with no recovery coming',
    state: arc(
      'A',
      [origin('A', 'blocked'), origin('B', 'failed')],
      [edge('A', 'B', 'failed', false)],
    ),
    expected: true,
  },
  {
    name: 'blocked-on-DEAD-blocker (cross-arc) — blocker lives in another arc; this arc still raises its own card',
    state: arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'failed', false)],
    ),
    expected: true,
  },
  {
    name: 'blocked-on-DROPPED-blocker — dropped is also dead, no recovery coming',
    state: arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'dropped', false)],
    ),
    expected: true,
  },

  // ----- SUPPRESS rows -----
  {
    name: 'failed-with-in-flight-fix — origin failed but fix is running, recovery coming',
    state: arc('A', [origin('A', 'failed'), fix('A-fix', 'running', 'A')]),
    expected: false,
  },
  {
    name: 'failed-with-queued-fix — fix queued counts as in-flight (worker has it scheduled)',
    state: arc('A', [origin('A', 'failed'), fix('A-fix', 'queued', 'A')]),
    expected: false,
  },
  {
    name: 'failed-with-verifying-fix — fix in verify phase is still in-flight',
    state: arc('A', [origin('A', 'failed'), fix('A-fix', 'verifying', 'A')]),
    expected: false,
  },
  {
    name: 'failed-with-merging-fix — fix in merge phase is still in-flight',
    state: arc('A', [origin('A', 'failed'), fix('A-fix', 'merging', 'A')]),
    expected: false,
  },
  {
    name: 'blocked-on-LIVE-recovery — blocker has a fix in-flight, recovery genuinely coming',
    state: arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'failed', true)],
    ),
    expected: false,
  },
  {
    name: 'running — ongoing work, no human action needed',
    state: arc('A', [origin('A', 'running')]),
    expected: false,
  },
  {
    name: 'verifying — ongoing work',
    state: arc('A', [origin('A', 'verifying')]),
    expected: false,
  },
  {
    name: 'merging — ongoing work',
    state: arc('A', [origin('A', 'merging')]),
    expected: false,
  },
  {
    name: 'triaging — ongoing work, awaiting linker analysis',
    state: arc('A', [origin('A', 'triaging')]),
    expected: false,
  },
  {
    name: 'queued — ongoing work, awaiting dispatch',
    state: arc('A', [origin('A', 'queued')]),
    expected: false,
  },
  {
    name: 'done — resolved',
    state: arc('A', [origin('A', 'done')]),
    expected: false,
  },
  {
    name: 'dropped — resolved',
    state: arc('A', [origin('A', 'dropped')]),
    expected: false,
  },
  {
    name: 'empty arc — no tasks at all, nothing to alert about',
    state: arc('A', []),
    expected: false,
  },
  {
    name: 'blocked-on-LIVE-blocker (still queued, not dead) — upstream still has the chance to complete normally',
    state: arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'queued', false)],
    ),
    expected: false,
  },
  {
    name: 'blocked-on-RUNNING-blocker — upstream is actively running, suppress',
    state: arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'running', false)],
    ),
    expected: false,
  },
  {
    name: 'blocked-on-DONE-blocker — degenerate (recovery already happened); the blocker-completion writer will unblock momentarily',
    state: arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'done', false)],
    ),
    expected: false,
  },
]

describe('arcRaisesAlert — operator-confirmed resting-state invariant', () => {
  for (const row of ROWS) {
    it(`${row.expected ? 'alerts' : 'suppresses'}: ${row.name}`, () => {
      expect(arcRaisesAlert(row.state)).toBe(row.expected)
    })
  }
})

describe('arcRaisesAlert — exactly-one-card-per-arc shape (ADR-0051)', () => {
  it('returns a single boolean per arc no matter how many failed/blocked tasks the arc contains', () => {
    // An arc with multiple failed tasks (origin + a failed fix chain) MUST
    // still collapse to a single alert. The boolean return type is the
    // structural enforcement: callers cannot accidentally emit two cards.
    const state = arc('A', [
      origin('A', 'failed'),
      fix('A-fix1', 'failed', 'A'),
      fix('A-fix2', 'failed', 'A-fix1'), // not allowed by ADR-0040 but predicate is robust
    ])
    expect(arcRaisesAlert(state)).toBe(true)
  })

  it('returns a single boolean per arc when multiple tasks are blocked on different dead blockers', () => {
    const state = arc(
      'A',
      [origin('A', 'blocked'), origin('B', 'blocked')],
      [
        edge('A', 'X', 'failed', false),
        edge('B', 'Y', 'dropped', false),
      ],
    )
    expect(arcRaisesAlert(state)).toBe(true)
  })
})

describe('arcRaisesAlert — mutation clears by construction (ADR-0048)', () => {
  it('an alerting arc stops alerting when its origin is mutated to done — no explicit close call', () => {
    const before = arc('A', [origin('A', 'failed')])
    expect(arcRaisesAlert(before)).toBe(true)

    // Mutate the row in-place (level-triggered semantics: the next read
    // sees the new state). No alert-close call is made anywhere.
    const after = arc('A', [origin('A', 'done')])
    expect(arcRaisesAlert(after)).toBe(false)
  })

  it('an alerting arc stops alerting when a recovery task is (re)spawned and goes in-flight', () => {
    const before = arc('A', [origin('A', 'failed')])
    expect(arcRaisesAlert(before)).toBe(true)

    const after = arc('A', [
      origin('A', 'failed'),
      fix('A-fix', 'running', 'A'),
    ])
    expect(arcRaisesAlert(after)).toBe(false)
  })

  it('a dead-blocker-wedged arc stops alerting when the dead blocker is reset to in-flight via recovery', () => {
    const before = arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'failed', false)],
    )
    expect(arcRaisesAlert(before)).toBe(true)

    const after = arc(
      'A',
      [origin('A', 'blocked')],
      [edge('A', 'X', 'failed', true)], // blocker now has an in-flight recovery
    )
    expect(arcRaisesAlert(after)).toBe(false)
  })

  it('a re-failed arc re-derives its alert — there is no sticky "dismissed" bit', () => {
    // initial failure → alert
    const a1 = arc('A', [origin('A', 'failed')])
    expect(arcRaisesAlert(a1)).toBe(true)

    // recovery spawned + finishes → arc would no longer be `failed`
    // (Arc.propagateRecoveryDone flips origin to `done`)
    const a2 = arc('A', [origin('A', 'done'), fix('A-fix', 'done', 'A')])
    expect(arcRaisesAlert(a2)).toBe(false)

    // operator restarts → fresh attempt fails again → alert is back,
    // no explicit "re-open" call happened.
    const a3 = arc('A', [origin('A', 'failed'), fix('A-fix', 'done', 'A')])
    expect(arcRaisesAlert(a3)).toBe(true)
  })
})
