/**
 * resolveThreadForItem — observable behaviour contract.
 *
 * Three paths:
 *  1. An Alert exists for the arc → arc-keyed thread returned directly.
 *  2. No Alert (arc not wholly terminal, common for 'failed' rows) → 404 is
 *     swallowed and the per-row queue-item path is used instead.
 *  3. A non-404 error from the alert path → propagated to the caller.
 *
 * Regression guard: a 'failed' row whose arc has done/blocked/failed siblings
 * used to throw `POST /api/alerts/… → 404`, rendering a raw HTTP error to the
 * operator. Now it must resolve a thread id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks — hoisted so vi.mock factory runs before import resolution.
// ---------------------------------------------------------------------------

const mockStartThreadFromAlert = vi.hoisted(() => vi.fn())
const mockStartThreadForQueueItem = vi.hoisted(() => vi.fn())

vi.mock('@/entities/alerts/api', () => ({
  startThreadFromAlert: (...args: unknown[]) => mockStartThreadFromAlert(...args),
}))

vi.mock('@/shared/api', () => ({
  startThreadForQueueItem: (...args: unknown[]) => mockStartThreadForQueueItem(...args),
  // invokeAction is imported by alertVerbs.ts; stub it so the module loads cleanly.
  invokeAction: vi.fn(),
}))

// QueueThreadDetail is a React component module — stub the one export alertVerbs
// needs so we avoid loading the full component tree in a unit test.
vi.mock('./QueueThreadDetail', () => ({
  PROCESS_LEVEL_OPS: new Set(['restart-daemon']),
}))

// queueItemSeed is a pure helper — let the real implementation run.

// Import the unit under test AFTER mocks are registered.
import { resolveThreadForItem } from './alertVerbs'

// ---------------------------------------------------------------------------
// Minimal ChatThread stub (startThreadForQueueItem return shape).
// ---------------------------------------------------------------------------

const makeThread = (id: string) => ({
  id,
  title: 'thread',
  createdAt: 0,
  updatedAt: 0,
  projectId: null,
  isArchived: false,
  lastMessageAt: null,
  messageCount: 0,
  taskIds: [],
  isFork: false,
  parentThreadId: null,
  forkMessageSeq: null,
})

// ---------------------------------------------------------------------------
// Minimal ActionQueueItem fixtures
// ---------------------------------------------------------------------------

const baseItem = {
  id: 'aq-abc',
  entityId: 'mars-b1aba863',
  priority: 'high',
  title: 'Task ran out of retries',
  body: '',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  actions: [],
  verbs: [],
  decisions: [],
  humanSummary: 'The task ran out of retries',
} as const

const failedItem: ActionQueueItem = {
  ...baseItem,
  kind: 'failed',
} as unknown as ActionQueueItem

const arcFailedItem: ActionQueueItem = {
  ...baseItem,
  kind: 'arc-failed',
} as unknown as ActionQueueItem

const gateItem: ActionQueueItem = {
  ...baseItem,
  kind: 'gate-broken',
} as unknown as ActionQueueItem

// Minimal QueryClient stub — only invalidateQueries is called by the unit.
const mockQc = { invalidateQueries: vi.fn() }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveThreadForItem – failed row (regression: arc not wholly terminal)', () => {
  it('returns the per-row thread id when the alert endpoint returns 404', async () => {
    // This is the scenario that previously threw a raw HTTP error to the operator:
    // the arc has done + blocked siblings so no Alert exists.
    mockStartThreadFromAlert.mockRejectedValue(
      new Error('POST /api/alerts/mars-b1aba863/thread → 404'),
    )
    mockStartThreadForQueueItem.mockResolvedValue(makeThread('queue-thread-1'))

    const result = await resolveThreadForItem(failedItem, undefined, mockQc as any)

    expect(result).toBe('queue-thread-1')
    expect(mockStartThreadFromAlert).toHaveBeenCalledOnce()
    expect(mockStartThreadForQueueItem).toHaveBeenCalledWith(
      'aq-abc',
      expect.any(String),
      expect.any(String),
      undefined,
    )
  })

  it('returns the arc thread id when the alert exists', async () => {
    mockStartThreadFromAlert.mockResolvedValue({ threadId: 'arc-thread-1' })

    const result = await resolveThreadForItem(failedItem, undefined, mockQc as any)

    expect(result).toBe('arc-thread-1')
    expect(mockStartThreadForQueueItem).not.toHaveBeenCalled()
  })

  it('re-throws non-404 errors from the alert path', async () => {
    mockStartThreadFromAlert.mockRejectedValue(
      new Error('POST /api/alerts/mars-b1aba863/thread → 500'),
    )

    await expect(resolveThreadForItem(failedItem, undefined, mockQc as any)).rejects.toThrow(
      '→ 500',
    )
    expect(mockStartThreadForQueueItem).not.toHaveBeenCalled()
  })
})

describe('resolveThreadForItem – arc-failed row (Bell / Alert surface)', () => {
  it('returns the arc thread id when the alert exists', async () => {
    mockStartThreadFromAlert.mockResolvedValue({ threadId: 'arc-thread-2' })

    const result = await resolveThreadForItem(arcFailedItem, undefined, mockQc as any)

    expect(result).toBe('arc-thread-2')
    expect(mockStartThreadForQueueItem).not.toHaveBeenCalled()
  })

  it('falls back to per-row thread on 404', async () => {
    mockStartThreadFromAlert.mockRejectedValue(
      new Error('POST /api/alerts/mars-b1aba863/thread → 404'),
    )
    mockStartThreadForQueueItem.mockResolvedValue(makeThread('queue-thread-2'))

    const result = await resolveThreadForItem(arcFailedItem, undefined, mockQc as any)

    expect(result).toBe('queue-thread-2')
  })
})

describe('resolveThreadForItem – non-failure kinds', () => {
  it('goes directly through the queue-item path without touching the alert API', async () => {
    mockStartThreadForQueueItem.mockResolvedValue(makeThread('queue-thread-3'))

    const result = await resolveThreadForItem(gateItem, undefined, mockQc as any)

    expect(result).toBe('queue-thread-3')
    expect(mockStartThreadFromAlert).not.toHaveBeenCalled()
  })

  it('passes projectId through to startThreadForQueueItem', async () => {
    mockStartThreadForQueueItem.mockResolvedValue(makeThread('queue-thread-4'))

    await resolveThreadForItem(gateItem, 'proj-1', mockQc as any)

    expect(mockStartThreadForQueueItem).toHaveBeenCalledWith(
      'aq-abc',
      expect.any(String),
      expect.any(String),
      'proj-1',
    )
  })
})
