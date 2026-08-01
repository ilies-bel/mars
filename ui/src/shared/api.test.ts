/**
 * Tests for the api.ts query-function layer.
 *
 * These verify the fetch → schema-validation → typed-result pipeline that
 * every useQuery / useMutation call in the UI depends on.  fetch is mocked
 * at the system boundary; everything else is real code.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Mock } from 'bun:test'
import {
  ApiError,
  ackActionQueueItem,
  createChatThread,
  dismissActionQueueItem,
  fetchActionQueue,
  fetchChatConversation,
  fetchEvents,
  fetchOrigins,
  fetchProgress,
  fetchProjects,
  fetchTasks,
  fetchProposalsPayload,
  fetchStaleWorktreesPayload,
  resolveActionQueueItem,
  startProject,
  triggerSelfUpdate,
} from './api'

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
  priority: 2,
  blockerTaskId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
})

const minDraft = (overrides: Record<string, unknown> = {}) => ({
  id: 'proposal-1',
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

const minConversationEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 'message-1',
  seq: 1,
  threadId: 'subthread-1',
  subthreadId: 'subthread-1',
  subthreadTitle: 'A subthread',
  subthreadClosed: false,
  role: 'assistant',
  content: 'Durable narration',
  segments: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  kind: 'acknowledgment',
  backingEntityId: null,
  resolution: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// createChatThread
// ---------------------------------------------------------------------------

describe('createChatThread', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('creates a proposal-scoped thread with its title and grilling objective', async () => {
    fetchSpy.mockResolvedValue(json({
      id: 'thread-1', title: 'Grill: Improve onboarding', status: 'idle',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }))

    await createChatThread({
      projectId: 'project-1',
      title: 'Grill: Improve onboarding',
      objective: 'Grill proposal proposal-1',
      origin: 'proposal',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/chat/threads?project=project-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'Grill: Improve onboarding',
          objective: 'Grill proposal proposal-1',
          origin: 'proposal',
        }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// fetchChatConversation
// ---------------------------------------------------------------------------

describe('fetchChatConversation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns the durable scroll with the daemon-selected memory boundary', async () => {
    fetchSpy.mockResolvedValue(json({
      entries: [minConversationEntry()],
      memoryStartsAfterSeq: 42,
      memoryCutAt: 1_700_000_000_000,
      memoryCutReason: 'capacity',
    }))

    await expect(fetchChatConversation()).resolves.toMatchObject({
      entries: [expect.objectContaining({ seq: 1, content: 'Durable narration' })],
      memoryStartsAfterSeq: 42,
      memoryCutAt: 1_700_000_000_000,
      memoryCutReason: 'capacity',
    })
  })
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
    expect(result[0].priority).toBe(2)
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
// fetchProposalsPayload
// ---------------------------------------------------------------------------

describe('fetchProposalsPayload', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns ProposalsPayload with drafts from /api/proposals', async () => {
    fetchSpy.mockResolvedValue(json({ drafts: [minDraft()] }))
    const result = await fetchProposalsPayload()
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0].id).toBe('proposal-1')
  })

  it('returns empty drafts when nothing is pending', async () => {
    fetchSpy.mockResolvedValue(json({ drafts: [] }))
    const result = await fetchProposalsPayload()
    expect(result.drafts).toEqual([])
  })

  it('throws when drafts key is absent', async () => {
    fetchSpy.mockResolvedValue(json({}))
    await expect(fetchProposalsPayload()).rejects.toThrow('schema validation')
  })
})

// ---------------------------------------------------------------------------
// fetchStaleWorktreesPayload
// ---------------------------------------------------------------------------

describe('fetchStaleWorktreesPayload', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns StaleWorktreesPayload from /api/stale-worktrees', async () => {
    fetchSpy.mockResolvedValue(
      json({
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
      }),
    )
    const result = await fetchStaleWorktreesPayload()
    expect(result.staleWorktrees).toHaveLength(1)
    expect(result.staleWorktrees[0].taskId).toBe('wt-1')
  })

  it('returns empty staleWorktrees when nothing is pending', async () => {
    fetchSpy.mockResolvedValue(json({ staleWorktrees: [] }))
    const result = await fetchStaleWorktreesPayload()
    expect(result.staleWorktrees).toEqual([])
  })

  it('throws when staleWorktrees key is absent', async () => {
    fetchSpy.mockResolvedValue(json({}))
    await expect(fetchStaleWorktreesPayload()).rejects.toThrow('schema validation')
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
  priority: 2,
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

  it('calls /api/progress without a failedWindow query param', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).not.toContain('failedWindow')
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
  kind: 'failed',
  entityId: 'task-1',
  priority: 'normal',
  title: 'Task failed',
  body: 'Something went wrong',
  at: new Date().toISOString(),
  dag: null,
  errorKind: 'generic',
  actions: [],
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
    expect(result[0].kind).toBe('failed')
  })

  it('parses a failed row without staleWorktreeDetail without error', async () => {
    // Task-failure rows do not carry staleWorktreeDetail — the field belongs only
    // to the stale-worktree variant of the discriminated union and is stripped by
    // zod for all other kinds.
    fetchSpy.mockResolvedValue(json([minActionQueueItem()]))
    const result = await fetchActionQueue()
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('failed')
    // staleWorktreeDetail is not a property of task-failure variants;
      // runtime value is undefined (zod strips unknown keys by default).
      expect((result[0] as Record<string, unknown>)['staleWorktreeDetail']).toBeUndefined()
  })

  it('parses a failed row with staleWorktreeDetail null in server payload without error', async () => {
    // staleWorktreeDetail:null is stripped from a task-failure row.
    // the discriminated-union schema strips the unknown key — the row still parses.
    fetchSpy.mockResolvedValue(json([minActionQueueItem({ staleWorktreeDetail: null })]))
    const result = await fetchActionQueue()
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('failed')
  })

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'not found' }, 500))
    await expect(fetchActionQueue()).rejects.toThrow('500')
  })
})

describe('fetchEvents', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('passes taskId + limit as query params and parses the response', async () => {
    fetchSpy.mockResolvedValue(
      json({
        events: [
          {
            id: 'e1',
            timestamp: new Date().toISOString(),
            kind: 'task_failed',
            severity: 'error',
            taskId: 't1',
            originId: null,
            phase: 'verify',
            payload: { failureReasonCode: 'verify:typecheck' },
          },
        ],
        nextCursor: 'opaque-cursor',
      }),
    )
    const r = await fetchEvents({ taskId: 't1', limit: 50 })
    expect(r.events).toHaveLength(1)
    expect(r.nextCursor).toBe('opaque-cursor')
    // The fetch call carried the expected URL.
    const url = fetchSpy.mock.calls[0]![0] as string
    expect(url).toContain('taskId=t1')
    expect(url).toContain('limit=50')
  })
})

describe('fetchOrigins', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('parses a recursive origin tree', async () => {
    fetchSpy.mockResolvedValue(
      json({
        node: {
          id: 'prop-1',
          kind: 'prd',
          title: 'big feature',
          status: 'sliced',
          children: [
            {
              id: 'task-1',
              kind: 'task',
              title: 'slice',
              status: 'failed',
              children: [],
            },
          ],
        },
      }),
    )
    const r = await fetchOrigins('task-1')
    expect(r.node.kind).toBe('prd')
    expect(r.node.children).toHaveLength(1)
    expect(r.node.children[0].id).toBe('task-1')
  })
})

// ---------------------------------------------------------------------------
// fetchProjects (GET /api/projects)
// ---------------------------------------------------------------------------

const minProject = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'proj-1',
  repoRoot: '/repos/my-project',
  name: 'My Project',
  health: 'live',
  ...overrides,
})

describe('fetchProjects', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns a typed Project array on a valid response', async () => {
    fetchSpy.mockResolvedValue(json({ projects: [minProject()] }))
    const result = await fetchProjects()
    expect(result).toHaveLength(1)
    expect(result[0].projectId).toBe('proj-1')
    expect(result[0].health).toBe('live')
  })

  it('returns an empty array when no projects are registered', async () => {
    fetchSpy.mockResolvedValue(json({ projects: [] }))
    const result = await fetchProjects()
    expect(result).toEqual([])
  })

  it('accepts all three health values', async () => {
    fetchSpy.mockResolvedValue(
      json({
        projects: [
          minProject({ projectId: 'a', health: 'live' }),
          minProject({ projectId: 'b', health: 'degraded' }),
          minProject({ projectId: 'c', health: 'down' }),
        ],
      }),
    )
    const result = await fetchProjects()
    expect(result.map((p) => p.health)).toEqual(['live', 'degraded', 'down'])
  })

  it('throws when health has an unrecognised value', async () => {
    fetchSpy.mockResolvedValue(
      json({ projects: [minProject({ health: 'unknown-status' })] }),
    )
    await expect(fetchProjects()).rejects.toThrow('schema validation')
  })

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'not found' }, 404))
    await expect(fetchProjects()).rejects.toThrow('404')
  })
})

// ---------------------------------------------------------------------------
// startProject (POST /api/projects/:id/start)
// ---------------------------------------------------------------------------

describe('startProject', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('POSTs to /api/projects/:id/start', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    await startProject('proj-abc')
    const calledUrl: string = (fetchSpy.mock.calls[0] as unknown[])[0] as string
    expect(calledUrl).toContain('/api/projects/proj-abc/start')
    const options = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit
    expect(options.method).toBe('POST')
  })

  it('URL-encodes the projectId', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    await startProject('proj with spaces')
    const calledUrl: string = (fetchSpy.mock.calls[0] as unknown[])[0] as string
    expect(calledUrl).toContain('proj%20with%20spaces')
  })

  it('throws a descriptive error on a non-2xx response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'daemon not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(startProject('proj-abc')).rejects.toThrow('404')
  })
})

// ---------------------------------------------------------------------------
// ?project= query param threading
//
// Every read fetcher must append ?project=<id> when a projectId is supplied.
// React Query keys are project-scoped in the hook layer (which passes the
// focusedProjectId straight through), so switching focus always triggers a
// new fetch for the correct project.
// ---------------------------------------------------------------------------

describe('fetchTasks – ?project= appended', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('appends ?project=<id> when a projectId is provided', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [] }))
    await fetchTasks('proj-123')
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('project=proj-123')
  })

  it('does not append a project param when projectId is undefined', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [] }))
    await fetchTasks()
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).not.toContain('project=')
  })
})

describe('fetchProgress – ?project= param', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('appends ?project=<id> when a projectId is given', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress('proj-abc')
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('project=proj-abc')
    expect(calledUrl).not.toContain('failedWindow')
  })

  it('omits ?project= when no projectId is given', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress()
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).not.toContain('project=')
  })
})

describe('fetchEvents – ?project= param added via URLSearchParams', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('includes project= in the query string when projectId is provided', async () => {
    fetchSpy.mockResolvedValue(
      json({ events: [], nextCursor: null }),
    )
    await fetchEvents({ limit: 10 }, 'proj-events')
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('project=proj-events')
    expect(calledUrl).toContain('limit=10')
  })
})

// ---------------------------------------------------------------------------
// ApiError kind classification
// ---------------------------------------------------------------------------

describe('ApiError kind — fetchTasks classifies errors correctly', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('throws ApiError kind:stale-daemon on 404 with JSON body', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'not found' }, 404))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('stale-daemon')
      expect((err as ApiError).status).toBe(404)
    }
  })

  it('throws ApiError kind:stale-daemon on 405 with JSON body', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'method not allowed' }, 405))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('stale-daemon')
      expect((err as ApiError).status).toBe(405)
    }
  })

  it('throws ApiError kind:other on 500 with JSON body', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'server error' }, 500))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('other')
      expect((err as ApiError).status).toBe(500)
    }
  })

  it('throws ApiError kind:other on 404 without JSON body (non-JSON 404)', async () => {
    fetchSpy.mockResolvedValue(plainText('Not Found', 404))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      // Non-JSON 404 is treated as 'other' — not a daemon response
      expect((err as ApiError).kind).toBe('other')
    }
  })

  it('throws ApiError kind:unreachable on connection refused (TypeError)', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('unreachable')
      expect((err as ApiError).status).toBeUndefined()
    }
  })

  it('throws ApiError kind:unreachable on 200 response with non-JSON content-type', async () => {
    fetchSpy.mockResolvedValue(plainText('<!doctype html>'))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('unreachable')
      expect((err as ApiError).status).toBeUndefined()
    }
  })

  it('ApiError carries a human-readable message in all cases', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'method not allowed' }, 405))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).message).toContain('405')
    }
  })

  it('throws ApiError kind:stale-daemon on 502 with errorCode PROXY_FAILED', async () => {
    fetchSpy.mockResolvedValue(json({ errorCode: 'PROXY_FAILED' }, 502))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('stale-daemon')
      expect((err as ApiError).status).toBe(502)
    }
  })

  it('throws ApiError kind:unreachable on 503 with errorCode NO_DAEMON', async () => {
    fetchSpy.mockResolvedValue(json({ errorCode: 'NO_DAEMON' }, 503))
    try {
      await fetchTasks()
      throw new Error('expected fetchTasks to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('unreachable')
      expect((err as ApiError).status).toBe(503)
    }
  })
})

// ---------------------------------------------------------------------------
// triggerSelfUpdate (POST /api/actions with op: self-update)
// ---------------------------------------------------------------------------

describe('triggerSelfUpdate', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('POSTs to /api/actions with op: self-update', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    await triggerSelfUpdate()
    const calledUrl: string = (fetchSpy.mock.calls[0] as unknown[])[0] as string
    expect(calledUrl).toContain('/api/actions')
    const options = (fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body as string) as { op: string }
    expect(body.op).toBe('self-update')
  })

  it('resolves when the daemon accepts the request', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    await expect(triggerSelfUpdate()).resolves.toBeUndefined()
  })

  it('throws a descriptive error on a non-2xx response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'not a prod install' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    // invokeAction surfaces the status and the server's `error` field.
    await expect(triggerSelfUpdate()).rejects.toThrow('not a prod install')
    await expect(triggerSelfUpdate()).rejects.toThrow('400')
  })
})

// ---------------------------------------------------------------------------
// Mutation wrappers — ApiError classification
//
// The server proxy returns structured errorCodes on failure:
//   503 + { errorCode: 'NO_DAEMON' }     → daemon port file missing
//   502 + { errorCode: 'PROXY_FAILED' }  → stale port / ECONNREFUSED
// The mutation wrappers must throw ApiError (not plain Error) so callers
// can render the right remedy UI.
// ---------------------------------------------------------------------------

describe('resolveActionQueueItem — ApiError classification', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('throws ApiError kind:unreachable on 503 NO_DAEMON', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: false, errorCode: 'NO_DAEMON' }, 503),
    )
    try {
      await resolveActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('unreachable')
      expect((err as ApiError).status).toBe(503)
    }
  })

  it('throws ApiError kind:stale-daemon on 502 PROXY_FAILED', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: false, errorCode: 'PROXY_FAILED' }, 502),
    )
    try {
      await resolveActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('stale-daemon')
      expect((err as ApiError).status).toBe(502)
    }
  })

  it('throws ApiError kind:other on an unknown errorCode', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: false, errorCode: 'INTERNAL_ERROR' }, 500),
    )
    try {
      await resolveActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('other')
      expect((err as ApiError).status).toBe(500)
    }
  })

  it('falls back to ApiError kind:other when the body is not JSON', async () => {
    fetchSpy.mockResolvedValue(plainText('Service Unavailable', 503))
    try {
      await resolveActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('other')
      expect((err as ApiError).status).toBe(503)
    }
  })

  it('resolves without throwing on a 200 ok response', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }))
    await expect(resolveActionQueueItem('aq-1')).resolves.toBeUndefined()
  })
})

describe('ackActionQueueItem — ApiError classification', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('throws ApiError kind:unreachable on 503 NO_DAEMON', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: false, errorCode: 'NO_DAEMON' }, 503),
    )
    try {
      await ackActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('unreachable')
      expect((err as ApiError).status).toBe(503)
    }
  })

  it('throws ApiError kind:stale-daemon on 502 PROXY_FAILED', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: false, errorCode: 'PROXY_FAILED' }, 502),
    )
    try {
      await ackActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('stale-daemon')
      expect((err as ApiError).status).toBe(502)
    }
  })
})

describe('dismissActionQueueItem — ApiError classification', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('throws ApiError kind:unreachable on 503 NO_DAEMON', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: false, errorCode: 'NO_DAEMON' }, 503),
    )
    try {
      await dismissActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('unreachable')
      expect((err as ApiError).status).toBe(503)
    }
  })

  it('throws ApiError kind:stale-daemon on 502 PROXY_FAILED', async () => {
    fetchSpy.mockResolvedValue(
      json({ ok: false, errorCode: 'PROXY_FAILED' }, 502),
    )
    try {
      await dismissActionQueueItem('aq-1')
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).kind).toBe('stale-daemon')
      expect((err as ApiError).status).toBe(502)
    }
  })
})
