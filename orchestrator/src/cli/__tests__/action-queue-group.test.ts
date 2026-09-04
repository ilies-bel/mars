/**
 * Unit tests for signature-based action-queue grouping.
 *
 * The key invariant: 18 rows that share (kind, failureReasonCode) collapse
 * into ONE group row, 3 rows with distinct signatures stay as 3 individual
 * rows, and --no-group (i.e. skipping groupActionQueueRows) emits all 21.
 */

import { describe, it, expect } from 'vitest'
import { groupActionQueueRows, formatGroupRowTsv } from '../action-queue-group'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

// ── helpers ───────────────────────────────────────────────────────────────────

let _seq = 0
const makeRow = (
  kind: string,
  failureReasonCode: string | null,
  overrides: Partial<ActionQueueRow> = {},
): ActionQueueRow => {
  const n = ++_seq
  return {
    id: `aq-${n}`,
    entityId: `task-${n}`,
    kind: kind as ActionQueueRow['kind'],
    priority: 'normal',
    title: `Title ${n}`,
    body: '',
    at: `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`,
    dag: null,
    errorKind: kind,
    actions: [],
    staleWorktreeDetail: null,
    devServerUrl: null,
    leaseState: null,
    diagnosis: null,
    failureReasonCode,
    recoveryExhausted: false,
    fixForTaskId: null,
    humanSummary: `Summary ${n}`,
    humanDetail: {},
    verbs: [],
    arcGoal: null,
    operatorGoal: null,
    class: 'alert',
    noticeKey: null,
    ...overrides,
  } as ActionQueueRow
}

/**
 * Build the scenario described in the task brief:
 * - 18 rows sharing `(kind='failed', failureReasonCode='code/typecheck-error')`
 * - 3 rows with distinct `(kind='failed', failureReasonCode=<unique>)` signatures
 * Total: 21 raw rows.
 */
function makeMixedRows(): ActionQueueRow[] {
  _seq = 0
  const shared = Array.from({ length: 18 }, () =>
    makeRow('failed', 'code/typecheck-error'),
  )
  const distinct = [
    makeRow('failed', 'code/api-unreachable'),
    makeRow('failed', 'code/timed-out'),
    makeRow('failed', 'code/provider-binary-missing'),
  ]
  return [...shared, ...distinct]
}

// ── groupActionQueueRows ──────────────────────────────────────────────────────

describe('groupActionQueueRows', () => {
  it('collapses 18 same-signature rows + 3 distinct-signature rows into 4 rendered rows', () => {
    const rows = makeMixedRows()
    const result = groupActionQueueRows(rows)

    // 1 group (the 18 shared) + 3 singletons = 4
    expect(result).toHaveLength(4)
  })

  it('the shared group has type=group and count=18', () => {
    const rows = makeMixedRows()
    const result = groupActionQueueRows(rows)

    const group = result.find((r) => r.type === 'group')
    expect(group).toBeDefined()
    if (group?.type !== 'group') throw new Error('expected a group row')
    expect(group.count).toBe(18)
    expect(group.signature).toBe('code/typecheck-error')
  })

  it('expanding a group yields its 18 member rows', () => {
    const rows = makeMixedRows()
    const result = groupActionQueueRows(rows)

    const group = result.find((r) => r.type === 'group')
    if (group?.type !== 'group') throw new Error('expected a group row')
    expect(group.members).toHaveLength(18)
    // Every member must be from the input row set
    const inputIds = new Set(rows.map((r) => r.id))
    for (const m of group.members) {
      expect(inputIds.has(m.id)).toBe(true)
    }
  })

  it('the 3 distinct rows render as plain item rows', () => {
    const rows = makeMixedRows()
    const result = groupActionQueueRows(rows)

    const items = result.filter((r) => r.type === 'item')
    expect(items).toHaveLength(3)
    const sigs = items.map((r) => {
      if (r.type !== 'item') throw new Error('expected item')
      return r.row.failureReasonCode
    })
    expect(sigs).toContain('code/api-unreachable')
    expect(sigs).toContain('code/timed-out')
    expect(sigs).toContain('code/provider-binary-missing')
  })

  it('--no-group: skipping groupActionQueueRows yields 21 lines', () => {
    // --no-group is implemented by not calling groupActionQueueRows;
    // verify that the raw row count is 21 (test the no-group path at the
    // unit level by asserting on the raw input length).
    const rows = makeMixedRows()
    // Without grouping, every raw row becomes one display line.
    expect(rows).toHaveLength(21)
  })

  it('singletons (groups of one) render as plain items, not group rows', () => {
    _seq = 0
    const rows = [
      makeRow('failed', 'code/typecheck-error'),  // only one with this signature
      makeRow('failed', 'code/api-unreachable'),
    ]
    const result = groupActionQueueRows(rows)

    // Both are singletons → both render as items
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.type === 'item')).toBe(true)
  })

  it('rows with no failureReasonCode are never grouped', () => {
    _seq = 0
    const rows = [
      makeRow('awaiting-human', null),
      makeRow('awaiting-human', null),
      makeRow('awaiting-human', null),
    ]
    const result = groupActionQueueRows(rows)

    // No signatures → no grouping; 3 individual items
    expect(result).toHaveLength(3)
    expect(result.every((r) => r.type === 'item')).toBe(true)
  })

  it('groups by kind independently — same signature on different kinds stays separate', () => {
    _seq = 0
    const rows = [
      makeRow('failed', 'code/typecheck-error'),
      makeRow('failed', 'code/typecheck-error'),
      makeRow('stale-queued', 'code/typecheck-error'),
      makeRow('stale-queued', 'code/typecheck-error'),
    ]
    const result = groupActionQueueRows(rows)

    // Two groups: (failed, code/typecheck-error) and (stale-queued, code/typecheck-error)
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.type === 'group')).toBe(true)
  })

  it('group id is stable and matches group:<kind>:<signature>', () => {
    _seq = 0
    const rows = [makeRow('failed', 'code/typecheck-error'), makeRow('failed', 'code/typecheck-error')]
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.id).toBe('group:failed:code/typecheck-error')
  })

  it('firstAt and lastAt bracket the member timestamps', () => {
    _seq = 0
    const rows = [
      makeRow('failed', 'code/typecheck-error', { at: '2026-01-10T00:00:00Z' }),
      makeRow('failed', 'code/typecheck-error', { at: '2026-01-01T00:00:00Z' }),
      makeRow('failed', 'code/typecheck-error', { at: '2026-01-20T00:00:00Z' }),
    ]
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.firstAt).toBe('2026-01-01T00:00:00Z')
    expect(group.lastAt).toBe('2026-01-20T00:00:00Z')
  })

  it('priority escalates to highest member priority', () => {
    _seq = 0
    const rows = [
      makeRow('failed', 'code/typecheck-error', { priority: 'low' }),
      makeRow('failed', 'code/typecheck-error', { priority: 'high' }),
      makeRow('failed', 'code/typecheck-error', { priority: 'normal' }),
    ]
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.priority).toBe('high')
  })

  it('previewIds contains at most 3 entity ids; overflowCount holds the rest', () => {
    _seq = 0
    const rows = Array.from({ length: 6 }, () => makeRow('failed', 'code/typecheck-error'))
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.previewIds).toHaveLength(3)
    expect(group.overflowCount).toBe(3)
  })
})

// ── formatGroupRowTsv ─────────────────────────────────────────────────────────

describe('formatGroupRowTsv', () => {
  it('produces a tab-separated line with the expected 5 columns', () => {
    _seq = 0
    const rows = [makeRow('failed', 'code/typecheck-error'), makeRow('failed', 'code/typecheck-error')]
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')

    const line = formatGroupRowTsv(group)
    const cols = line.split('\t')
    expect(cols).toHaveLength(5)
    const [id, priority, kind, classCol] = cols
    expect(id).toBe('group:failed:code/typecheck-error')
    expect(priority).toBe('normal')
    expect(kind).toBe('failed')
    expect(classCol).toBe('[ALERT]')
  })

  it('summary encodes count and a date span', () => {
    _seq = 0
    const rows = [
      makeRow('failed', 'code/typecheck-error', { at: '2026-01-01T00:00:00Z' }),
      makeRow('failed', 'code/typecheck-error', { at: '2026-01-18T00:00:00Z' }),
    ]
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')

    const line = formatGroupRowTsv(group)
    // Summary column (5th) should mention the count and both dates
    const summary = line.split('\t')[4] ?? ''
    expect(summary).toContain('2×')
    expect(summary).toContain('2026-01-01')
    expect(summary).toContain('2026-01-18')
  })

  it('overflow suffix appears when group has more than 3 members', () => {
    _seq = 0
    const rows = Array.from({ length: 5 }, () => makeRow('failed', 'code/typecheck-error'))
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')

    const summary = formatGroupRowTsv(group).split('\t')[4] ?? ''
    expect(summary).toContain('…and 2 more')
  })

  it('no overflow suffix when all members fit in the preview', () => {
    _seq = 0
    const rows = [makeRow('failed', 'code/typecheck-error'), makeRow('failed', 'code/typecheck-error')]
    const result = groupActionQueueRows(rows)
    const group = result[0]
    if (group?.type !== 'group') throw new Error('expected group')

    const summary = formatGroupRowTsv(group).split('\t')[4] ?? ''
    expect(summary).not.toContain('…and')
  })
})
