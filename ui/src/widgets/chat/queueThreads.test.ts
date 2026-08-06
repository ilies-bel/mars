/**
 * Unit tests for the chat sidebar thread helpers: draft-row headline,
 * thread title search, and resolved-selection detection.
 */
import { describe, expect, it } from 'bun:test'
import {
  draftRowHeadline,
  filterOpen,
  filterThreadsByTitle,
  isResolvedSelection,
  sortByUrgencyThenAge,
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
// filterThreadsByTitle — the chat sidebar is a plain list of threads
// ---------------------------------------------------------------------------

describe('filterThreadsByTitle', () => {
  const threads = [
    makeThread({ id: 'a', title: 'Deploy fix' }),
    makeThread({ id: 'b', title: 'Unrelated chat' }),
    makeThread({ id: 'c', title: '' }),
  ]

  it('empty query returns every thread', () => {
    expect(filterThreadsByTitle(threads, '').map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('whitespace-only query returns every thread', () => {
    expect(filterThreadsByTitle(threads, '   ').map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('matches by title substring, case-insensitively', () => {
    expect(filterThreadsByTitle(threads, 'DEPLOY').map((t) => t.id)).toEqual(['a'])
  })

  it('untitled threads match the "New thread" placeholder', () => {
    expect(filterThreadsByTitle(threads, 'new').map((t) => t.id)).toEqual(['c'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterThreadsByTitle(threads, 'nomatch')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// filterThreadsByTitle — derived title from firstUserMessage
// ---------------------------------------------------------------------------

describe('filterThreadsByTitle with firstUserMessage derived title', () => {
  const threads = [
    makeThread({ id: 'a', title: 'Deploy fix' }),
    makeThread({ id: 'b', title: '', firstUserMessage: 'what is the deploy status?' }),
    makeThread({ id: 'c', title: '' }), // no title, no firstUserMessage
  ]

  it('matches against derived title when title is empty but firstUserMessage is set', () => {
    expect(filterThreadsByTitle(threads, 'deploy status').map((t) => t.id)).toEqual(['b'])
  })

  it('matches "New thread" placeholder only for threads with no title AND no firstUserMessage', () => {
    expect(filterThreadsByTitle(threads, 'new').map((t) => t.id)).toEqual(['c'])
  })

  it('does NOT match "New thread" placeholder for threads that have a firstUserMessage', () => {
    const matched = filterThreadsByTitle(threads, 'new').map((t) => t.id)
    expect(matched).not.toContain('b')
  })

  it('matches normally titled threads by their title', () => {
    expect(filterThreadsByTitle(threads, 'Deploy fix').map((t) => t.id)).toEqual(['a'])
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

// ---------------------------------------------------------------------------
// filterOpen — evaporation of resolved projections
// ---------------------------------------------------------------------------

describe('evaporation', () => {
  it('retains a thread whose backing alert is still open', () => {
    const thread = makeThread({ id: 'open', origin: 'alert', alertItemId: 'failed-task:t-1', alertResolved: false })
    expect(filterOpen([thread]).map((t) => t.id)).toEqual(['open'])
  })

  it('drops a thread whose backing alert has been resolved', () => {
    const thread = makeThread({ id: 'gone', origin: 'alert', alertItemId: 'failed-task:t-1', alertResolved: true })
    expect(filterOpen([thread])).toHaveLength(0)
  })

  it('always retains a user-created thread with no backing alert', () => {
    const thread = makeThread({ id: 'user', origin: null, alertItemId: null, alertResolved: false })
    expect(filterOpen([thread]).map((t) => t.id)).toEqual(['user'])
  })

  it('filters a mixed list down to only open threads', () => {
    const open = makeThread({ id: 'open', origin: 'alert', alertItemId: 'failed-task:t-1', alertResolved: false })
    const resolved = makeThread({ id: 'gone', origin: 'alert', alertItemId: 'failed-task:t-2', alertResolved: true })
    const user = makeThread({ id: 'user', origin: null, alertItemId: null })
    expect(filterOpen([open, resolved, user]).map((t) => t.id)).toEqual(['open', 'user'])
  })
})

// ---------------------------------------------------------------------------
// sortByUrgencyThenAge — urgency desc → createdAt asc → id tiebreak
// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('places a ready thread before an idle thread (urgency desc)', () => {
    const idle = makeThread({ id: 'idle', attentionStatus: 'idle', createdAt: '2026-01-01T00:00:00Z' })
    const ready = makeThread({ id: 'ready', attentionStatus: 'ready', createdAt: '2026-01-02T00:00:00Z' })
    expect(sortByUrgencyThenAge([idle, ready]).map((t) => t.id)).toEqual(['ready', 'idle'])
  })

  it('places an older thread before a newer thread when urgency is equal (age asc)', () => {
    const newer = makeThread({ id: 'new', attentionStatus: 'idle', createdAt: '2026-01-02T00:00:00Z' })
    const older = makeThread({ id: 'old', attentionStatus: 'idle', createdAt: '2026-01-01T00:00:00Z' })
    expect(sortByUrgencyThenAge([newer, older]).map((t) => t.id)).toEqual(['old', 'new'])
  })

  it('uses id as tiebreaker when urgency and age are equal', () => {
    const ts = '2026-01-01T00:00:00Z'
    const b = makeThread({ id: 'th-b', attentionStatus: 'idle', createdAt: ts })
    const a = makeThread({ id: 'th-a', attentionStatus: 'idle', createdAt: ts })
    expect(sortByUrgencyThenAge([b, a]).map((t) => t.id)).toEqual(['th-a', 'th-b'])
  })

  it('sorts a mixed list by urgency then age then id', () => {
    const idleNew = makeThread({ id: 'idle-new', attentionStatus: 'idle', createdAt: '2026-01-03T00:00:00Z' })
    const idleOld = makeThread({ id: 'idle-old', attentionStatus: 'idle', createdAt: '2026-01-01T00:00:00Z' })
    const readyNew = makeThread({ id: 'ready-new', attentionStatus: 'ready', createdAt: '2026-01-02T00:00:00Z' })
    const readyOld = makeThread({ id: 'ready-old', attentionStatus: 'ready', createdAt: '2026-01-01T00:00:00Z' })
    expect(
      sortByUrgencyThenAge([idleNew, readyNew, idleOld, readyOld]).map((t) => t.id),
    ).toEqual(['ready-old', 'ready-new', 'idle-old', 'idle-new'])
  })

  it('does not mutate the original array', () => {
    const ts = '2026-01-01T00:00:00Z'
    const threads = [
      makeThread({ id: 'b', attentionStatus: 'idle', createdAt: ts }),
      makeThread({ id: 'a', attentionStatus: 'ready', createdAt: ts }),
    ]
    const original = threads.map((t) => t.id)
    sortByUrgencyThenAge(threads)
    expect(threads.map((t) => t.id)).toEqual(original)
  })
})
