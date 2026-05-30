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
  fetchActionQueue,
  fetchAgents,
  fetchEvents,
  fetchFailureReasons,
  fetchOrigins,
  fetchProgress,
  fetchProjects,
  fetchTasks,
  fetchTodo,
  startProject,
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

  it('parses a failed-task row without staleWorktreeDetail without error', async () => {
    // failed-task rows do not carry staleWorktreeDetail — the field belongs only
    // to the stale-worktree variant of the discriminated union and is stripped by
    // zod for all other kinds.
    fetchSpy.mockResolvedValue(json([minActionQueueItem()]))
    const result = await fetchActionQueue()
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('failed-task')
    // Narrowing inside the kind guard confirms the field is absent on this variant.
    if (result[0].kind === 'failed-task') {
      // staleWorktreeDetail is not a property of the failed-task variant;
      // runtime value is undefined (zod strips unknown keys by default).
      expect((result[0] as Record<string, unknown>)['staleWorktreeDetail']).toBeUndefined()
    }
  })

  it('parses a failed-task row with staleWorktreeDetail null in server payload without error', async () => {
    // When an older server build sends staleWorktreeDetail:null on a failed-task row,
    // the discriminated-union schema strips the unknown key — the row still parses.
    fetchSpy.mockResolvedValue(json([minActionQueueItem({ staleWorktreeDetail: null })]))
    const result = await fetchActionQueue()
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('failed-task')
  })

  it('throws on HTTP error', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'not found' }, 500))
    await expect(fetchActionQueue()).rejects.toThrow('500')
  })
})

// ---------------------------------------------------------------------------
// fetchFailureReasons / fetchEvents / fetchOrigins (slice H)
// ---------------------------------------------------------------------------

describe('fetchFailureReasons', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('returns the typed catalog on a valid response', async () => {
    fetchSpy.mockResolvedValue(
      json([
        {
          code: 'verify:typecheck',
          userMessage: 'msg',
          recipe: null,
          availableActions: [
            { id: 'restart', label: 'Restart', cliHint: 'mars restart <id>' },
          ],
        },
      ]),
    )
    const r = await fetchFailureReasons()
    expect(r).toHaveLength(1)
    expect(r[0].code).toBe('verify:typecheck')
    expect(r[0].availableActions[0].id).toBe('restart')
  })

  it('throws when an entry is missing required fields', async () => {
    fetchSpy.mockResolvedValue(json([{ code: 'x' }]))
    await expect(fetchFailureReasons()).rejects.toThrow('schema validation')
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

describe('fetchProgress – ?project= appended alongside failedWindow', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: Mock<any>
  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('appends &project=<id> after existing ?failedWindow param', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress(3_600_000, 'proj-abc')
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('failedWindow=3600000')
    expect(calledUrl).toContain('project=proj-abc')
    // project must come after the ? separator (i.e. as &project)
    const questionMark = calledUrl.indexOf('?')
    const projectIdx = calledUrl.indexOf('project=')
    expect(projectIdx).toBeGreaterThan(questionMark)
  })

  it('uses ?project= when there is no failedWindow param', async () => {
    fetchSpy.mockResolvedValue(json({ tasks: [], proposals: [] }))
    await fetchProgress(undefined, 'proj-xyz')
    const calledUrl: string = (fetchSpy.mock.calls[0] as string[])[0]!
    expect(calledUrl).toContain('?project=proj-xyz')
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
