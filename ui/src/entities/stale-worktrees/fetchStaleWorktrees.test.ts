/**
 * Tests for fetchStaleWorktrees — the fetcher that returns the staleWorktrees
 * slice of the /api/todo payload.  fetch is mocked at the system boundary;
 * everything else is real code.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Mock } from 'bun:test'
import { fetchStaleWorktrees } from './fetchStaleWorktrees'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

const minStaleWorktree = (overrides: Record<string, unknown> = {}) => ({
  taskId: 'wt-1',
  status: 'done',
  ageHours: 48,
  updatedAt: new Date().toISOString(),
  prompt: 'old task',
  error: null,
  branch: 'task/wt-1',
  blockerTaskId: null,
  ...overrides,
})

const minDraft = () => ({
  id: 'proposal-1',
  title: 'ship it',
  problem: '',
  solution: '',
  status: 'draft',
  source: 'human',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  acceptanceCount: 0,
})

const todoPayload = (
  overrides: Partial<{ drafts: unknown[]; staleWorktrees: unknown[] }> = {},
) => ({
  drafts: [],
  staleWorktrees: [],
  ...overrides,
})

// ---------------------------------------------------------------------------
// fetchStaleWorktrees
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
describe('fetchStaleWorktrees', () => {
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns only the staleWorktrees slice of the todo payload', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload({ staleWorktrees: [minStaleWorktree()] })))
    const result = await fetchStaleWorktrees()
    expect(result).toHaveLength(1)
    expect(result[0].taskId).toBe('wt-1')
    expect(result[0].ageHours).toBe(48)
  })

  it('returns an empty array when no stale worktrees are present', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    const result = await fetchStaleWorktrees()
    expect(result).toEqual([])
  })

  it('does not include drafts in the returned array', async () => {
    fetchSpy.mockResolvedValue(
      json(todoPayload({ drafts: [minDraft()] })),
    )
    const result = await fetchStaleWorktrees()
    expect(result).toEqual([])
  })

  it('hits the /api/todo endpoint', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchStaleWorktrees()
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('/api/todo')
  })

  it('appends ?project=<id> when a projectId is provided', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchStaleWorktrees('proj-456')
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('project=proj-456')
  })

  it('does not append a project param when projectId is undefined', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchStaleWorktrees()
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).not.toContain('project=')
  })

  it('propagates fetch errors from the underlying fetchTodo call', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(fetchStaleWorktrees()).rejects.toThrow('cannot reach the mars-ui API server')
  })
})
