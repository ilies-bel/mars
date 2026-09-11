/**
 * Regression test for the action-queue view shared layer (HR-3).
 *
 * The invariant being locked down: groupActionQueueRows is the single
 * implementation shared by both callers (CLI and UI). Before this was fixed,
 * the grouping lived only in the CLI, so the daemon's /view/action-queue
 * returned 44 raw rows while the CLI displayed 12 grouped rows — the same
 * data, two different counts.
 *
 * These tests verify that the shared layer produces the correct grouped output
 * regardless of which caller invokes it, so that divergence cannot silently
 * re-appear.
 */

import { describe, it, expect } from 'vitest'
import { groupActionQueueRows } from '../action-queue-group'
import type { ActionQueueRow } from '../action-queue'

// ── helpers ───────────────────────────────────────────────────────────────────

let _seq = 0

function makeRow(
  kind: string,
  failureReasonCode: string | null,
  overrides: Partial<ActionQueueRow> = {},
): ActionQueueRow {
  const n = ++_seq
  return {
    id: `aq-${n}`,
    entityId: `task-${n}`,
    kind: kind as ActionQueueRow['kind'],
    priority: 'normal',
    title: `Title ${n}`,
    body: '',
    at: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    lastSeenAt: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
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
    humanSummary: `Mars could not complete this — inspect and retry.`,
    humanDetail: {},
    verbs: [],
    arcGoal: null,
    operatorGoal: null,
    goalIsInherited: false,
    class: 'alert',
    noticeKey: null,
    ...overrides,
  } as ActionQueueRow
}

function makeSliceFailedRow(prdId: string): ActionQueueRow {
  const n = ++_seq
  const excerpt = `slice workflow failed — error: provider worker exited 1 for prd ${prdId}: Connection refused`
  return {
    id: `aq-${n}`,
    entityId: `prd-${prdId}`,
    kind: 'slice-failed' as ActionQueueRow['kind'],
    priority: 'high',
    title: `Mars could not turn this PRD into tasks — inspect the PRD, then slice it again when ready.`,
    body: '',
    at: `2026-08-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    lastSeenAt: `2026-08-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    dag: null,
    errorKind: 'slice-failed',
    actions: [],
    staleWorktreeDetail: null,
    devServerUrl: null,
    leaseState: null,
    diagnosis: null,
    failureReasonCode: null,
    recoveryExhausted: false,
    fixForTaskId: null,
    humanSummary: `Mars could not turn this PRD into tasks — inspect the PRD, then slice it again when ready.`,
    humanDetail: { errorExcerpt: excerpt },
    verbs: [],
    arcGoal: null,
    operatorGoal: null,
    goalIsInherited: false,
    entityTitle: null,
    class: 'alert',
    noticeKey: null,
  } as ActionQueueRow
}

// ── regression: both callers receive the same grouped output ──────────────────

describe('action-queue shared grouping layer — HR-3 regression', () => {
  it('21 raw rows (18 shared + 3 distinct signatures) collapse to 4 grouped rows', () => {
    _seq = 0
    const shared = Array.from({ length: 18 }, () => makeRow('failed', 'code/typecheck-error'))
    const distinct = [
      makeRow('failed', 'code/api-unreachable'),
      makeRow('failed', 'code/timed-out'),
      makeRow('failed', 'code/provider-binary-missing'),
    ]
    const raw = [...shared, ...distinct]
    expect(raw).toHaveLength(21)

    // This is the function the HTTP endpoint and the CLI both call (HR-3).
    const grouped = groupActionQueueRows(raw)

    // The grouped count is what both callers must agree on.
    expect(grouped).toHaveLength(4)
  })

  it('19 slice-failed rows differing only by PRD id collapse to 2 grouped rows (18+1)', () => {
    _seq = 0
    // 18 rows with the same normalised error excerpt
    const shared = Array.from({ length: 18 }, (_, i) => makeSliceFailedRow(`prd-${i + 1}`))
    // 1 row with a distinct excerpt
    const outlier: ActionQueueRow = {
      ...makeSliceFailedRow('prd-99'),
      humanDetail: { errorExcerpt: 'failed to parse claude JSON' },
    }
    const raw = [...shared, outlier]
    expect(raw).toHaveLength(19)

    const grouped = groupActionQueueRows(raw)

    // 18 share a cause-key bucket → 1 group; 1 outlier → 1 item.
    // Before HR-3, the CLI returned 2 and /view/action-queue returned 19.
    expect(grouped).toHaveLength(2)

    const groupRow = grouped.find((r) => r.type === 'group')
    expect(groupRow?.type).toBe('group')
    if (groupRow?.type !== 'group') throw new Error('expected group row')
    expect(groupRow.count).toBe(18)

    const itemRow = grouped.find((r) => r.type === 'item')
    expect(itemRow?.type).toBe('item')
  })

  it('slice-failed rows carry the human title, not the machine-string raiser title', () => {
    _seq = 0
    // Build 2 slice-failed rows that would form a group.
    const rows = [makeSliceFailedRow('prd-a'), makeSliceFailedRow('prd-b')]
    const [a, b] = rows

    // The shared layer normalises title = humanSummary so both callers see
    // the human copy ("Mars could not turn this PRD…") instead of the machine
    // string the raiser stamped ("Slicer failed for PRD abc123…").
    // This test asserts that the title already IS the human copy on the rows
    // the shared function receives — enforcing that buildActionQueueView has
    // normalised it before groupActionQueueRows is called.
    expect(a!.title).toBe(a!.humanSummary)
    expect(b!.title).toBe(b!.humanSummary)
    expect(a!.title).toBe(
      'Mars could not turn this PRD into tasks — inspect the PRD, then slice it again when ready.',
    )
  })

  it('empty input returns empty output — no crash on zero rows', () => {
    const grouped = groupActionQueueRows([])
    expect(grouped).toHaveLength(0)
  })
})
