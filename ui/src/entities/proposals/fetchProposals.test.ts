/**
 * Tests for fetchProposals — the fetcher that returns drafts (proposals)
 * from /api/proposals.  fetch is mocked at the system boundary;
 * everything else is real code.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Mock } from 'bun:test'
import { fetchProposals } from './fetchProposals'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

const minDraft = (overrides: Record<string, unknown> = {}) => ({
  id: 'proposal-1',
  title: 'ship it',
  problem: '',
  solution: '',
  status: 'draft',
  source: 'human',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  acceptanceCount: 0,
  ...overrides,
})

const minStaleWorktree = () => ({
  taskId: 'wt-1',
  status: 'done',
  ageHours: 48,
  updatedAt: new Date().toISOString(),
  prompt: 'old task',
  error: null,
  branch: 'task/wt-1',
  blockerTaskId: null,
})

const todoPayload = (
  overrides: Partial<{ drafts: unknown[]; staleWorktrees: unknown[] }> = {},
) => ({
  drafts: [],
  staleWorktrees: [],
  ...overrides,
})

// ---------------------------------------------------------------------------
// fetchProposals
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
describe('fetchProposals', () => {
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns only the drafts slice of the todo payload', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload({ drafts: [minDraft()] })))
    const result = await fetchProposals()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('proposal-1')
    expect(result[0].title).toBe('ship it')
  })

  it('returns an empty array when no drafts are present', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    const result = await fetchProposals()
    expect(result).toEqual([])
  })

  it('does not include stale worktrees in the returned array', async () => {
    fetchSpy.mockResolvedValue(
      json(todoPayload({ staleWorktrees: [minStaleWorktree()] })),
    )
    const result = await fetchProposals()
    expect(result).toEqual([])
  })

  it('hits the /api/proposals endpoint', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals()
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('/api/proposals')
  })

  it('appends ?project=<id> when a projectId is provided', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals('proj-123')
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('project=proj-123')
  })

  it('does not append a project param when projectId is undefined', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals()
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).not.toContain('project=')
  })

  it('appends ?source=<value> when opts.source is provided', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals(undefined, { source: 'reflection' })
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('source=reflection')
  })

  it('appends ?status=<value> when opts.status is provided', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals(undefined, { status: 'draft' })
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('status=draft')
  })

  it('appends ?limit=<value> when opts.limit is provided', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals(undefined, { limit: 25 })
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('limit=25')
  })

  it('appends ?cursor=<value> when opts.cursor is a non-null string', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals(undefined, { cursor: '50' })
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('cursor=50')
  })

  it('does not append cursor when opts.cursor is null', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals(undefined, { cursor: null })
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).not.toContain('cursor=')
  })

  it('combines multiple opts into a single query string', async () => {
    fetchSpy.mockResolvedValue(json(todoPayload()))
    await fetchProposals('proj-42', { source: 'reflection', status: 'draft', limit: 10 })
    const calledUrl = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('source=reflection')
    expect(calledUrl).toContain('status=draft')
    expect(calledUrl).toContain('limit=10')
    expect(calledUrl).toContain('project=proj-42')
  })

  it('propagates fetch errors from the underlying API call', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(fetchProposals()).rejects.toThrow('cannot reach the mars-ui API server')
  })
})
