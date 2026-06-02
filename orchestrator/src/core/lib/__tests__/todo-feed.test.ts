import { describe, it, expect } from 'vitest'
import {
  BUCKET_ORDER,
  bucketFor,
  buildTodoFeed,
  groupTodoIntoBuckets,
  itemKey,
  itemTimestamp,
  type TodoItem,
} from '../todo-feed'

// Fixed reference now: 2026-05-20T12:00:00Z. All test inputs are computed
// relative to this so the suite is deterministic regardless of wall clock.
const NOW = Date.parse('2026-05-20T12:00:00Z')
const HOUR = 3_600_000

describe('bucketFor', () => {
  it('places items less than 24h old in "today"', () => {
    expect(bucketFor(NOW - 0, NOW)).toBe('today')
    expect(bucketFor(NOW - 1 * HOUR, NOW)).toBe('today')
    expect(bucketFor(NOW - 23 * HOUR, NOW)).toBe('today')
  })

  it('places items 24–48h old in "yesterday"', () => {
    expect(bucketFor(NOW - 24 * HOUR, NOW)).toBe('yesterday')
    expect(bucketFor(NOW - 36 * HOUR, NOW)).toBe('yesterday')
    expect(bucketFor(NOW - 47 * HOUR, NOW)).toBe('yesterday')
  })

  it('places items 48h–7d old in "this_week"', () => {
    expect(bucketFor(NOW - 48 * HOUR, NOW)).toBe('this_week')
    // 6 days ago — well inside the week
    expect(bucketFor(NOW - 6 * 24 * HOUR, NOW)).toBe('this_week')
  })

  it('places items 7d or older in "older"', () => {
    expect(bucketFor(NOW - 7 * 24 * HOUR, NOW)).toBe('older')
    expect(bucketFor(NOW - 8 * 24 * HOUR, NOW)).toBe('older')
    expect(bucketFor(NOW - 30 * 24 * HOUR, NOW)).toBe('older')
  })
})

describe('itemKey', () => {
  it('namespaces by kind so drafts and stale items with the same id do not collide', () => {
    const draft: TodoItem = {
      kind: 'draft',
      draft: {
        id: 'shared-id',
        goal: 'g',
        source: 'human',
        acceptanceCount: 0,
        updatedAt: NOW,
      },
    }
    const stale: TodoItem = {
      kind: 'stale',
      worktree: {
        taskId: 'shared-id',
        status: 'running',
        ageHours: 1,
        updatedAt: new Date(NOW).toISOString(),
        prompt: 'p',
      },
    }
    expect(itemKey(draft)).toBe('draft:shared-id')
    expect(itemKey(stale)).toBe('stale:shared-id')
    expect(itemKey(draft)).not.toBe(itemKey(stale))
  })
})

describe('itemTimestamp', () => {
  it('uses the draft updatedAt directly', () => {
    const item: TodoItem = {
      kind: 'draft',
      draft: {
        id: 'd1',
        goal: 'g',
        source: 'human',
        acceptanceCount: 0,
        updatedAt: NOW - 3 * HOUR,
      },
    }
    expect(itemTimestamp(item, NOW)).toBe(NOW - 3 * HOUR)
  })

  it('parses the stale worktree ISO updatedAt', () => {
    const iso = new Date(NOW - 5 * HOUR).toISOString()
    const item: TodoItem = {
      kind: 'stale',
      worktree: {
        taskId: 'w1',
        status: 'running',
        ageHours: 5,
        updatedAt: iso,
        prompt: 'p',
      },
    }
    expect(itemTimestamp(item, NOW)).toBe(NOW - 5 * HOUR)
  })

  it('falls back to ageHours when the ISO is unparseable', () => {
    const item: TodoItem = {
      kind: 'stale',
      worktree: {
        taskId: 'w2',
        status: 'running',
        ageHours: 10,
        updatedAt: 'not-a-date',
        prompt: 'p',
      },
    }
    expect(itemTimestamp(item, NOW)).toBe(NOW - 10 * HOUR)
  })
})

describe('groupTodoIntoBuckets', () => {
  const makeDraft = (id: string, ageHours: number): TodoItem => ({
    kind: 'draft',
    draft: {
      id,
      goal: `goal ${id}`,
      source: 'human',
      acceptanceCount: 0,
      updatedAt: NOW - ageHours * HOUR,
    },
  })

  const makeStale = (taskId: string, ageHours: number): TodoItem => ({
    kind: 'stale',
    worktree: {
      taskId,
      status: 'running',
      ageHours,
      updatedAt: new Date(NOW - ageHours * HOUR).toISOString(),
      prompt: `task ${taskId}`,
    },
  })

  it('returns an empty list when there are no items', () => {
    expect(groupTodoIntoBuckets([], NOW)).toEqual([])
  })

  it('groups across all four buckets in canonical order', () => {
    const items: TodoItem[] = [
      makeDraft('d-today', 2),
      makeStale('w-yesterday', 30),
      makeDraft('d-thisweek', 6 * 24),
      makeStale('w-older', 8 * 24),
    ]
    const groups = groupTodoIntoBuckets(items, NOW)
    expect(groups.map((g) => g.key)).toEqual([
      'today',
      'yesterday',
      'this_week',
      'older',
    ])
    expect(groups[0].items.map(itemKey)).toEqual(['draft:d-today'])
    expect(groups[1].items.map(itemKey)).toEqual(['stale:w-yesterday'])
    expect(groups[2].items.map(itemKey)).toEqual(['draft:d-thisweek'])
    expect(groups[3].items.map(itemKey)).toEqual(['stale:w-older'])
  })

  it('omits empty buckets', () => {
    const items: TodoItem[] = [makeDraft('d-today', 1)]
    const groups = groupTodoIntoBuckets(items, NOW)
    expect(groups.map((g) => g.key)).toEqual(['today'])
  })

  it('sorts items inside a bucket newest-first', () => {
    const items: TodoItem[] = [
      makeDraft('d-old', 5),
      makeDraft('d-new', 1),
      makeStale('w-mid', 3),
    ]
    const groups = groupTodoIntoBuckets(items, NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].items.map(itemKey)).toEqual([
      'draft:d-new',
      'stale:w-mid',
      'draft:d-old',
    ])
  })

  it('places exact-boundary ages on the older side', () => {
    // 24h exactly → yesterday; 7d exactly → older
    const items: TodoItem[] = [
      makeDraft('d-exact-24h', 24),
      makeDraft('d-exact-7d', 7 * 24),
    ]
    const groups = groupTodoIntoBuckets(items, NOW)
    const keys = groups.map((g) => g.key)
    expect(keys).toContain('yesterday')
    expect(keys).toContain('older')
  })
})

describe('buildTodoFeed', () => {
  it('flattens drafts and stale worktrees into a single list', () => {
    const items = buildTodoFeed({
      drafts: [
        {
          id: 'd1',
          goal: 'g',
          source: 'human',
          acceptanceCount: 0,
          updatedAt: NOW,
        },
      ],
      staleWorktrees: [
        {
          taskId: 'w1',
          status: 'running',
          ageHours: 1,
          updatedAt: new Date(NOW).toISOString(),
          prompt: 'p',
        },
      ],
    })
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.kind).sort()).toEqual(['draft', 'stale'])
  })

  it('preserves BUCKET_ORDER as the canonical order', () => {
    expect(BUCKET_ORDER).toEqual(['today', 'yesterday', 'this_week', 'older'])
  })
})
