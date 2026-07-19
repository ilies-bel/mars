/**
 * Unit tests for the ActionQueuePage actionQueue sidebar search / filter behaviour,
 * and URL state encoding/decoding for persistent selection + filters.
 *
 * All tests operate through public, pure APIs — no React rendering needed.
 * This file is excluded from the main tsc project (see tsconfig.json `exclude`)
 * so it uses `bun:test` directly, like the other test files in src/shared/.
 */
import { describe, expect, it } from 'bun:test'
import {
  deriveSelectedKey,
  filterAlertItems,
  filterProposalItems,
  historyLabel,
  itemKey,
  whyNowText,
  type AlertItem,
  type ProposalItem,
} from './ActionQueuePageFilters'
import type { ActionQueueItem } from '../shared/schemas'
import {
  decodeAqState,
  defaultAqUrlState,
  encodeAqState,
} from '../shared/actionQueueUrlState'
import { taskHash, parseTaskRoute, parseTaskOrigin } from '../shared/routing'

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

// ---------------------------------------------------------------------------
// actionQueueUrlState — encode / decode round-trips
// ---------------------------------------------------------------------------

describe('encodeAqState / decodeAqState round-trip', () => {
  it('all-default state encodes to empty string', () => {
    const encoded = encodeAqState(defaultAqUrlState())
    expect(encoded).toBe('')
  })

  it('item is preserved through encode + decode', () => {
    const encoded = encodeAqState({ item: 'failed-task:t-1', kind: 'all', q: '' })
    const decoded = decodeAqState(`#/action-queue${encoded}`)
    expect(decoded.item).toBe('failed-task:t-1')
    expect(decoded.kind).toBe('all')
    expect(decoded.q).toBe('')
  })

  it('kind=alerts is preserved', () => {
    const encoded = encodeAqState({ item: null, kind: 'alerts', q: '' })
    const decoded = decodeAqState(`#/action-queue${encoded}`)
    expect(decoded.kind).toBe('alerts')
    expect(decoded.item).toBeNull()
  })

  it('kind=drafts is preserved', () => {
    const encoded = encodeAqState({ item: null, kind: 'drafts', q: '' })
    const decoded = decodeAqState(`#/action-queue${encoded}`)
    expect(decoded.kind).toBe('drafts')
  })

  it('search query is preserved', () => {
    const encoded = encodeAqState({ item: null, kind: 'all', q: 'deploy fix' })
    const decoded = decodeAqState(`#/action-queue${encoded}`)
    expect(decoded.q).toBe('deploy fix')
  })

  it('all three params together round-trip correctly', () => {
    const state = { item: 'failed-task:mars-abc', kind: 'alerts' as const, q: 'merge' }
    const encoded = encodeAqState(state)
    const decoded = decodeAqState(`#/action-queue${encoded}`)
    expect(decoded.item).toBe('failed-task:mars-abc')
    expect(decoded.kind).toBe('alerts')
    expect(decoded.q).toBe('merge')
  })

  it('default kind is omitted from URL to keep it clean', () => {
    const encoded = encodeAqState({ item: null, kind: 'all', q: '' })
    expect(encoded).not.toContain('kind')
  })

  it('default kind decodes correctly from a bare hash', () => {
    const decoded = decodeAqState('#/action-queue')
    expect(decoded.kind).toBe('all')
    expect(decoded.item).toBeNull()
    expect(decoded.q).toBe('')
  })

  it('unrecognised kind param falls back to all', () => {
    const decoded = decodeAqState('#/action-queue?kind=unknown')
    expect(decoded.kind).toBe('all')
  })

  it('item with colon in entityId survives encode/decode', () => {
    const state = { item: 'failed-task:some:complex:id', kind: 'all' as const, q: '' }
    const encoded = encodeAqState(state)
    const decoded = decodeAqState(`#/action-queue${encoded}`)
    expect(decoded.item).toBe('failed-task:some:complex:id')
  })
})

// ---------------------------------------------------------------------------
// onNavigateToTask fallback — origin-tree navigation for non-live AQ tasks
// ---------------------------------------------------------------------------
//
// When an origin-tree node is clicked and the task is NOT a live action-queue
// row (e.g. a "done" sibling task), ActionQueuePage falls back to opening the
// task drawer via `window.location.hash = taskHash(taskId, 'action-queue')`.
// The `from=action-queue` param tells the drawer to restore the AQ view on Esc.
//
// These tests verify the hash contract that the fallback relies on.

describe('origin navigation fallback hash contract', () => {
  it('produces a task-drawer hash with action-queue origin for a done sibling', () => {
    const hash = taskHash('mars-done-abc', 'action-queue')
    expect(hash).toBe('#/task/mars-done-abc?from=action-queue')
  })

  it('the fallback hash resolves to the task drawer overlay (parseTaskRoute)', () => {
    const hash = taskHash('mars-done-abc', 'action-queue')
    expect(parseTaskRoute(hash)).toBe('mars-done-abc')
  })

  it('the fallback hash encodes action-queue as origin so Esc returns to AQ', () => {
    const hash = taskHash('mars-done-abc', 'action-queue')
    expect(parseTaskOrigin(hash)).toBe('action-queue')
  })
})

// ---------------------------------------------------------------------------
// historyLabel
// ---------------------------------------------------------------------------

describe('historyLabel', () => {
  it('returns "History" when no items are loaded', () => {
    expect(historyLabel(0, false)).toBe('History')
  })

  it('returns "History" even when hasMore is true but count is zero', () => {
    expect(historyLabel(0, true)).toBe('History')
  })

  it('returns exact count when all items are loaded (no more pages)', () => {
    expect(historyLabel(30, false)).toBe('History · 30')
  })

  it('appends + when more pages are available', () => {
    expect(historyLabel(50, true)).toBe('History · 50+')
  })
})

// ---------------------------------------------------------------------------
// whyNowText — "why now" subtitle builder for failed-task cards
// ---------------------------------------------------------------------------

/** Minimal failed-task fixture — only the fields whyNowText reads. */
const failedTask = (
  overrides: Partial<{
    body: string
    diagnosis: { text: string; diagnosedAt: string } | null
    errorKind: string
    failureReasonCode: string | null
  }>,
): ActionQueueItem =>
  ({
    kind: 'failed-task',
    id: 'test-task',
    entityId: 'test-task',
    priority: 'high',
    title: 'Some failing task',
    body: '',
    at: '2026-01-01T00:00:00.000Z',
    dag: null,
    errorKind: 'failed-task',
    actions: [],
    diagnosis: null,
    failureReasonCode: null,
    fixForTaskId: null,
    resolution: null,
    devServerUrl: null,
    ...overrides,
  }) as ActionQueueItem

describe('whyNowText', () => {
  it('returns null for the generic daemon body boilerplate — the bug case', () => {
    const item = failedTask({
      body: 'A pipeline step did not complete. See the transcript for details.',
    })
    expect(whyNowText(item)).toBeNull()
  })

  it('returns a non-generic body line when no specific fields are set', () => {
    const item = failedTask({ body: 'Out of memory: killed by OOM reaper' })
    expect(whyNowText(item)).toBe('Out of memory: killed by OOM reaper')
  })

  it('returns the first line of diagnosis.text — highest priority', () => {
    const item = failedTask({
      body: 'A pipeline step did not complete. See the transcript for details.',
      diagnosis: {
        text: 'TypeScript compilation failed: Cannot find module\nSee imports above.',
        diagnosedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    expect(whyNowText(item)).toBe('TypeScript compilation failed: Cannot find module')
  })

  it('truncates diagnosis text longer than 100 chars with an ellipsis', () => {
    const long = 'x'.repeat(120)
    const item = failedTask({ diagnosis: { text: long, diagnosedAt: '2026-01-01T00:00:00.000Z' } })
    const result = whyNowText(item)
    expect(result).not.toBeNull()
    expect(result!.length).toBe(101) // 100 chars + '…'
    expect(result!.endsWith('…')).toBe(true)
  })

  it('returns null for an empty body and no other fields', () => {
    expect(whyNowText(failedTask({ body: '' }))).toBeNull()
  })

  it('uses only the first line of a multi-line body', () => {
    const item = failedTask({ body: 'Line one: specific error\nLine two: more context' })
    expect(whyNowText(item)).toBe('Line one: specific error')
  })
})
