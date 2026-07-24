/**
 * Unit tests for the chat sidebar thread helpers: draft-row headline,
 * thread title search, and resolved-selection detection.
 */
import { describe, expect, it } from 'bun:test'
import {
  draftRowHeadline,
  filterThreadsByTitle,
  isResolvedSelection,
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
