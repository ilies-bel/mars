import { describe, expect, it } from 'bun:test'
import { detectRoute, actionQueueCount, proposalsCount, parseTaskRoute } from './routing'
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

  it('returns proposals for the #/proposals hash', () => {
    expect(detectRoute('#/proposals')).toBe('proposals')
    expect(detectRoute('#/proposals/idea-1')).toBe('proposals')
  })

  it('returns kanban for the #/kanban hash', () => {
    expect(detectRoute('#/kanban')).toBe('kanban')
    expect(detectRoute('#/kanban/anything')).toBe('kanban')
  })

  it('returns agents for the #/agents hash', () => {
    expect(detectRoute('#/agents')).toBe('agents')
    expect(detectRoute('#/agents/coder')).toBe('agents')
  })

  it('proposals route does not match action-queue', () => {
    expect(detectRoute('#/proposals')).not.toBe('action-queue')
  })

  it('action-queue route does not match proposals', () => {
    expect(detectRoute('#/action-queue')).not.toBe('proposals')
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
// proposalsCount — only counts drafts
// ---------------------------------------------------------------------------

describe('parseTaskRoute', () => {
  it('returns null when the hash has no task fragment', () => {
    expect(parseTaskRoute('')).toBeNull()
    expect(parseTaskRoute('#/')).toBeNull()
    expect(parseTaskRoute('#/kanban')).toBeNull()
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

describe('proposalsCount', () => {
  it('returns 0 when there are no drafts', () => {
    expect(proposalsCount(emptyTodo())).toBe(0)
  })

  it('returns the number of drafts regardless of stale worktrees', () => {
    const todo = { ...withDrafts(4), staleWorktrees: withStale(7).staleWorktrees }
    expect(proposalsCount(todo)).toBe(4)
  })

  it('does not count stale worktrees toward the proposals badge', () => {
    expect(proposalsCount(withStale(10))).toBe(0)
  })
})
