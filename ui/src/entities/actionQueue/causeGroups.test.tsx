// @vitest-environment happy-dom
/**
 * Cause-grouping tests.
 *
 * Covers:
 *   - buildRenderedRows: 19 same-cause + 3 distinct rows → 4 rendered rows
 *   - buildRenderedRows: causeGroup members array is complete and correct
 *   - TriageCauseGroupRow: expanding the group discloses member rows
 *   - TriageCauseGroupRow: the action row (bulk button) renders once, not per-member
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { buildRenderedRows, sortItems } from './clusterRows'
import type { ActionQueueItem } from '@/shared/schemas'

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockDispatchAlertVerb = vi.fn().mockResolvedValue(undefined)
vi.mock('@/widgets/chat/alertVerbs', () => ({
  dispatchAlertVerb: (...args: unknown[]) => mockDispatchAlertVerb(...args),
  resolveThreadForItem: vi.fn().mockResolvedValue('thread-id'),
}))

vi.mock('@/shared/api', () => ({
  postDecision: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  snoozeActionQueueItem: vi.fn().mockResolvedValue(undefined),
  startThreadForQueueItem: vi.fn().mockResolvedValue({ id: 'thread-id' }),
}))

vi.mock('@/entities/alerts/api', () => ({
  startThreadFromAlert: vi.fn().mockResolvedValue({ threadId: 'thread-id' }),
}))

const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined)
vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  )
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  }
})

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  useFocusedProject: () => ({
    projects: [],
    focusedProject: null,
    isLoading: false,
  }),
}))

vi.mock('@/shared/actionQueueUrlState', () => ({
  defaultAqUrlState: () => ({}),
  encodeAqState: () => '',
}))

vi.mock('@/shared/routing', () => ({
  taskHash: (id: string) => `#/task/${id}`,
}))

vi.mock('@/shared/time', () => ({
  relativeTime: () => 'just now',
}))

vi.mock('@/shared/schemas', async () => {
  const actual = await vi.importActual<typeof import('@/shared/schemas')>('@/shared/schemas')
  return actual
})

vi.mock('@/components/CollapsibleSection', () => ({
  CollapsibleSection: ({ children, label }: { children: React.ReactNode; label: string }) => (
    <details>
      <summary>{label}</summary>
      {children}
    </details>
  ),
}))

// ── Test helpers ──────────────────────────────────────────────────────────────

let idCounter = 0
const makeItem = (
  kind: string,
  overrides: Partial<ActionQueueItem> = {},
): ActionQueueItem =>
  ({
    id: `item-${++idCounter}`,
    entityId: `entity-${idCounter}`,
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
    recoveryExhausted: false,
    ...overrides,
  }) as ActionQueueItem

// ── buildRenderedRows — cause grouping ────────────────────────────────────────

describe('buildRenderedRows — cause grouping', () => {
  beforeEach(() => {
    idCounter = 0
  })

  it('collapses 19 same-cause rows + 3 distinct rows into 4 rendered rows', () => {
    const SHARED_SIG = 'slice-failed/slicer-timeout'
    const sameCause = Array.from({ length: 19 }, (_, i) =>
      makeItem('slice-failed', {
        id: `sf-${i}`,
        entityId: `prd-${i}`,
        failureReasonCode: SHARED_SIG,
      }),
    )
    // 3 distinct items with no failureReasonCode — each stays as a plain item
    const distinct = [
      makeItem('awaiting-human', { id: 'd1', entityId: 'ah-1' }),
      makeItem('awaiting-human', { id: 'd2', entityId: 'ah-2' }),
      makeItem('awaiting-human', { id: 'd3', entityId: 'ah-3' }),
    ]

    const rows = buildRenderedRows(sortItems([...sameCause, ...distinct]))

    // 1 causeGroup + 3 plain items = 4 rendered rows
    expect(rows).toHaveLength(4)
  })

  it('the causeGroup row contains all 19 members', () => {
    const SHARED_SIG = 'slice-failed/slicer-timeout'
    const sameCause = Array.from({ length: 19 }, (_, i) =>
      makeItem('slice-failed', {
        id: `sf-${i}`,
        entityId: `prd-${i}`,
        failureReasonCode: SHARED_SIG,
      }),
    )
    const distinct = [makeItem('awaiting-human', { id: 'd1' })]

    const rows = buildRenderedRows(sortItems([...sameCause, ...distinct]))
    const group = rows.find((r) => r.type === 'causeGroup')

    expect(group).toBeDefined()
    if (group?.type !== 'causeGroup') throw new Error('expected causeGroup')
    expect(group.count).toBe(19)
    expect(group.members).toHaveLength(19)
  })

  it('emits a plain item when only one row shares a failureReasonCode (singleton)', () => {
    const rows = buildRenderedRows(
      sortItems([
        makeItem('slice-failed', {
          id: 'solo',
          entityId: 'prd-solo',
          failureReasonCode: 'slice-failed/unique',
        }),
      ]),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('item')
  })

  it('groups separately by (kind, signature) — different kinds stay apart', () => {
    const SIG = 'common/timeout'
    const rows = buildRenderedRows(
      sortItems([
        makeItem('slice-failed', { id: 'a1', entityId: 'e1', failureReasonCode: SIG }),
        makeItem('slice-failed', { id: 'a2', entityId: 'e2', failureReasonCode: SIG }),
        makeItem('failed', { id: 'b1', entityId: 'e3', failureReasonCode: SIG }),
        makeItem('failed', { id: 'b2', entityId: 'e4', failureReasonCode: SIG }),
      ]),
    )
    // Two separate causeGroups, one per kind
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.type === 'causeGroup')).toBe(true)
  })

  it('does not cause-group items that are entity-grouped', () => {
    // Two items for the SAME task (entity group): they share failureReasonCode
    // but should be entity-grouped, not cause-grouped.
    const SIG = 'shared/cause'
    const rows = buildRenderedRows(
      sortItems([
        makeItem('failed', { id: 'x', entityId: 'task-shared', failureReasonCode: SIG }),
        makeItem('gate-broken', { id: 'y', entityId: 'task-shared', failureReasonCode: SIG }),
      ]),
    )
    // Entity-grouped into 1 entityGroup, not a causeGroup
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('entityGroup')
  })
})

// ── TriageCauseGroupRow — component tests ────────────────────────────────────

import React from 'react'
import { TriageCauseGroupRow } from '@/pages/TriagePage'

describe('TriageCauseGroupRow', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    idCounter = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function makeGroup(
    memberCount: number,
    opts: { bulkResolveVerb?: { op: string; label: string; style: 'primary' | 'default' | 'destructive' | 'snooze' } } = {},
  ) {
    const SIG = 'slice-failed/slicer-timeout'
    const members = Array.from({ length: memberCount }, (_, i) =>
      makeItem('slice-failed', {
        id: `sf-${i}`,
        entityId: `prd-${i}`,
        failureReasonCode: SIG,
        verbs: [{ op: 'retry', label: 'Retry', style: 'primary' as const }],
      }),
    )
    return {
      type: 'causeGroup' as const,
      id: `causeGroup:slice-failed:${SIG}`,
      kind: 'slice-failed',
      signature: SIG,
      count: members.length,
      priority: 'normal' as const,
      members,
      ...opts,
    }
  }

  it('the bulk action button renders once in the collapsed header when bulkResolveVerb is declared', () => {
    // Group with a bulkResolveVerb → primary action button appears.
    const group = makeGroup(19, {
      bulkResolveVerb: { op: 'proposal.slice', label: 'Retry', style: 'primary' as const },
    })
    act(() => {
      root.render(<TriageCauseGroupRow group={group} />)
    })

    // Only ONE primary bulk action button visible (not 19, one per member)
    const bulkButtons = container.querySelectorAll('[data-testid="cause-group-bulk-action"]')
    expect(bulkButtons).toHaveLength(1)
    expect(bulkButtons[0]?.textContent).toContain('Retry all 19')

    // Member rows are not rendered while collapsed
    const memberContainer = container.querySelector('[data-testid="cause-group-members"]')
    expect(memberContainer).toBeNull()
  })

  it('shows only Snooze all when kind declares no bulkResolveVerb', () => {
    // Group without bulkResolveVerb → no primary button, only Snooze all.
    const group = makeGroup(5)
    act(() => {
      root.render(<TriageCauseGroupRow group={group} />)
    })

    const bulkButtons = container.querySelectorAll('[data-testid="cause-group-bulk-action"]')
    expect(bulkButtons).toHaveLength(0)

    const snoozeButton = container.querySelector('[data-testid="cause-group-snooze-all"]')
    expect(snoozeButton).not.toBeNull()
  })

  it('expanding the toggle reveals all member rows', () => {
    const group = makeGroup(5)
    act(() => {
      root.render(<TriageCauseGroupRow group={group} />)
    })

    const toggle = container.querySelector('[data-testid="cause-group-toggle"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()

    act(() => {
      toggle.click()
    })

    // Members container appears after toggle
    const memberContainer = container.querySelector('[data-testid="cause-group-members"]')
    expect(memberContainer).not.toBeNull()
    // One TriageRow per member (each has data-testid indirectly via kind chip or card)
    expect(group.members).toHaveLength(5)
  })

  it('leads with the blast radius, in the row\u2019s largest type', () => {
    const group = makeGroup(19)
    act(() => {
      root.render(<TriageCauseGroupRow group={group} />)
    })

    const count = container.querySelector('[data-testid="cause-group-count"]')
    expect(count).not.toBeNull()
    expect(count!.textContent).toBe('19tasks')

    // The number itself, not the whole span, carries the size. A cause holding
    // nineteen tasks rendered as a `19\u00d7` info chip on the thinnest row on
    // the page while one failed task got a card ten times its height: visual
    // weight ran opposite to blast radius. The number must be set larger than
    // the body copy beside it, or the fix is cosmetic only.
    const numeral = count!.firstElementChild!
    expect(numeral.textContent).toBe('19')
    expect(numeral.className).toContain('text-base')
    expect(numeral.className).toContain('tabular-nums')

    // Group members are collapsed \u2014 individual member rows absent from DOM
    const memberRows = container.querySelector('[data-testid="cause-group-members"]')
    expect(memberRows).toBeNull()
  })

  it('singularises the unit for a one-member group', () => {
    const group = makeGroup(1)
    act(() => {
      root.render(<TriageCauseGroupRow group={group} />)
    })
    expect(
      container.querySelector('[data-testid="cause-group-count"]')!.textContent,
    ).toBe('1task')
  })

  it('never prints a raw slug on the face of the row', () => {
    // The daemon's `causeLabel` is frequently the failure slug itself. This row
    // preferred it over the mapped phrase, so a live queue showed
    // `unclassified` and `done-with-unverifiable-merge` verbatim on three
    // cards \u2014 the one surface still breaking the rule the rest of the UI
    // follows (DEC-18: slugs live behind the disclosure, never on the face).
    const group = {
      ...makeGroup(7),
      kind: 'failed',
      signature: 'code/unclassified',
      causeLabel: 'unclassified',
    }
    act(() => {
      root.render(<TriageCauseGroupRow group={group} />)
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Coding step failed \u2014 cause not identified')
    expect(text).not.toContain('unclassified')
  })

  it('de-slugifies a cause the phrase table does not know', () => {
    const group = {
      ...makeGroup(3),
      kind: 'failed',
      signature: 'done-with-unverifiable-merge',
      causeLabel: 'done-with-unverifiable-merge',
    }
    act(() => {
      root.render(<TriageCauseGroupRow group={group} />)
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Merged, but the merge could not be verified')
    expect(text).not.toContain('done-with-unverifiable-merge')
  })
})
