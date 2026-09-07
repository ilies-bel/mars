/**
 * Terminal-formatting tests for action-queue grouped rows.
 *
 * The grouping logic (groupActionQueueRows) has moved to
 * `core/daemon/view/action-queue-group.ts` and its tests live at
 * `core/daemon/view/__tests__/action-queue-group.test.ts`.
 *
 * This file contains only the CLI's presentation concern: the TSV formatter
 * that renders a grouped row as a single tab-separated line for the terminal.
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
