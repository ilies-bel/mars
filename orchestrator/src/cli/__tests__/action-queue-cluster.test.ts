/**
 * Unit tests for the TUI action-queue clustering / entity-grouping logic.
 *
 * Regression cover for the scenario where a single task (e.g. mars-6340b827)
 * occupies three separate action-queue rows (failed + recovery-abandoned +
 * gate-broken) whose verb sets contradict each other. buildRenderedTuiRows must
 * collapse all three onto one entityGroup card.
 */

import { describe, it, expect } from 'vitest'
import {
  buildRenderedTuiRows,
  countNeedsYou,
  sortItems,
  isGroupableConditionKind,
} from '../action-queue-cluster'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

// ─── helpers ─────────────────────────────────────────────────────────────────

const makeRow = (
  kind: string,
  overrides: Partial<ActionQueueRow> = {},
): ActionQueueRow =>
  ({
    id: `item-${kind}-${Math.random().toString(36).slice(2, 6)}`,
    entityId: `task-${kind}`,
    kind,
    priority: 'normal' as const,
    title: `Title for ${kind}`,
    body: '',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: kind,
    actions: [],
    staleWorktreeDetail: null,
    devServerUrl: null,
    leaseState: null,
    diagnosis: null,
    failureReasonCode: null,
    recoveryExhausted: false,
    fixForTaskId: null,
    humanSummary: `Summary for ${kind}`,
    humanDetail: {},
    verbs: [],
    arcGoal: null,
    operatorGoal: null,
    class: 'alert' as const,
    ...overrides,
  }) as ActionQueueRow

/** Three condition rows for a single task — mirrors the live mars-6340b827 scenario. */
const liveTripleForOneTask = (): ActionQueueRow[] => [
  makeRow('failed', {
    id: 'bc0e4764',
    entityId: 'mars-6340b827',
    recoveryExhausted: true,
  }),
  makeRow('recovery-abandoned', { id: '59a092fc', entityId: 'mars-6340b827' }),
  makeRow('gate-broken', { id: 'a1b64b91', entityId: 'mars-6340b827' }),
]

// ─── isGroupableConditionKind ──────────────────────────────────────────────────

describe('isGroupableConditionKind', () => {
  it('returns true for task-failure kinds', () => {
    expect(isGroupableConditionKind('failed')).toBe(true)
    expect(isGroupableConditionKind('recovery-abandoned')).toBe(true)
    expect(isGroupableConditionKind('gate-broken')).toBe(true)
    expect(isGroupableConditionKind('daemon-killed')).toBe(true)
  })

  it('returns false for non-task-condition kinds', () => {
    expect(isGroupableConditionKind('draft-proposal')).toBe(false)
    expect(isGroupableConditionKind('stale-worktree')).toBe(false)
    expect(isGroupableConditionKind('awaiting-human')).toBe(false)
    expect(isGroupableConditionKind('draft-proposal')).toBe(false)
  })
})

// ─── sortItems ────────────────────────────────────────────────────────────────

describe('sortItems', () => {
  it('sorts by priority (high before normal before low)', () => {
    const rows = [
      makeRow('failed', { at: '2026-01-01T00:00:00Z', priority: 'low' }),
      makeRow('failed', { at: '2026-01-01T00:00:00Z', priority: 'high' }),
      makeRow('failed', { at: '2026-01-01T00:00:00Z', priority: 'normal' }),
    ]
    const sorted = sortItems(rows)
    expect(sorted.map((r) => r.priority)).toEqual(['high', 'normal', 'low'])
  })

  it('sorts by recency within the same priority (newest first)', () => {
    const rows = [
      makeRow('failed', { at: '2026-01-01T00:00:00Z' }),
      makeRow('failed', { at: '2026-01-03T00:00:00Z' }),
      makeRow('failed', { at: '2026-01-02T00:00:00Z' }),
    ]
    const sorted = sortItems(rows)
    expect(sorted.map((r) => r.at)).toEqual([
      '2026-01-03T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ])
  })

  it('does not mutate the input', () => {
    const rows = [
      makeRow('failed', { priority: 'low' }),
      makeRow('failed', { priority: 'high' }),
    ]
    const copy = [...rows]
    sortItems(rows)
    expect(rows).toEqual(copy)
  })
})

// ─── buildRenderedTuiRows — entity grouping ───────────────────────────────────

describe('buildRenderedTuiRows — entity grouping', () => {
  it('collapses three conditions for one task onto a single entityGroup row', () => {
    const rows = buildRenderedTuiRows(sortItems(liveTripleForOneTask()))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('entityGroup')
  })

  it('picks the recovery-exhausted row as primary (carry-forward wins)', () => {
    const rows = buildRenderedTuiRows(sortItems(liveTripleForOneTask()))
    const row = rows[0]

    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    expect(row.primary.kind).toBe('failed')
    expect(row.primary.recoveryExhausted).toBe(true)
  })

  it('surfaces the collapsed kinds as badge strings, not dropping them', () => {
    const rows = buildRenderedTuiRows(sortItems(liveTripleForOneTask()))
    const row = rows[0]

    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    expect([...row.badgeKinds].sort()).toEqual(['gate-broken', 'recovery-abandoned'])
  })

  it('groups recovery-abandoned with a failed row for the same task', () => {
    const rows = buildRenderedTuiRows(
      sortItems([
        makeRow('failed', { id: 'a', entityId: 'mars-bff7e039' }),
        makeRow('recovery-abandoned', { id: 'b', entityId: 'mars-bff7e039' }),
      ]),
    )

    expect(rows).toHaveLength(1)
    const row = rows[0]
    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    expect(row.primary.kind).toBe('failed')
    expect(row.badgeKinds).toEqual(['recovery-abandoned'])
  })

  it('keeps distinct tasks on distinct cards', () => {
    const rows = buildRenderedTuiRows(
      sortItems([
        makeRow('failed', { id: 'a1', entityId: 'task-one' }),
        makeRow('gate-broken', { id: 'a2', entityId: 'task-one' }),
        makeRow('failed', { id: 'b1', entityId: 'task-two' }),
        makeRow('gate-broken', { id: 'b2', entityId: 'task-two' }),
      ]),
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === 'entityGroup')).toBe(true)
  })

  it('leaves a task with a single condition as a plain item row', () => {
    const rows = buildRenderedTuiRows(sortItems([makeRow('failed', { entityId: 'solo' })]))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item')
  })

  it('does not group rows sharing an empty entityId', () => {
    // An empty entityId is not an identity — two such rows are two subjects.
    const rows = buildRenderedTuiRows(
      sortItems([
        makeRow('failed', { id: 'x', entityId: '' }),
        makeRow('gate-broken', { id: 'y', entityId: '' }),
      ]),
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === 'item')).toBe(true)
  })

  it('lets a recovery-exhausted row outrank a nominally higher-precedence kind', () => {
    const rows = buildRenderedTuiRows(
      sortItems([
        makeRow('failed', { id: 'plain', entityId: 'shared' }),
        makeRow('gate-broken', {
          id: 'exhausted',
          entityId: 'shared',
          recoveryExhausted: true,
        }),
      ]),
    )

    const row = rows[0]
    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    // gate-broken with recoveryExhausted=true wins over plain failed (rank -1 < 0)
    expect(row.primary.id).toBe('exhausted')
  })

  it('uses ENTITY_GROUP_KIND_RANK for primary selection (failed=0, recovery-abandoned=1, gate-broken=2)', () => {
    // failed beats recovery-abandoned beats gate-broken when none are exhausted
    const rows = buildRenderedTuiRows(
      sortItems([
        makeRow('gate-broken', { id: 'g', entityId: 'task-rank' }),
        makeRow('recovery-abandoned', { id: 'ra', entityId: 'task-rank' }),
        makeRow('failed', { id: 'f', entityId: 'task-rank' }),
      ]),
    )

    const row = rows[0]
    if (row?.type !== 'entityGroup') throw new Error('expected an entityGroup row')
    expect(row.primary.kind).toBe('failed')
    expect(row.primary.id).toBe('f')
    expect([...row.badgeKinds].sort()).toEqual(['gate-broken', 'recovery-abandoned'])
  })
})

// ─── buildRenderedTuiRows — draft-proposal always-cluster ─────────────────────

describe('buildRenderedTuiRows — draft-proposal always-cluster', () => {
  it('collapses a single draft-proposal into a cluster row', () => {
    const rows = buildRenderedTuiRows(sortItems([makeRow('draft-proposal')]))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('cluster')
    if (rows[0]?.type === 'cluster') {
      expect(rows[0].kind).toBe('draft-proposal')
      expect(rows[0].count).toBe(1)
    }
  })

  it('collapses N draft-proposals into one cluster row with correct count', () => {
    const proposals = Array.from({ length: 10 }, (_, i) =>
      makeRow('draft-proposal', { id: `p${i}`, entityId: `prop-${i}` }),
    )
    const rows = buildRenderedTuiRows(sortItems(proposals))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('cluster')
    if (rows[0]?.type === 'cluster') {
      expect(rows[0].count).toBe(10)
    }
  })

  it('places the cluster row at the position of the first (most-recent) draft-proposal', () => {
    const items = [
      makeRow('failed', { at: '2026-01-03T00:00:00Z', entityId: 'task-fail' }),
      makeRow('draft-proposal', { at: '2026-01-01T00:00:00Z', entityId: 'p1' }),
      makeRow('draft-proposal', { at: '2026-01-02T00:00:00Z', entityId: 'p2' }),
    ]
    const rows = buildRenderedTuiRows(sortItems(items))

    // After sort: failed(newest), draft-proposal(2026-01-02), draft-proposal(2026-01-01)
    // → item row for failed, then cluster for the two proposals
    expect(rows).toHaveLength(2)
    expect(rows[0]?.type).toBe('item')
    expect(rows[1]?.type).toBe('cluster')
  })
})

// ─── buildRenderedTuiRows — threshold-based clustering ────────────────────────

describe('buildRenderedTuiRows — threshold-based clustering', () => {
  it('renders up to CLUSTER_THRESHOLD items of a decision kind as individual rows', () => {
    // 5 awaiting-human items → should all be individual (at threshold, not over)
    const items = Array.from({ length: 5 }, (_, i) =>
      makeRow('awaiting-human', { id: `ah-${i}`, entityId: `task-ah-${i}` }),
    )
    const rows = buildRenderedTuiRows(sortItems(items))

    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.type === 'item')).toBe(true)
  })

  it('collapses more than CLUSTER_THRESHOLD items of a decision kind into one cluster', () => {
    // 6 awaiting-human items → should collapse (exceeds threshold of 5)
    const items = Array.from({ length: 6 }, (_, i) =>
      makeRow('awaiting-human', { id: `ah-${i}`, entityId: `task-ah-${i}` }),
    )
    const rows = buildRenderedTuiRows(sortItems(items))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('cluster')
    if (rows[0]?.type === 'cluster') {
      expect(rows[0].kind).toBe('awaiting-human')
      expect(rows[0].count).toBe(6)
    }
  })

  it('never clusters stale-worktree even when count exceeds threshold', () => {
    // stale-worktree is in NEVER_CLUSTER_KINDS — always individual
    const items = Array.from({ length: 10 }, (_, i) =>
      makeRow('stale-worktree', { id: `sw-${i}`, entityId: `worktree-${i}` }),
    )
    const rows = buildRenderedTuiRows(sortItems(items))

    expect(rows).toHaveLength(10)
    expect(rows.every((r) => r.type === 'item')).toBe(true)
  })

  it('never clusters task-failure kinds even when count exceeds threshold', () => {
    // failed is groupable — distinct tasks on distinct cards (no shared entityId)
    const items = Array.from({ length: 10 }, (_, i) =>
      makeRow('failed', { id: `f-${i}`, entityId: `task-${i}` }),
    )
    const rows = buildRenderedTuiRows(sortItems(items))

    expect(rows).toHaveLength(10)
    expect(rows.every((r) => r.type === 'item')).toBe(true)
  })

  it('clusters latestAt from the most-recent item in the group', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      makeRow('awaiting-human', {
        id: `ah-${i}`,
        entityId: `task-${i}`,
        at: `2026-01-0${i + 1}T00:00:00Z`,
      }),
    )
    const rows = buildRenderedTuiRows(sortItems(items))

    expect(rows[0]?.type).toBe('cluster')
    if (rows[0]?.type === 'cluster') {
      // sortItems puts most-recent first; cluster latestAt = first item's at
      expect(rows[0].latestAt).toBe('2026-01-06T00:00:00Z')
    }
  })
})

// ─── countNeedsYou ───────────────────────────────────────────────────────────

describe('countNeedsYou', () => {
  it('counts one task holding three conditions as one subject', () => {
    expect(countNeedsYou(liveTripleForOneTask())).toBe(1)
  })

  it('matches the number of entity-group cards rendered by buildRenderedTuiRows', () => {
    const items = [
      ...liveTripleForOneTask(),
      makeRow('failed', { id: 'other', entityId: 'mars-bff7e039' }),
      makeRow('recovery-abandoned', { id: 'other2', entityId: 'mars-bff7e039' }),
      makeRow('awaiting-human', { id: 'ah', entityId: 'mars-cafe0001' }),
    ]

    expect(countNeedsYou(items)).toBe(buildRenderedTuiRows(sortItems(items)).length)
  })

  it('excludes draft-proposals entirely (they are a backlog, not an alert)', () => {
    const items = [
      makeRow('failed', { id: 'f', entityId: 'task-a' }),
      makeRow('draft-proposal', { id: 'p1', entityId: 'prop-1' }),
      makeRow('draft-proposal', { id: 'p2', entityId: 'prop-2' }),
    ]

    expect(countNeedsYou(items)).toBe(1)
  })

  it('still counts distinct subjects that merely share a kind', () => {
    const items = [
      makeRow('failed', { id: 'f1', entityId: 'task-a' }),
      makeRow('failed', { id: 'f2', entityId: 'task-b' }),
      makeRow('failed', { id: 'f3', entityId: 'task-c' }),
    ]

    expect(countNeedsYou(items)).toBe(3)
  })

  it('counts zero for an empty list', () => {
    expect(countNeedsYou([])).toBe(0)
  })

  it('counts one for a single non-draft item', () => {
    expect(countNeedsYou([makeRow('awaiting-human')])).toBe(1)
  })

  it('counts zero when all items are draft-proposals', () => {
    const items = [
      makeRow('draft-proposal', { entityId: 'p1' }),
      makeRow('draft-proposal', { entityId: 'p2' }),
    ]
    expect(countNeedsYou(items)).toBe(0)
  })
})
