/**
 * Unit tests for signature-based action-queue grouping.
 *
 * The key invariant: 18 rows that share (kind, failureReasonCode) collapse
 * into ONE group row, 3 rows with distinct signatures stay as 3 individual
 * rows, and skipping groupActionQueueRows emits all 21.
 *
 * These tests live here — next to the shared grouping module — not under
 * cli/, because groupActionQueueRows is a shared-layer concern applied by
 * the daemon's HTTP endpoint before either the CLI or the UI reads it.
 */

import { describe, it, expect } from 'vitest'
import { groupActionQueueRows } from '../action-queue-group'
import type { ActionQueueRow } from '../action-queue'

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
    goalIsInherited: false,
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

  it('skipping groupActionQueueRows yields all 21 raw rows', () => {
    // Grouping is opt-out (--no-group) by passing the raw rows through without
    // calling groupActionQueueRows. Verify that the raw input has 21 rows.
    const rows = makeMixedRows()
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

  it('rows with no failureReasonCode AND no errorExcerpt are never grouped', () => {
    _seq = 0
    const rows = [
      makeRow('awaiting-human', null),
      makeRow('awaiting-human', null),
      makeRow('awaiting-human', null),
    ]
    // humanDetail is {} (no errorExcerpt) → no cause key → all ungrouped
    const result = groupActionQueueRows(rows)

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

  it('two rows sharing failureReasonCode but with different humanDetail.failureSignature stay in separate buckets', () => {
    // The live symptom: mars-874b2a81 (setup/unclassified) and mars-3176234e
    // (code/test-assertion-error) both carried failure_reason_code='terminal/unclassified'.
    // The old grouper bucketed by reason code and collapsed them into one group
    // with a single misleading headline. The fix: prefer humanDetail.failureSignature
    // as the bucket key so different root causes stay separated.
    _seq = 0
    const rows = [
      makeRow('failed', 'terminal/unclassified', {
        humanDetail: { failureSignature: 'setup/unclassified' },
      }),
      makeRow('failed', 'terminal/unclassified', {
        humanDetail: { failureSignature: 'code/test-assertion-error' },
      }),
    ]
    const result = groupActionQueueRows(rows)
    // Different signatures → two separate singletons, not one group.
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.type === 'item')).toBe(true)
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

// ── excerpt-based grouping (cause-key fallback) ───────────────────────────────

/**
 * The real-world trigger for this feature: 18 slice-failed rows raised by the
 * proposal slicer share no `failureReasonCode` but carry the same
 * `errorExcerpt`.  Their excerpts may differ only in variable tokens (PRD ids,
 * hex strings) — the normalisation must absorb those differences while keeping
 * a genuinely different excerpt in a separate bucket.
 */
describe('groupActionQueueRows — excerpt-based cause-key fallback', () => {
  /** Canonical "Connection refused" excerpt, parameterised only by a PRD id. */
  const makeSliceFailedRow = (prdId: string, overrides: Partial<ActionQueueRow> = {}): ActionQueueRow => {
    const n = ++_seq
    const excerpt = `slice workflow failed — error: provider worker exited 1 for prd ${prdId}: API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)`
    return {
      id: `aq-${n}`,
      entityId: `prd-${prdId}`,
      kind: 'slice-failed' as ActionQueueRow['kind'],
      priority: 'high',
      title: `Mars could not turn this PRD into tasks — inspect the PRD, then slice it again when ready.`,
      body: '',
      at: `2026-08-${String((n % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      dag: null,
      errorKind: 'slice-failed',
      actions: [],
      staleWorktreeDetail: null,
      devServerUrl: null,
      leaseState: null,
      diagnosis: null,
      failureReasonCode: null,   // ← no failureReasonCode — this is the key
      recoveryExhausted: false,
      fixForTaskId: null,
      humanSummary: 'Mars could not turn this PRD into tasks — inspect the PRD, then slice it again when ready.',
      humanDetail: { errorExcerpt: excerpt },
      verbs: [],
      arcGoal: null,
      operatorGoal: null,
      goalIsInherited: false,
      class: 'alert',
      noticeKey: null,
      ...overrides,
    } as ActionQueueRow
  }

  it('18 rows whose excerpts differ only by PRD id collapse into one group', () => {
    _seq = 0
    // Each excerpt names a different PRD id; the normalisation strips ids/digits.
    const rows = Array.from({ length: 18 }, (_, i) => makeSliceFailedRow(`prd-${i + 1}`))
    const result = groupActionQueueRows(rows)

    expect(result).toHaveLength(1)
    const group = result[0]
    expect(group?.type).toBe('group')
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.count).toBe(18)
  })

  it('a row with a different excerpt stays in its own bucket', () => {
    _seq = 0
    const shared = Array.from({ length: 18 }, (_, i) => makeSliceFailedRow(`prd-${i + 1}`))
    const outlier: ActionQueueRow = {
      ...makeSliceFailedRow('prd-99'),
      humanDetail: { errorExcerpt: 'failed to parse claude JSON' },
    }
    const rows = [...shared, outlier]
    const result = groupActionQueueRows(rows)

    // 18 same-cause → 1 group;  1 different-cause → 1 item  →  2 output rows
    expect(result).toHaveLength(2)
    const group = result.find((r) => r.type === 'group')
    expect(group?.type).toBe('group')
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.count).toBe(18)

    const item = result.find((r) => r.type === 'item')
    expect(item?.type).toBe('item')
    if (item?.type !== 'item') throw new Error('expected item')
    expect(item.row.humanDetail.errorExcerpt).toBe('failed to parse claude JSON')
  })

  it('skipping groupActionQueueRows yields all 19 raw rows', () => {
    _seq = 0
    const shared = Array.from({ length: 18 }, (_, i) => makeSliceFailedRow(`prd-${i + 1}`))
    const outlier: ActionQueueRow = {
      ...makeSliceFailedRow('prd-99'),
      humanDetail: { errorExcerpt: 'failed to parse claude JSON' },
    }
    const rows = [...shared, outlier]
    // Without grouping, every raw row becomes one display line.
    expect(rows).toHaveLength(19)
  })

  it('excerpt-based singleton rows render as plain items, not group rows', () => {
    _seq = 0
    const rows = [makeSliceFailedRow('prd-only')]
    const result = groupActionQueueRows(rows)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('item')
  })

  it('excerpt-based groups keep different kinds separate even when excerpts normalise identically', () => {
    _seq = 0
    const excerpt = 'Connection refused'
    const makeKind = (kind: string) => ({
      ...makeSliceFailedRow('prd-1'),
      kind: kind as ActionQueueRow['kind'],
      errorKind: kind,
      humanDetail: { errorExcerpt: excerpt },
    })
    const rows = [makeKind('slice-failed'), makeKind('slice-failed'), makeKind('other-kind'), makeKind('other-kind')]
    const result = groupActionQueueRows(rows)
    // Two kinds × one group each = 2 group rows
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.type === 'group')).toBe(true)
  })
})

// ── bulk-resolve verb (Recipe.bulkResolveVerb) ────────────────────────────────

describe('groupActionQueueRows — bulk-resolve verb', () => {
  it('a group whose kind declares a bulkResolveVerb carries that verb on the group row', () => {
    _seq = 0
    // slice-failed declares bulkResolveVerb: { op: 'proposal.slice', label: 'Retry', style: 'primary' }
    const rows = [
      makeRow('slice-failed', 'code/some-error'),
      makeRow('slice-failed', 'code/some-error'),
    ]
    const result = groupActionQueueRows(rows)

    expect(result).toHaveLength(1)
    const group = result[0]
    expect(group?.type).toBe('group')
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.bulkResolveVerb).toBeDefined()
    expect(group.bulkResolveVerb?.op).toBe('proposal.slice')
    expect(group.bulkResolveVerb?.label).toBe('Retry')
    expect(group.bulkResolveVerb?.style).toBe('primary')
  })

  it('a group whose kind declares no bulkResolveVerb has bulkResolveVerb=undefined', () => {
    _seq = 0
    // 'failed' has no bulkResolveVerb declared in the recipe
    const rows = [
      makeRow('failed', 'code/typecheck-error'),
      makeRow('failed', 'code/typecheck-error'),
    ]
    const result = groupActionQueueRows(rows)

    expect(result).toHaveLength(1)
    const group = result[0]
    expect(group?.type).toBe('group')
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.bulkResolveVerb).toBeUndefined()
  })

  it('partial retry: re-running groupActionQueueRows on remaining failures regroups them', () => {
    _seq = 0
    // 5 rows total: 2 "succeed" (leave the queue), 3 remain.
    // Use excerpt-based grouping (no failureReasonCode) like real slice-failed rows.
    const excerpt = 'slice workflow failed — API Error: Connection refused (ConnectionRefused)'
    const all = Array.from({ length: 5 }, () =>
      makeRow('slice-failed', null, { humanDetail: { errorExcerpt: excerpt } }),
    )
    // Simulate 2 resolved (removed from the queue) — only 3 remain.
    const remaining = all.slice(2)

    const result = groupActionQueueRows(remaining)

    // The 3 remaining rows still collapse into one group.
    expect(result).toHaveLength(1)
    const group = result[0]
    expect(group?.type).toBe('group')
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.count).toBe(3)
    // The group still carries the bulk-resolve verb so a follow-up retry is possible.
    expect(group.bulkResolveVerb?.op).toBe('proposal.slice')
  })
})

// ── recovery-abandoned grouping ───────────────────────────────────────────────
//
// Defect 3: rows with no cause key fell through to excerpt normalisation, which
// produced four separate high-priority rows even when three had identical
// situations.  After the fix, zero-ahead rows carry `failureReasonCode =
// 'recovery-abandoned:no-commits'` and collapse into a group; a nonzero-ahead
// row carries `failureReasonCode = null` and stays separate.

describe('recovery-abandoned grouping', () => {
  it('three zero-ahead rows collapse into a single group', () => {
    _seq = 0
    const rows = Array.from({ length: 3 }, () =>
      makeRow('recovery-abandoned', 'recovery-abandoned:no-commits', {
        humanDetail: {
          fixTaskId: `fix-${_seq}`,
          originTaskId: `mars-${_seq}`,
          commitsAhead: 0,
        },
      }),
    )

    const result = groupActionQueueRows(rows)
    expect(result).toHaveLength(1)
    const group = result[0]
    expect(group?.type).toBe('group')
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.count).toBe(3)
  })

  it('a nonzero-ahead row stays as a separate item (not grouped with zero-ahead rows)', () => {
    _seq = 0
    // Three zero-ahead rows: will collapse into one group.
    const zeroRows = Array.from({ length: 3 }, () =>
      makeRow('recovery-abandoned', 'recovery-abandoned:no-commits', {
        humanDetail: { commitsAhead: 0 },
      }),
    )
    // One nonzero-ahead row: no failureReasonCode → stays separate.
    const hasCommitsRow = makeRow('recovery-abandoned', null, {
      humanDetail: {
        commitsAhead: 1,
        branch: 'task/mars-a85fcea2',
        restartConsequence: 'Restart discards 1 commit on task/mars-a85fcea2.',
      },
    })

    const result = groupActionQueueRows([...zeroRows, hasCommitsRow])

    // 1 group (the three zero-ahead) + 1 item (the nonzero-ahead) = 2
    expect(result).toHaveLength(2)

    const group = result.find((r) => r.type === 'group')
    expect(group).toBeDefined()
    if (group?.type !== 'group') throw new Error('expected group')
    expect(group.count).toBe(3)

    const single = result.find((r) => r.type === 'item')
    expect(single).toBeDefined()
    if (single?.type !== 'item') throw new Error('expected item')
    expect(single.row.id).toBe(hasCommitsRow.id)
  })
})
