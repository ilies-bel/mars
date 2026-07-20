/**
 * Unit tests for the projection-Thread helpers: kind filter, search filter,
 * sidebar merge ordering, and resolved-selection detection.
 */
import { describe, expect, it } from 'bun:test'
import {
  draftRowHeadline,
  filterQueueItems,
  isResolvedSelection,
  matchesKindFilter,
  mergeSidebarEntries,
} from './queueThreads'
import type { ActionQueueItem, ChatThread } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ITEM: ActionQueueItem = {
  id: 'failed-task:t-1',
  kind: 'failed-task',
  entityId: 't-1',
  priority: 'normal',
  title: 'Some failed task',
  body: 'Task failed because of X',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
} as unknown as ActionQueueItem

const makeItem = (overrides: Record<string, unknown>): ActionQueueItem =>
  ({ ...BASE_ITEM, ...overrides } as ActionQueueItem)

const makeThread = (overrides: Partial<ChatThread>): ChatThread =>
  ({
    id: 'th-1',
    title: 'A conversation',
    status: 'idle',
    origin: null,
    alertItemId: null,
    alertResolved: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as unknown as ChatThread)

const staleItem = makeItem({
  id: 'stale:s-1',
  kind: 'stale-worktree',
  entityId: 's-1',
  errorKind: 'stale-worktree',
})
const draftItem = makeItem({
  id: 'draft-proposal:d-1',
  kind: 'draft-proposal',
  entityId: 'd-1',
  errorKind: 'draft-proposal',
  title: 'A draft proposal about search',
})

// ---------------------------------------------------------------------------
// matchesKindFilter — all combinations
// ---------------------------------------------------------------------------

describe('matchesKindFilter', () => {
  it('"all" passes every kind', () => {
    expect(matchesKindFilter(BASE_ITEM, 'all')).toBe(true)
    expect(matchesKindFilter(staleItem, 'all')).toBe(true)
    expect(matchesKindFilter(draftItem, 'all')).toBe(true)
  })

  it('"alerts" passes failed-task and stale-worktree, rejects drafts', () => {
    expect(matchesKindFilter(BASE_ITEM, 'alerts')).toBe(true)
    expect(matchesKindFilter(staleItem, 'alerts')).toBe(true)
    expect(matchesKindFilter(draftItem, 'alerts')).toBe(false)
  })

  it('"alerts" passes awaiting-validation', () => {
    const awaiting = makeItem({ kind: 'awaiting-validation', errorKind: 'awaiting-validation' })
    expect(matchesKindFilter(awaiting, 'alerts')).toBe(true)
  })

  it('"drafts" passes only draft-proposal', () => {
    expect(matchesKindFilter(BASE_ITEM, 'drafts')).toBe(false)
    expect(matchesKindFilter(staleItem, 'drafts')).toBe(false)
    expect(matchesKindFilter(draftItem, 'drafts')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// filterQueueItems — search over id / title / body / kind / entityId
// ---------------------------------------------------------------------------

describe('filterQueueItems', () => {
  const items = [BASE_ITEM, staleItem, draftItem]

  it('empty query returns everything under "all"', () => {
    expect(filterQueueItems(items, '', 'all')).toHaveLength(3)
  })

  it('matches by entityId, case-insensitively', () => {
    const result = filterQueueItems(items, 'T-1', 'all')
    expect(result.map((i) => i.id)).toEqual(['failed-task:t-1'])
  })

  it('matches by title substring', () => {
    expect(filterQueueItems(items, 'draft proposal about', 'all')).toHaveLength(1)
  })

  it('matches by body substring', () => {
    expect(filterQueueItems(items, 'because of x', 'all')).toHaveLength(3)
    // BASE_ITEM's body is shared by fixtures; narrow it
    const only = filterQueueItems([BASE_ITEM, draftItem], 'because of x', 'drafts')
    expect(only).toHaveLength(1)
    expect(only[0].kind).toBe('draft-proposal')
  })

  it('matches by kind string', () => {
    expect(filterQueueItems(items, 'stale-worktree', 'all')).toHaveLength(1)
  })

  it('combines search with the kind filter', () => {
    // 'stale-worktree' matches the stale item's kind, but the drafts filter
    // rejects it — the two dimensions AND together.
    expect(filterQueueItems(items, 'stale-worktree', 'drafts')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// draftRowHeadline
// ---------------------------------------------------------------------------

describe('draftRowHeadline', () => {
  it('keeps only the first sentence of multi-sentence prose', () => {
    expect(
      draftRowHeadline('Ship a navigator. It should be keyboard-first. Details in the PRD.'),
    ).toBe('Ship a navigator.')
  })

  it('keeps only the first line when a newline precedes any period', () => {
    expect(draftRowHeadline('Add restart-undo toast\n\nMisclicks are costly.')).toBe(
      'Add restart-undo toast',
    )
  })

  it('returns short single-sentence titles untouched', () => {
    expect(draftRowHeadline('Ship keyboard-first navigator')).toBe(
      'Ship keyboard-first navigator',
    )
  })
})

// ---------------------------------------------------------------------------
// mergeSidebarEntries — projection Threads float above regular chat threads
// ---------------------------------------------------------------------------

describe('mergeSidebarEntries', () => {
  it('puts every open queue row into projections, in server order', () => {
    const { projections } = mergeSidebarEntries([BASE_ITEM, draftItem], [], '', 'all')
    expect(projections.map((p) => p.item.id)).toEqual([
      'failed-task:t-1',
      'draft-proposal:d-1',
    ])
  })

  it('merges an alert-origin thread with a matching live row into ONE entry', () => {
    const alertThread = makeThread({
      id: 'th-alert',
      origin: 'alert',
      alertItemId: 'failed-task:t-1',
    })
    const plainThread = makeThread({ id: 'th-plain', title: 'Plain talk' })
    const { projections, regular } = mergeSidebarEntries(
      [BASE_ITEM],
      [alertThread, plainThread],
      '',
      'all',
    )
    expect(projections).toHaveLength(1)
    expect(projections[0].thread?.id).toBe('th-alert')
    // The merged thread is NOT duplicated in the regular list.
    expect(regular.map((t) => t.id)).toEqual(['th-plain'])
  })

  it('an alert thread whose row left the queue falls back to a regular entry', () => {
    const orphanAlertThread = makeThread({
      id: 'th-orphan',
      origin: 'alert',
      alertItemId: 'failed-task:gone',
    })
    const { projections, regular } = mergeSidebarEntries([], [orphanAlertThread], '', 'all')
    expect(projections).toHaveLength(0)
    expect(regular.map((t) => t.id)).toEqual(['th-orphan'])
  })

  it('search filters regular chat threads by title', () => {
    const a = makeThread({ id: 'a', title: 'Deploy fix' })
    const b = makeThread({ id: 'b', title: 'Unrelated' })
    const { regular } = mergeSidebarEntries([], [a, b], 'deploy', 'all')
    expect(regular.map((t) => t.id)).toEqual(['a'])
  })

  it('non-"all" kind filters hide regular chat threads and scope projections', () => {
    const t = makeThread({ id: 'a', title: 'Talk' })
    const { projections, regular } = mergeSidebarEntries(
      [BASE_ITEM, draftItem],
      [t],
      '',
      'drafts',
    )
    expect(projections.map((p) => p.item.kind)).toEqual(['draft-proposal'])
    expect(regular).toHaveLength(0)
  })

  it('search applies to projections via the queue-row haystack', () => {
    const { projections } = mergeSidebarEntries([BASE_ITEM, draftItem], [], 't-1', 'all')
    expect(projections.map((p) => p.item.id)).toEqual(['failed-task:t-1'])
  })
})

// ---------------------------------------------------------------------------
// isResolvedSelection — resolved pane trigger for vanished rows
// ---------------------------------------------------------------------------

describe('isResolvedSelection', () => {
  it('true when the pinned id is absent from a non-empty live queue', () => {
    expect(isResolvedSelection('failed-task:gone', [BASE_ITEM])).toBe(true)
  })

  it('false when the pinned id is still live', () => {
    expect(isResolvedSelection('failed-task:t-1', [BASE_ITEM])).toBe(false)
  })

  it('false during the initial empty-load frame (no flash)', () => {
    expect(isResolvedSelection('failed-task:gone', [])).toBe(false)
  })

  it('false when nothing is selected', () => {
    expect(isResolvedSelection(null, [BASE_ITEM])).toBe(false)
  })
})
