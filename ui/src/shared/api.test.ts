/**
 * Tests for the api.ts query-function layer.
 *
 * These verify the fetch → schema-validation → typed-result pipeline that
 * every useQuery / useMutation call in the UI depends on.  fetch is mocked
 * at the system boundary; everything else is real code.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Mock } from 'bun:test'
import { fetchActionQueue, fetchAgents, fetchProgress, fetchTasks, fetchTodo } from './api'

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
  title: 'ship it',
  problem: '',
  solution: '',
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

// ---------------------------------------------------------------------------
// fetchProgress
// ---------------------------------------------------------------------------

const minProgressTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  prompt: 'do something',
  status: 'running',
  cluster: 'In progress',
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

describe('fetchProgress', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('calls /api/progress without a query string when no failedWindowMs is given', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).not.toContain('failedWindow')
  })

  it('appends ?failedWindow=<ms> when a numeric failedWindowMs is given', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress(3_600_000)
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('failedWindow=3600000')
  })

  it('appends ?failedWindow=all when failedWindowMs is null', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress(null)
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('failedWindow=all')
  })

  it('returns typed tasks and proposals on a valid response', async () => {
    fetchSpy.mockResolvedValue(
      json({ tasks: [minProgressTask()], proposals: [] }),
    )
    const result = await fetchProgress()
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].cluster).toBe('In progress')
    expect(result.proposals).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// fetchActionQueue
// ---------------------------------------------------------------------------

const minActionQueueItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'aq-1',
  kind: 'failed-task',
  entityId: 'task-1',
  priority: 'normal',
  title: 'Task failed',
  body: 'Something went wrong',
  at: new Date().toISOString(),
  dag: null,
  dismissed: false,
  ackState: null,
  errorKind: 'generic',
  actions: [],
  staleWorktreeDetail: null,
  ...overrides,
})

describe('fetchActionQueue', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns a typed ActionQueueItem array on a valid response', async () => {
    fetchSpy.mockResolvedValue(json([minActionQueueItem()]))
    const result = await fetchActionQueue()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('aq-1')
    expect(result[0].kind).toBe('failed-task')
  })

  it('parses a failed-task row with staleWorktreeDetail absent (undefined) without error', async () => {
    // Omit the key entirely — simulates an older server build or a non-stale row
    const rowWithoutKey = minActionQueueItem()
    delete (rowWithoutKey as Record<string, unknown>)['staleWorktreeDetail']

    fetchSpy.mockResolvedValue(json([rowWithoutKey]))
    const result = await fetchActionQueue()
    expect(result).toHaveLength(1)
    // The field resolves to undefined (not null) when the key is absent
    expect(result[0].staleWorktreeDetail).toBeUndefined()
  })

  it('parses a row with staleWorktreeDetail null without error', async () => {
    fetchSpy.mockResolvedValue(json([minActionQueueItem({ staleWorktreeDetail: null })]))
    const result = await fetchActionQueue()
    expect(result[0].staleWorktreeDetail).toBeNull()
  })

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'not found' }, 500))
    await expect(fetchActionQueue()).rejects.toThrow('500')
  })
})
