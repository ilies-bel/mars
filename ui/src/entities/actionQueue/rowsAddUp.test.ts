/**
 * THE invariant behind the Needs You header: the rows on the page add up to
 * the number above them.
 *
 * `needsYouParity.test.tsx` already asserts that the four SURFACES showing the
 * count agree with each other. It does not assert that any of them agrees with
 * what is actually drawn — and that is the gap the count kept falling through.
 *
 * Twice now the two halves have drifted apart in opposite directions:
 *
 *   - a task drawn BOTH as a loose row and inside a group was counted once,
 *     so the page summed higher than its badge;
 *   - later, widening `buildRenderedRows` to fold a parked task together with
 *     its worktree notice — without widening `countNeedsYou` to match — made
 *     the page sum two LOWER than its badge.
 *
 * Both were a second expression of one rule. This test pins the rule itself:
 * for any queue, the countable weight of the rendered rows must equal
 * `countNeedsYou` exactly. It fails whichever side is changed alone.
 */

import { describe, expect, it } from 'vitest'
import { buildRenderedRows, countNeedsYou, type RenderedRow } from './clusterRows'
import type { ActionQueueItem, ActionQueueGroupRow } from '@/shared/schemas'

const makeItem = (
  kind: string,
  overrides: Partial<ActionQueueItem> = {},
): ActionQueueItem =>
  ({
    id: `item-${kind}`,
    entityId: `task-${kind}`,
    kind,
    priority: 'normal' as const,
    title: `Title for ${kind}`,
    body: '',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: kind,
    actions: [],
    decisions: [],
    humanSummary: `Summary for ${kind}`,
    humanDetail: undefined,
    verbs: [],
    arcGoal: null,
    diagnosis: null,
    failureReasonCode: null,
    fixForTaskId: null,
    resolution: null,
    devServerUrl: null,
    leaseState: null,
    class: 'alert',
    ...overrides,
  }) as ActionQueueItem

/** Does this single item contribute to the count? */
const countable = (i: ActionQueueItem): boolean =>
  i.kind !== 'draft-proposal' && i.class !== 'notice'

/**
 * What a rendered row is WORTH to a reader adding the page up — the number the
 * row itself puts on screen, or 1 for a row standing for one subject.
 */
const weightOf = (row: RenderedRow, items: readonly ActionQueueItem[]): number => {
  switch (row.type) {
    case 'item':
      return countable(row.item) ? 1 : 0
    case 'cluster': {
      // A cluster row prints its own count and stands for that many subjects.
      const members = items.filter((i) => i.kind === row.kind)
      return members.filter(countable).length
    }
    case 'entityGroup':
      // One subject, however many conditions it raised.
      return countable(row.primary) ? 1 : 0
    case 'causeGroup': {
      const seen = new Set<string>()
      let n = 0
      for (const m of row.members) {
        if (!countable(m)) continue
        if (m.entityId) {
          if (seen.has(m.entityId)) continue
          seen.add(m.entityId)
        }
        n += 1
      }
      return n
    }
  }
}

const sumRendered = (
  items: readonly ActionQueueItem[],
  groups?: readonly ActionQueueGroupRow[],
): number =>
  buildRenderedRows(items, groups).reduce((acc, r) => acc + weightOf(r, items), 0)

const expectCloses = (
  items: readonly ActionQueueItem[],
  groups?: readonly ActionQueueGroupRow[],
): void => {
  expect(sumRendered(items, groups)).toBe(countNeedsYou(items, groups))
}

describe('the rendered rows add up to countNeedsYou', () => {
  it('closes on a plain mixed queue', () => {
    expectCloses([
      makeItem('failed', { id: 'a', entityId: 'mars-aaaaaaaa' }),
      makeItem('baseline-broken', { id: 'b', entityId: 'baseline-broken' }),
      makeItem('verify-uncovered', { id: 'c', entityId: 'uncovered', class: 'decision' }),
    ])
  })

  it('closes when a task raises several conditions at once', () => {
    expectCloses([
      makeItem('failed', { id: 'a', entityId: 'mars-aaaaaaaa' }),
      makeItem('recovery-abandoned', { id: 'b', entityId: 'mars-aaaaaaaa' }),
      makeItem('gate-broken', { id: 'c', entityId: 'mars-aaaaaaaa' }),
    ])
  })

  it('closes for a parked task carrying an informational notice', () => {
    // The exact shape that regressed: a DECISION and a NOTICE on one task.
    // The fold merges them onto one card; the notice is not countable. If the
    // two rules stop matching, this is off by one.
    expectCloses([
      makeItem('awaiting-human', { id: 'a', entityId: 'mars-c587ad23', class: 'decision' }),
      makeItem('stale-worktree', { id: 'b', entityId: 'mars-c587ad23', class: 'notice' }),
      makeItem('failed', { id: 'c', entityId: 'mars-bbbbbbbb' }),
    ])
  })

  it('closes when a task carries a parked row AND an alert', () => {
    // The discriminating case. `awaiting-human` is the one kind that is both
    // COUNTABLE and outside `taskFailureKinds`, so this is the only shape
    // where the narrow (kind-keyed) and wide (task-keyed) fold rules disagree.
    // Two countable rows, one subject: the card is one, so the count must be
    // one. With the two rules out of step this is 2 against 1.
    expectCloses([
      makeItem('awaiting-human', { id: 'a', entityId: 'mars-c587ad23', class: 'decision' }),
      makeItem('env-incident', { id: 'b', entityId: 'mars-c587ad23', class: 'alert' }),
    ])
  })

  it('closes when notices stand alone', () => {
    expectCloses([
      makeItem('reflect-recommended', { id: 'a', entityId: 'reflect', class: 'notice' }),
      makeItem('failed', { id: 'b', entityId: 'mars-aaaaaaaa' }),
    ])
  })

  it('closes when a high-cardinality kind clusters', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      makeItem('awaiting-human', {
        id: `park-${i}`,
        entityId: `mars-${i}0000000`,
        class: 'decision',
      }),
    )
    expectCloses([...many, makeItem('failed', { id: 'f', entityId: 'mars-aaaaaaaa' })])
  })

  it('closes with drafts present (excluded on both sides)', () => {
    const drafts = Array.from({ length: 15 }, (_, i) =>
      makeItem('draft-proposal', { id: `d-${i}`, entityId: `prop-${i}`, class: 'decision' }),
    )
    expectCloses([...drafts, makeItem('failed', { id: 'f', entityId: 'mars-aaaaaaaa' })])
  })

  it('closes with server-sent cause groups alongside loose rows', () => {
    const members = [
      makeItem('failed', { id: 'm1', entityId: 'mars-11111111' }),
      makeItem('failed', { id: 'm2', entityId: 'mars-22222222' }),
      makeItem('failed', { id: 'm3', entityId: 'mars-33333333' }),
    ]
    const groups = [
      {
        id: 'group:failed:x/y',
        kind: 'failed',
        signature: 'x/y',
        count: members.length,
        causeLabel: 'Shared cause',
        priority: 'high' as const,
        members,
        firstAt: '2026-01-01T00:00:00Z',
        lastAt: '2026-01-01T00:00:00Z',
      } as unknown as ActionQueueGroupRow,
    ]
    expectCloses(
      [...members, makeItem('failed', { id: 'loose', entityId: 'mars-44444444' })],
      groups,
    )
  })
})
