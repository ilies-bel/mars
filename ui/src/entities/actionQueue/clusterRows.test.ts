/**
 * Entity grouping: one card per TASK, not per derived condition.
 *
 * Regression cover for the live queue state where task mars-6340b827 occupied
 * three separate triage rows (`failed` + `recovery-abandoned` + `gate-broken`)
 * whose verb sets contradicted each other — the recovery-exhausted `failed`
 * row warned that Continue/Restart would discard a salvage checkpoint while
 * the `recovery-abandoned` row a few hundred pixels away offered a live
 * Restart button for the same branch.
 */

import { describe, it, expect } from 'vitest'
import { buildRenderedRows, countNeedsYou, sortItems } from './clusterRows'
import type { ActionQueueItem } from '@/shared/schemas'

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
    snoozeUntil: undefined,
    ...overrides,
  }) as ActionQueueItem

/** The three rows task mars-6340b827 actually held on the live queue. */
const liveTripleForOneTask = (): ActionQueueItem[] => [
  makeItem('failed', {
    id: 'bc0e4764',
    entityId: 'mars-6340b827',
    recoveryExhausted: true,
  }),
  makeItem('recovery-abandoned', { id: '59a092fc', entityId: 'mars-6340b827' }),
  makeItem('gate-broken', { id: 'a1b64b91', entityId: 'mars-6340b827' }),
]

describe('buildRenderedRows — entity grouping', () => {
  it('collapses the three conditions of one task onto a single card', () => {
    const rows = buildRenderedRows(sortItems(liveTripleForOneTask()))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('entityGroup')
  })

  it('picks the recovery-exhausted carry-forward row as the one verb set', () => {
    const rows = buildRenderedRows(sortItems(liveTripleForOneTask()))
    const row = rows[0]

    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    // The carry-forward panel must win: Continue/Restart on this task would
    // discard the salvage checkpoint its branch carries.
    expect(row.primary.kind).toBe('failed')
    expect(row.primary.recoveryExhausted).toBe(true)
  })

  it('surfaces the collapsed kinds as badges rather than dropping them', () => {
    const rows = buildRenderedRows(sortItems(liveTripleForOneTask()))
    const row = rows[0]

    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    expect([...row.badgeKinds].sort()).toEqual(['gate-broken', 'recovery-abandoned'])
  })

  it('groups recovery-abandoned even though it is not a task-failure kind', () => {
    // recovery-abandoned is absent from the daemon's `taskFailureKinds`
    // mirror, so gating grouping on isTaskFailureActionQueueKind alone would
    // silently leave this row standing on its own with a live Restart button.
    const rows = buildRenderedRows(
      sortItems([
        makeItem('failed', { id: 'a', entityId: 'mars-bff7e039' }),
        makeItem('recovery-abandoned', { id: 'b', entityId: 'mars-bff7e039' }),
      ]),
    )

    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    expect(row.primary.kind).toBe('failed')
    expect(row.badgeKinds).toEqual(['recovery-abandoned'])
  })

  it('keeps distinct tasks on distinct cards', () => {
    const rows = buildRenderedRows(
      sortItems([
        makeItem('failed', { id: 'a1', entityId: 'task-one' }),
        makeItem('gate-broken', { id: 'a2', entityId: 'task-one' }),
        makeItem('failed', { id: 'b1', entityId: 'task-two' }),
        makeItem('gate-broken', { id: 'b2', entityId: 'task-two' }),
      ]),
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === 'entityGroup')).toBe(true)
  })

  it('leaves a task with a single condition as a plain row, not a group', () => {
    const rows = buildRenderedRows(sortItems([makeItem('failed', { entityId: 'solo' })]))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item')
  })

  it('does not group rows that share no entity id', () => {
    // An empty entityId is not an identity — two such rows are two subjects.
    const rows = buildRenderedRows(
      sortItems([
        makeItem('failed', { id: 'x', entityId: '' }),
        makeItem('gate-broken', { id: 'y', entityId: '' }),
      ]),
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === 'item')).toBe(true)
  })

  it('lets a recovery-exhausted row outrank a nominally higher-precedence kind', () => {
    const rows = buildRenderedRows(
      sortItems([
        makeItem('failed', { id: 'plain', entityId: 'shared' }),
        makeItem('gate-broken', {
          id: 'exhausted',
          entityId: 'shared',
          recoveryExhausted: true,
        }),
      ]),
    )

    const row = rows[0]
    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    expect(row.primary.id).toBe('exhausted')
  })
})

describe('countNeedsYou', () => {
  it('counts one task holding three conditions as one subject', () => {
    expect(countNeedsYou(liveTripleForOneTask())).toBe(1)
  })

  it('matches the number of cards actually rendered', () => {
    const items = [
      ...liveTripleForOneTask(),
      makeItem('failed', { id: 'other', entityId: 'mars-bff7e039' }),
      makeItem('recovery-abandoned', { id: 'other2', entityId: 'mars-bff7e039' }),
      makeItem('awaiting-human', { id: 'ah', entityId: 'mars-cafe0001' }),
    ]

    expect(countNeedsYou(items)).toBe(buildRenderedRows(sortItems(items)).length)
  })

  it('excludes draft proposals, which are a backlog rather than an alert', () => {
    const items = [
      makeItem('failed', { id: 'f', entityId: 'task-a' }),
      makeItem('draft-proposal', { id: 'p1', entityId: 'prop-1' }),
      makeItem('draft-proposal', { id: 'p2', entityId: 'prop-2' }),
    ]

    expect(countNeedsYou(items)).toBe(1)
  })

  it('still counts distinct subjects that merely share a kind', () => {
    const items = [
      makeItem('failed', { id: 'f1', entityId: 'task-a' }),
      makeItem('failed', { id: 'f2', entityId: 'task-b' }),
      makeItem('failed', { id: 'f3', entityId: 'task-c' }),
    ]

    expect(countNeedsYou(items)).toBe(3)
  })
})
