/**
 * Unit tests for the ActionQueuePage inbox sidebar search / filter behaviour.
 *
 * All tests operate through the public, pure API of TodoPageFilters — no React
 * rendering needed.  This file is excluded from the main tsc project (see
 * tsconfig.json `exclude`) so it uses `bun:test` directly, like the other
 * test files in src/shared/.
 */
import { describe, expect, it } from 'bun:test'
import {
  deriveSelectedKey,
  filterAlertItems,
  filterIdeaItems,
  itemKey,
  type AlertItem,
  type IdeaItem,
} from './TodoPageFilters'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeAlert = (
  taskId: string,
  overrides: Partial<AlertItem['worktree']> = {},
): AlertItem => ({
  kind: 'stale',
  id: taskId,
  worktree: {
    taskId,
    prompt: 'some task',
    status: 'done',
    error: null,
    branch: null,
    blockerTaskId: null,
    ageHours: 24,
    updatedAt: new Date().toISOString(),
    ...overrides,
  },
})

const makeIdea = (
  id: string,
  overrides: Partial<IdeaItem['draft']> = {},
): IdeaItem => ({
  kind: 'draft',
  id,
  draft: {
    id,
    goal: 'ship the feature',
    story: 'as a user, I want this done',
    technical: 'implement with hooks',
    status: 'draft',
    source: 'human',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acceptanceCount: 0,
    ...overrides,
  },
})

// ---------------------------------------------------------------------------
// filterAlertItems
// ---------------------------------------------------------------------------

describe('filterAlertItems', () => {
  it('filters Alerts by taskId substring', () => {
    const alerts = [makeAlert('abc-123'), makeAlert('def-456')]
    const result = filterAlertItems(alerts, 'abc')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('abc-123')
  })

  it('filters by prompt substring', () => {
    const alerts = [
      makeAlert('t1', { prompt: 'fix the login bug' }),
      makeAlert('t2', { prompt: 'update README' }),
    ]
    expect(filterAlertItems(alerts, 'login')).toHaveLength(1)
    expect(filterAlertItems(alerts, 'login')[0].id).toBe('t1')
  })

  it('filters by status substring', () => {
    const alerts = [
      makeAlert('t1', { status: 'running' }),
      makeAlert('t2', { status: 'done' }),
    ]
    expect(filterAlertItems(alerts, 'running')).toHaveLength(1)
  })

  it('filters by error substring', () => {
    const alerts = [
      makeAlert('t1', { error: 'ENOMEM: out of memory' }),
      makeAlert('t2', { error: null }),
    ]
    expect(filterAlertItems(alerts, 'enomem')).toHaveLength(1)
  })

  it('match is case-insensitive', () => {
    const alerts = [makeAlert('ABC-123'), makeAlert('def-456')]
    expect(filterAlertItems(alerts, 'abc')).toHaveLength(1)
    expect(filterAlertItems(alerts, 'ABC')).toHaveLength(1)
  })

  it('empty query returns all items unchanged', () => {
    const alerts = [makeAlert('a'), makeAlert('b')]
    expect(filterAlertItems(alerts, '')).toHaveLength(2)
    expect(filterAlertItems(alerts, '   ')).toHaveLength(2)
  })

  it('typing "stale" keeps all alerts (kind token)', () => {
    const alerts = [makeAlert('t1'), makeAlert('t2'), makeAlert('t3')]
    expect(filterAlertItems(alerts, 'stale')).toHaveLength(3)
  })

  it('typing "alert" keeps all alerts (kind token)', () => {
    const alerts = [makeAlert('t1'), makeAlert('t2')]
    expect(filterAlertItems(alerts, 'alert')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// filterIdeaItems
// ---------------------------------------------------------------------------

describe('filterIdeaItems', () => {
  it('filters Proposals by goal substring', () => {
    const ideas = [
      makeIdea('d1', { goal: 'add search feature' }),
      makeIdea('d2', { goal: 'fix bug' }),
    ]
    const result = filterIdeaItems(ideas, 'search')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('d1')
  })

  it('filters Proposals by story substring', () => {
    const ideas = [
      makeIdea('d1', { story: 'as a power user I want search' }),
      makeIdea('d2', { story: 'basic requirement' }),
    ]
    expect(filterIdeaItems(ideas, 'power user')).toHaveLength(1)
  })

  it('filters by technical substring', () => {
    const ideas = [
      makeIdea('d1', { technical: 'use websockets' }),
      makeIdea('d2', { technical: 'use polling' }),
    ]
    expect(filterIdeaItems(ideas, 'websocket')).toHaveLength(1)
  })

  it('filters by id substring', () => {
    const ideas = [makeIdea('idea-alpha-1'), makeIdea('idea-beta-2')]
    expect(filterIdeaItems(ideas, 'alpha')).toHaveLength(1)
  })

  it('empty query returns all items unchanged', () => {
    const ideas = [makeIdea('d1'), makeIdea('d2')]
    expect(filterIdeaItems(ideas, '')).toHaveLength(2)
    expect(filterIdeaItems(ideas, '   ')).toHaveLength(2)
  })

  it('typing "draft" keeps all proposals (kind token)', () => {
    const ideas = [makeIdea('d1'), makeIdea('d2'), makeIdea('d3')]
    expect(filterIdeaItems(ideas, 'draft')).toHaveLength(3)
  })

  it('typing "proposal" keeps all proposals (kind token)', () => {
    const ideas = [makeIdea('d1'), makeIdea('d2')]
    expect(filterIdeaItems(ideas, 'proposal')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Cross-kind filtering (the "stale" vs "draft" discriminator tests)
// ---------------------------------------------------------------------------

describe('cross-kind filter', () => {
  it('typing "stale" keeps only alerts and zeroes proposals', () => {
    const alerts = [makeAlert('t1'), makeAlert('t2')]
    const ideas = [makeIdea('d1'), makeIdea('d2')]
    expect(filterAlertItems(alerts, 'stale')).toHaveLength(2)
    expect(filterIdeaItems(ideas, 'stale')).toHaveLength(0)
  })

  it('typing "draft" keeps only proposals and zeroes alerts', () => {
    const alerts = [makeAlert('t1'), makeAlert('t2')]
    const ideas = [makeIdea('d1'), makeIdea('d2')]
    expect(filterAlertItems(alerts, 'draft')).toHaveLength(0)
    expect(filterIdeaItems(ideas, 'draft')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// deriveSelectedKey
// ---------------------------------------------------------------------------

describe('deriveSelectedKey', () => {
  const a1 = makeAlert('t1')
  const a2 = makeAlert('t2')
  const d1 = makeIdea('d1')

  it('keeps the current key when it is present in the filtered list', () => {
    const key = itemKey(a1)
    expect(deriveSelectedKey([a1, a2], key)).toBe(key)
  })

  it('auto-selects first item when the current key is filtered out', () => {
    // a1 was selected, but the filter removed it — a2 is now first
    const result = deriveSelectedKey([a2, d1], itemKey(a1))
    expect(result).toBe(itemKey(a2))
  })

  it('returns null when the filtered list is empty (all filtered out)', () => {
    expect(deriveSelectedKey([], itemKey(a1))).toBeNull()
  })

  it('returns null when the filtered list is empty and current key is null', () => {
    expect(deriveSelectedKey([], null)).toBeNull()
  })

  it('auto-selects first item when current key is null', () => {
    expect(deriveSelectedKey([a1, a2], null)).toBe(itemKey(a1))
  })

  it('handles mixed alert+idea filtered list', () => {
    // Only d1 remains after filter; d1 should be selected
    expect(deriveSelectedKey([d1], itemKey(a2))).toBe(itemKey(d1))
  })
})
