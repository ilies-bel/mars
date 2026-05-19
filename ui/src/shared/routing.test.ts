import { describe, expect, it } from 'bun:test'
import { detectRoute, actionQueueCount, parseTaskRoute } from './routing'
import type { TodoPayload } from './schemas'

const emptyTodo = (): TodoPayload => ({ drafts: [], staleWorktrees: [] })

const withDrafts = (n: number): TodoPayload => ({
  drafts: Array.from({ length: n }, (_, i) => ({
    id: `idea-${i}`,
    goal: `goal ${i}`,
    story: '',
    technical: '',
    status: 'draft',
    source: 'human' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acceptanceCount: 0,
  })),
  staleWorktrees: [],
})

const withStale = (n: number): TodoPayload => ({
  drafts: [],
  staleWorktrees: Array.from({ length: n }, (_, i) => ({
    taskId: `wt-${i}`,
    status: 'done',
    ageHours: 48,
    updatedAt: new Date().toISOString(),
    prompt: `stale task ${i}`,
    error: null,
    branch: null,
    blockerTaskId: null,
  })),
})

// ---------------------------------------------------------------------------
// detectRoute
// ---------------------------------------------------------------------------

describe('detectRoute', () => {
  it('returns action-queue for an empty or root hash', () => {
    expect(detectRoute('')).toBe('action-queue')
    expect(detectRoute('#/')).toBe('action-queue')
  })

  it('returns action-queue for the legacy #/todo hash', () => {
    expect(detectRoute('#/todo')).toBe('action-queue')
  })

  it('returns action-queue for the #/action-queue hash', () => {
    expect(detectRoute('#/action-queue')).toBe('action-queue')
    expect(detectRoute('#/action-queue/sub')).toBe('action-queue')
  })

  it('returns progress for the #/progress hash', () => {
    expect(detectRoute('#/progress')).toBe('progress')
    expect(detectRoute('#/progress/anything')).toBe('progress')
  })

  it('does not recognise the legacy #/kanban hash', () => {
    // Hard cut — no alias, no redirect. The legacy hash falls through to the
    // default route.
    expect(detectRoute('#/kanban')).toBe('action-queue')
  })

  it('returns agents for the #/agents hash', () => {
    expect(detectRoute('#/agents')).toBe('agents')
    expect(detectRoute('#/agents/coder')).toBe('agents')
  })

  it('returns topology for the #/topology hash', () => {
    expect(detectRoute('#/topology')).toBe('topology')
    expect(detectRoute('#/topology/anything')).toBe('topology')
  })
})

// ---------------------------------------------------------------------------
// actionQueueCount — only counts stale worktrees
// ---------------------------------------------------------------------------

describe('actionQueueCount', () => {
  it('returns 0 when there are no stale worktrees', () => {
    expect(actionQueueCount(emptyTodo())).toBe(0)
  })

  it('returns the number of stale worktrees regardless of drafts', () => {
    const todo = { ...withStale(3), drafts: withDrafts(5).drafts }
    expect(actionQueueCount(todo)).toBe(3)
  })

  it('does not count drafts toward the action-queue badge', () => {
    expect(actionQueueCount(withDrafts(10))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseTaskRoute
// ---------------------------------------------------------------------------

describe('parseTaskRoute', () => {
  it('returns null when the hash has no task fragment', () => {
    expect(parseTaskRoute('')).toBeNull()
    expect(parseTaskRoute('#/')).toBeNull()
    expect(parseTaskRoute('#/progress')).toBeNull()
  })

  it('returns the id from #/task/<id>', () => {
    expect(parseTaskRoute('#/task/abc-123')).toBe('abc-123')
  })

  it('strips trailing slash and treats empty id as null', () => {
    expect(parseTaskRoute('#/task/')).toBeNull()
  })

  it('decodes percent-encoded ids', () => {
    expect(parseTaskRoute('#/task/mars%2D123')).toBe('mars-123')
  })
})
