/**
 * Tests for the api.ts query-function layer.
 *
 * These verify the fetch → schema-validation → typed-result pipeline that
 * every useQuery / useMutation call in the UI depends on.  fetch is mocked
 * at the system boundary; everything else is real code.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Mock } from 'bun:test'
import { fetchAgents, fetchInbox, fetchTasks, fetchTodo } from './api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

const plainText = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  })

const minTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  prompt: 'do something',
  status: 'queued',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
})

const minAgent = (overrides: Record<string, unknown> = {}) => ({
  name: 'Coder',
  model: 'claude-sonnet-4-6',
  effort: null,
  permissionMode: null,
  allowedTools: [],
  deniedTools: [],
  messageCap: null,
  role: 'worker',
  ...overrides,
})

const minDraft = (overrides: Record<string, unknown> = {}) => ({
  id: 'idea-1',
  goal: 'ship it',
  story: '',
  technical: '',
  status: 'draft',
  source: 'human',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  acceptanceCount: 0,
  ...overrides,
})

// ---------------------------------------------------------------------------
// fetchTasks
// ---------------------------------------------------------------------------

describe('fetchTasks', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns a typed Task array on a valid response', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [minTask()] }))
    const result = await fetchTasks()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('task-1')
    expect(result[0].status).toBe('queued')
  })

  it('returns an empty array when the server sends an empty task list', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [] }))
    const result = await fetchTasks()
    expect(result).toEqual([])
  })

  it('throws on a non-OK HTTP status', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'DB down' }, 500))
    await expect(fetchTasks()).rejects.toThrow('500')
  })

  it('throws when the server returns non-JSON content', async () => {
    fetchSpy.mockResolvedValue(plainText('not json'))
    await expect(fetchTasks()).rejects.toThrow('expected JSON but got text/plain')
  })

  it('throws when the response body does not match the expected schema', async () => {
    // Missing the `tasks` wrapper key
    fetchSpy.mockResolvedValue(json([minTask()]))
    await expect(fetchTasks()).rejects.toThrow('schema validation')
  })

  it('throws when a task has an unknown status value', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [minTask({ status: 'flying' })] }))
    await expect(fetchTasks()).rejects.toThrow('schema validation')
  })

  it('throws a descriptive server-not-running message on connection refused (TypeError)', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(fetchTasks()).rejects.toThrow('cannot reach the mars-ui API server')
  })

  it('re-throws non-TypeError network errors unchanged', async () => {
    const cause = new Error('unexpected network error')
    fetchSpy.mockRejectedValue(cause)
    await expect(fetchTasks()).rejects.toThrow('unexpected network error')
  })
})

// ---------------------------------------------------------------------------
// fetchAgents
// ---------------------------------------------------------------------------

describe('fetchAgents', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns a typed Agent array on a valid response', async () => {
    fetchSpy.mockResolvedValue(json({ agents: [minAgent()] }))
    const result = await fetchAgents()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Coder')
    expect(result[0].model).toBe('claude-sonnet-4-6')
  })

  it('returns an empty array when no agents are configured', async () => {
    fetchSpy.mockResolvedValue(json({ agents: [] }))
    const result = await fetchAgents()
    expect(result).toEqual([])
  })

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'not found' }, 404))
    await expect(fetchAgents()).rejects.toThrow('404')
  })

  it('throws when agent entry is missing required fields', async () => {
    fetchSpy.mockResolvedValue(json({ agents: [{ name: 'Coder' }] }))
    await expect(fetchAgents()).rejects.toThrow('schema validation')
  })
})

// ---------------------------------------------------------------------------
// fetchInbox
// ---------------------------------------------------------------------------

describe('fetchInbox', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns typed inbox payload on a valid response', async () => {
    const payload = { drafts: [minDraft()], blocked: [], failed: [] }
    fetchSpy.mockResolvedValue(json(payload))
    const result = await fetchInbox()
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0].id).toBe('idea-1')
    expect(result.blocked).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('returns an empty inbox when all groups are empty', async () => {
    fetchSpy.mockResolvedValue(json({ drafts: [], blocked: [], failed: [] }))
    const result = await fetchInbox()
    expect(result.drafts).toEqual([])
    expect(result.blocked).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('throws when the inbox payload is missing a required group', async () => {
    // `failed` group absent — schema should reject this
    fetchSpy.mockResolvedValue(json({ drafts: [], blocked: [] }))
    await expect(fetchInbox()).rejects.toThrow('schema validation')
  })
})

// ---------------------------------------------------------------------------
// fetchTodo
// ---------------------------------------------------------------------------

describe('fetchTodo', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns typed todo payload with drafts and stale worktrees', async () => {
    const payload = {
      drafts: [minDraft()],
      staleWorktrees: [
        {
          taskId: 'wt-1',
          status: 'done',
          ageHours: 48,
          updatedAt: new Date().toISOString(),
          prompt: 'old task',
          error: null,
          branch: 'task/wt-1',
          blockerTaskId: null,
        },
      ],
    }
    fetchSpy.mockResolvedValue(json(payload))
    const result = await fetchTodo()
    expect(result.drafts).toHaveLength(1)
    expect(result.staleWorktrees).toHaveLength(1)
    expect(result.staleWorktrees[0].taskId).toBe('wt-1')
  })

  it('returns empty collections when nothing is pending', async () => {
    fetchSpy.mockResolvedValue(json({ drafts: [], staleWorktrees: [] }))
    const result = await fetchTodo()
    expect(result.drafts).toEqual([])
    expect(result.staleWorktrees).toEqual([])
  })

  it('throws when staleWorktrees key is absent', async () => {
    fetchSpy.mockResolvedValue(json({ drafts: [] }))
    await expect(fetchTodo()).rejects.toThrow('schema validation')
  })
})
