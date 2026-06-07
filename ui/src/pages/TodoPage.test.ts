/**
 * Unit tests for the ActionQueuePage actionQueue sidebar search / filter behaviour.
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
  filterProposalItems,
  itemKey,
  type AlertItem,
  type ProposalItem,
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

const makeProposal = (
  id: string,
  overrides: Partial<ProposalItem['draft']> = {},
): ProposalItem => ({
  kind: 'draft',
  id,
  draft: {
    id,
    title: 'ship the feature',
    problem: 'as a user, I want this done',
    solution: 'implement with hooks',
    status: 'draft',
    source: 'human',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acceptanceCount: 0,
    userStories: [],
    ...overrides,
  } as ProposalItem['draft'],
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
// filterProposalItems
// ---------------------------------------------------------------------------

describe('filterProposalItems', () => {
  it('filters Proposals by title substring', () => {
    const proposals = [
      makeProposal('d1', { title: 'add search feature' }),
      makeProposal('d2', { title: 'fix bug' }),
    ]
    const result = filterProposalItems(proposals, 'search')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('d1')
  })

  it('filters Proposals by problem substring', () => {
    const proposals = [
      makeProposal('d1', { problem: 'as a power user I want search' }),
      makeProposal('d2', { problem: 'basic requirement' }),
    ]
    expect(filterProposalItems(proposals, 'power user')).toHaveLength(1)
  })

  it('filters by solution substring', () => {
    const proposals = [
      makeProposal('d1', { solution: 'use websockets' }),
      makeProposal('d2', { solution: 'use polling' }),
    ]
    expect(filterProposalItems(proposals, 'websocket')).toHaveLength(1)
  })

  it('filters by id substring', () => {
    const proposals = [makeProposal('proposal-alpha-1'), makeProposal('proposal-beta-2')]
    expect(filterProposalItems(proposals, 'alpha')).toHaveLength(1)
  })

  it('empty query returns all items unchanged', () => {
    const proposals = [makeProposal('d1'), makeProposal('d2')]
    expect(filterProposalItems(proposals, '')).toHaveLength(2)
    expect(filterProposalItems(proposals, '   ')).toHaveLength(2)
  })

  it('typing "draft" keeps all proposals (kind token)', () => {
    const proposals = [makeProposal('d1'), makeProposal('d2'), makeProposal('d3')]
    expect(filterProposalItems(proposals, 'draft')).toHaveLength(3)
  })

  it('typing "proposal" keeps all proposals (kind token)', () => {
    const proposals = [makeProposal('d1'), makeProposal('d2')]
    expect(filterProposalItems(proposals, 'proposal')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Cross-kind filtering (the "stale" vs "draft" discriminator tests)
// ---------------------------------------------------------------------------

describe('cross-kind filter', () => {
  it('typing "stale" keeps only alerts and zeroes proposals', () => {
    const alerts = [makeAlert('t1'), makeAlert('t2')]
    const proposals = [makeProposal('d1'), makeProposal('d2')]
    expect(filterAlertItems(alerts, 'stale')).toHaveLength(2)
    expect(filterProposalItems(proposals, 'stale')).toHaveLength(0)
  })

  it('typing "draft" keeps only proposals and zeroes alerts', () => {
    const alerts = [makeAlert('t1'), makeAlert('t2')]
    const proposals = [makeProposal('d1'), makeProposal('d2')]
    expect(filterAlertItems(alerts, 'draft')).toHaveLength(0)
    expect(filterProposalItems(proposals, 'draft')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// deriveSelectedKey
// ---------------------------------------------------------------------------

describe('deriveSelectedKey', () => {
  const a1 = makeAlert('t1')
  const a2 = makeAlert('t2')
  const d1 = makeProposal('d1')

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

  it('handles mixed alert+proposal filtered list', () => {
    // Only d1 remains after filter; d1 should be selected
    expect(deriveSelectedKey([d1], itemKey(a2))).toBe(itemKey(d1))
  })
})
