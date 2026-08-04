import { z, type ZodType } from 'zod'
import { DAEMON_ERROR } from './daemonErrors'
import {
  actionQueueHistoryResponseSchema,
  actionQueueResponseSchema,
  adrsResponseSchema,
  agentToolCallsResponseSchema,
  autoRecipeRunsResponseSchema,
  stewardLedgerResponseSchema,
  wywaDeltaResponseSchema,
  chatConfigSchema,
  chatConversationResponseSchema,
  chatThreadDetailSchema,
  chatThreadsResponseSchema,
  eventsResponseSchema,
  frameworkUpdateSchema,
  glossaryResponseSchema,
  kpiArcsResponseSchema,
  kpisResponseSchema,
  learnedRecipesResponseSchema,
  originsResponseSchema,
  progressResponseSchema,
  projectsResponseSchema,
  projectMetaSchema,
  proposalDetailSchema,
  proposalsResponseSchema,
  releaseNotesCursorSchema,
  releaseNotesResponseSchema,
  skillsResponseSchema,
  staleWorktreesResponseSchema,
  tasksResponseSchema,
  visionResponseSchema,
  workerSessionsResponseSchema,
  type ActionQueueHistoryResponse,
  type ActionQueueItem,
  type AdrEntry,
  type AgentToolCall,
  type AutoRecipeRun,
  type StewardLedgerEntry,
  type WywaDeltaResponse,
  type ChatConfig,
  type ChatConversationResponse,
  type ChatThread,
  type ChatThreadDetail,
  type Decision,
  type EventsResponse,
  type FrameworkUpdate,
  type GlossaryTerm,
  type Kpi,
  type KpiArcsResponse,
  type KpiKey,
  type LearnedRecipe,
  type OriginsResponse,
  type ProgressProposalNode,
  type ProgressTask,
  type Project,
  type ProjectMeta,
  type ProposalDetail,
  type ProposalsPayload,
  type ReleaseNoteEntry,
  type ReleaseNotesCursor,
  type Skill,
  type StaleWorktreesPayload,
  type Task,
  type WorkerSession,
} from './schemas'

/** Discriminant for `ApiError` — lets the UI render the right remedy. */
export type ApiErrorKind = 'unreachable' | 'stale-daemon' | 'other'

/**
 * Typed fetch error thrown by `fetchJson`.
 *
 * - `unreachable` — connection refused (TypeError) or non-JSON response
 *   (hitting Vite catch-all). Remedy: start the API server.
 * - `stale-daemon` — HTTP 404 or 405 with a JSON body. The server is up but
 *   predates the route. Remedy: `mars daemon restart`.
 * - `other` — any other HTTP error (e.g. 500).
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | undefined

  constructor(message: string, kind: ApiErrorKind, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

const BASE = import.meta.env.VITE_API_BASE ?? ''

/**
 * Append `?project=<id>` (or `&project=<id>`) to a path. Used by every read
 * fetcher to scope the response to the focused project. No-op when projectId
 * is undefined.
 */
export const appendProject = (path: string, projectId: string | undefined): string => {
  if (!projectId) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}project=${encodeURIComponent(projectId)}`
}

/** Map a server-side proxy errorCode to an ApiErrorKind. */
const errorCodeToKind = (errorCode: unknown): ApiErrorKind => {
  if (errorCode === DAEMON_ERROR.NO_DAEMON) return 'unreachable'
  if (errorCode === DAEMON_ERROR.PROXY_FAILED) return 'stale-daemon'
  return 'other'
}

export const fetchJson = async <T>(
  path: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<T> => {
  let r: Response
  try {
    r = await fetchImpl(`${BASE}${path}`, signal ? { signal } : undefined)
  } catch (err) {
    if (err instanceof TypeError) {
      // On some platforms an aborted fetch raises TypeError instead of
      // DOMException(AbortError).  Re-throw as-is so React Query can
      // recognise it as a cancellation rather than a network error.
      if (signal?.aborted) throw err
      throw new ApiError(
        `GET ${path} → cannot reach the mars-ui API server. Start it with \`cd ui && npm run dev:server\` (or \`npm run dev:all\` to run UI + API together).`,
        'unreachable',
      )
    }
    throw err
  }
  if (!r.ok) {
    const ct = r.headers.get('content-type') ?? ''
    const isJson = ct.includes('application/json')
    let kind: ApiErrorKind
    if (isJson) {
      const body = await r.json().catch(() => null) as { errorCode?: unknown } | null
      const errorCode = body?.errorCode
      if (errorCode) {
        kind = errorCodeToKind(errorCode)
      } else if (r.status === 404 || r.status === 405) {
        kind = 'stale-daemon'
      } else {
        kind = 'other'
      }
    } else {
      kind = 'other'
    }
    throw new ApiError(`GET ${path} → ${r.status}`, kind, r.status)
  }
  const ct = r.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    throw new ApiError(
      `GET ${path} → expected JSON but got ${ct || 'unknown'} (is the mars-ui API server running?)`,
      'unreachable',
    )
  }
  const raw = await r.json()
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new Error(
      `GET ${path} → response failed schema validation: ${result.error.message}`,
    )
  }
  return result.data
}

const stepSpanSchema = z.object({
  stepName: z.string(),
  phase: z.string().nullable(),
  workflowInstanceId: z.string(),
  workerName: z.string().nullable(),
  outcome: z.enum(['running', 'completed', 'failed', 'killed']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  taskId: z.string().nullable(),
  originId: z.string().nullable(),
  evalResults: z.array(z.object({
    label: z.string(),
    value: z.union([z.number(), z.string(), z.null()]),
    warn: z.boolean(),
  })).optional(),
})

const stepSpansResponseSchema = z.object({ spans: z.array(stepSpanSchema) })

const runTimelineStepSchema = z.object({
  stepName: z.string(),
  phase: z.string().nullable(),
  workerName: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed', 'killed']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  claudeSessionId: z.string().nullable(),
  failureReason: z.string().nullable(),
  resultJson: z.string().nullable().optional(),
  inputJson: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
})

const runTimelineResponseSchema = z.object({
  taskId: z.string(),
  runs: z.array(z.object({
    runId: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    steps: z.array(runTimelineStepSchema),
  })),
})

const stepPromptResponseSchema = z.object({
  workflowInstanceId: z.string(),
  stepName: z.string(),
  prompt: z.string().nullable(),
  source: z.enum(['persisted', 'recovered']).nullable(),
})

export type StepSpanResponse = z.infer<typeof stepSpanSchema>
export type RunTimelineResponse = z.infer<typeof runTimelineResponseSchema>
export type StepPromptResponse = z.infer<typeof stepPromptResponseSchema>

/** Read the recorded workflow runs for a task in the focused project. */
export const fetchRunTimeline = async (
  taskId: string,
  projectId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunTimelineResponse> =>
  fetchJson(
    appendProject(`/api/runs/${encodeURIComponent(taskId)}`, projectId),
    runTimelineResponseSchema,
    undefined,
    fetchImpl,
  )

/** Read step spans for exactly one task or arc origin in the focused project. */
export const fetchStepSpans = async (
  query: { taskId?: string; originId?: string },
  projectId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StepSpanResponse[]> => {
  const params = new URLSearchParams()
  if (query.taskId) params.set('taskId', query.taskId)
  if (query.originId) params.set('originId', query.originId)
  const path = `/api/step-spans${params.size > 0 ? `?${params}` : ''}`
  const response = await fetchJson(
    appendProject(path, projectId),
    stepSpansResponseSchema,
    undefined,
    fetchImpl,
  )
  return response.spans
}

/** Read a persisted or recovered worker prompt in the focused project. */
export const fetchStepPrompt = async (
  workflowInstanceId: string,
  stepName: string,
  projectId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StepPromptResponse> => {
  const params = new URLSearchParams({ workflowInstanceId, stepName })
  return fetchJson(
    appendProject(`/api/step-prompt?${params}`, projectId),
    stepPromptResponseSchema,
    undefined,
    fetchImpl,
  )
}

/** Read one agent session's tool calls in the focused project. */
export const fetchAgentToolCalls = async (
  taskId: string,
  sessionId: string,
  projectId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentToolCall[]> => {
  const params = new URLSearchParams({ taskId, sessionId })
  const response = await fetchJson(
    appendProject(`/api/agent-tool-calls?${params}`, projectId),
    agentToolCallsResponseSchema,
    undefined,
    fetchImpl,
  )
  return response.calls
}

export const fetchTasks = async (projectId?: string): Promise<Task[]> => {
  const json = await fetchJson(appendProject('/api/tasks', projectId), tasksResponseSchema)
  return json.tasks
}

export const fetchProgress = async (
  projectId?: string,
  signal?: AbortSignal,
): Promise<{ tasks: ProgressTask[]; proposals: ProgressProposalNode[]; aggregates: { doneToday: number; doneTotal: number; failedOpen: number } }> => {
  const path = appendProject('/api/progress', projectId)
  const data = await fetchJson(path, progressResponseSchema, signal)
  return { tasks: data.tasks, proposals: data.proposals, aggregates: data.aggregates }
}

export const fetchProposalsPayload = async (projectId?: string): Promise<ProposalsPayload> => {
  return fetchJson(appendProject('/api/proposals', projectId), proposalsResponseSchema)
}

export const fetchProposalDetail = async (id: string, projectId?: string): Promise<ProposalDetail> => {
  return fetchJson(appendProject(`/api/proposals/${encodeURIComponent(id)}`, projectId), proposalDetailSchema)
}

export const fetchStaleWorktreesPayload = async (projectId?: string): Promise<StaleWorktreesPayload> => {
  return fetchJson(appendProject('/api/stale-worktrees', projectId), staleWorktreesResponseSchema)
}

export const fetchFrameworkUpdate = async (): Promise<FrameworkUpdate> => {
  return fetchJson('/api/framework-update', frameworkUpdateSchema)
}

export const fetchActionQueue = async (projectId?: string): Promise<ActionQueueItem[]> => {
  return fetchJson(appendProject('/api/action-queue', projectId), actionQueueResponseSchema)
}

/**
 * Fetch a cursor-paged slice of resolved action-queue rows (history).
 * Rows are newest-first by resolved_at. Pass the returned `nextCursor`
 * as `cursor` on the next call to page forward.
 */
export const fetchActionQueueHistory = async (
  opts: { cursor?: string | null; limit?: number } = {},
  projectId?: string,
): Promise<ActionQueueHistoryResponse> => {
  const params = new URLSearchParams()
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (projectId) params.set('project', encodeURIComponent(projectId))
  const qs = params.toString()
  const path = qs ? `/api/action-queue/history?${qs}` : '/api/action-queue/history'
  return fetchJson(path, actionQueueHistoryResponseSchema)
}

/**
 * Parse the error body from a non-ok mutation response and throw an `ApiError`
 * with a classified kind. The server proxy sends `{ errorCode }` on daemon
 * connectivity failures; anything else falls back to kind `'other'`.
 */
const throwMutationError = async (path: string, r: Response): Promise<never> => {
  const body = await r.json().catch(() => null) as { errorCode?: unknown } | null
  const errorCode = body?.errorCode
  const kind = errorCodeToKind(errorCode)
  throw new ApiError(
    `POST ${path} → ${r.status}${errorCode ? ` (${String(errorCode)})` : ''}`,
    kind,
    r.status,
  )
}

export const dismissActionQueueItem = async (id: string): Promise<void> => {
  const path = '/api/action-queue/dismiss'
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) await throwMutationError(path, r)
}

export const ackActionQueueItem = async (id: string): Promise<void> => {
  const path = '/api/action-queue/ack'
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) await throwMutationError(path, r)
}

export const resolveActionQueueItem = async (id: string): Promise<void> => {
  const path = '/api/action-queue/resolve'
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) await throwMutationError(path, r)
}

/**
 * Fetch recent finished sessions for a Worker by name. Sessions are returned
 * newest-first. The outcome is from the closed set {running, completed,
 * failed, killed}; a killed outcome means the read-span watchdog terminated
 * the session.
 */
export const fetchWorkerSessions = async (
  agentName: string,
  projectId?: string,
): Promise<WorkerSession[]> => {
  const path = appendProject(
    `/api/sessions?agentName=${encodeURIComponent(agentName)}`,
    projectId,
  )
  const json = await fetchJson(path, workerSessionsResponseSchema)
  return json.sessions
}

export const fetchKpis = async (projectId?: string): Promise<Kpi[]> => {
  const json = await fetchJson(appendProject('/api/kpis', projectId), kpisResponseSchema)
  return json.kpis
}

/**
 * Fetch the per-arc breakdown for a single KPI key.
 * Returns the full response including window metadata and arc list.
 */
export const fetchKpiArcs = async (
  key: KpiKey,
  projectId?: string,
): Promise<KpiArcsResponse> => {
  return fetchJson(
    appendProject(`/api/kpis/${encodeURIComponent(key)}/arcs`, projectId),
    kpiArcsResponseSchema,
  )
}

/**
 * Invoke a recovery action against the daemon (via the UI server proxy). `op`
 * is the registry verb; `entityId` is the task/worktree id, omitted for
 * process-level ops (`restart-daemon`). Throws an `ApiError` so the caller can
 * map it to a human-readable remedy message:
 * - `unreachable` — connection refused or daemon not running (NO_DAEMON errorCode)
 * - `stale-daemon` — proxy reached a stale/outdated daemon (PROXY_FAILED errorCode)
 * - `other` — any other non-2xx response
 */
export const invokeAction = async (
  op: string,
  entityId?: string,
): Promise<void> => {
  let r: Response
  try {
    r = await fetch(`${BASE}/api/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, entityId }),
    })
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError(
        `POST /api/actions → cannot reach the mars-ui API server`,
        'unreachable',
      )
    }
    throw err
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as {
      error?: string
      errorCode?: string
    }
    const kind = errorCodeToKind(body.errorCode)
    throw new ApiError(
      `POST /api/actions/${op} → ${r.status}${body.error ? `: ${body.error}` : ''}`,
      kind,
      r.status,
    )
  }
}

/**
 * Trigger the daemon's self-update action. Throws when the daemon rejects the
 * request (e.g. dev install, daemon unreachable, or update already in progress).
 */
export const triggerSelfUpdate = (): Promise<void> => invokeAction('self-update')

/** Valid preset durations for the snooze preset menu. */
export type SnoozePreset = '1h' | '4h' | 'tomorrow-morning' | 'next-week'

/**
 * Snooze an action-queue item for the given preset duration.
 * Routes to POST /api/actions/snooze/:id on the UI server, which proxies to
 * the daemon's /actions/snooze/:id endpoint.
 *
 * @param id  The opaque action-queue row id (e.g. "abc123").
 * @param preset  How long to snooze.
 */
export const snoozeActionQueueItem = async (
  id: string,
  preset: SnoozePreset,
): Promise<void> => {
  let r: Response
  try {
    r = await fetch(`${BASE}/api/actions/snooze/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset }),
    })
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError(
        `POST /api/actions/snooze → cannot reach the mars-ui API server`,
        'unreachable',
      )
    }
    throw err
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; errorCode?: string }
    throw new ApiError(
      `POST /api/actions/snooze → ${r.status}${body.error ? `: ${body.error}` : ''}`,
      errorCodeToKind(body.errorCode),
      r.status,
    )
  }
}

/**
 * Restore (un-snooze) a previously snoozed action-queue item.
 * Routes to POST /api/actions/snooze/:id with restore=true.
 */
export const restoreSnoozedItem = async (id: string): Promise<void> => {
  let r: Response
  try {
    r = await fetch(`${BASE}/api/actions/snooze/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: true }),
    })
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError(
        `POST /api/actions/snooze (restore) → cannot reach the mars-ui API server`,
        'unreachable',
      )
    }
    throw err
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; errorCode?: string }
    throw new ApiError(
      `POST /api/actions/snooze (restore) → ${r.status}${body.error ? `: ${body.error}` : ''}`,
      errorCodeToKind(body.errorCode),
      r.status,
    )
  }
}

/**
 * POST a server-defined Decision's payload to its endpoint.
 * Returns the raw fetch Response — callers can inspect status if needed.
 */
export const postDecision = (d: Decision): Promise<Response> =>
  fetch(`${BASE}${d.endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(d.payload),
  })

export const eventsUrl = (): string => `${BASE}/events`

/**
 * Build the URL for a thread's resumable UIMessage-chunk stream
 * (`GET /api/chat/thread/:id/ui-stream`, proxied to the daemon). Consumed by
 * `MarsChatTransport`:
 * - `mode: 'send'`   → follow the run just triggered by `postChatMessage`
 *   (the daemon replays its buffer, so a fast run that finished before we
 *   connected is not lost).
 * - `mode: 'resume'` → reconnect to an in-flight run (204 → no active run).
 * `lastEventId` is the `<gen>.<seq>` cursor of the last chunk the client saw;
 * the daemon replays only chunks after it, making mid-run reconnects seamless.
 */
export const chatUiStreamUrl = (
  threadId: string,
  opts: { mode: 'send' | 'resume'; lastEventId?: string | null; projectId?: string },
): string => {
  const params = new URLSearchParams()
  params.set('mode', opts.mode)
  if (opts.lastEventId) params.set('lastEventId', opts.lastEventId)
  if (opts.projectId) params.set('project', opts.projectId)
  return `${BASE}/api/chat/thread/${encodeURIComponent(threadId)}/ui-stream?${params.toString()}`
}

export interface EventsFilter {
  taskId?: string
  originId?: string
  /** Multi-select. Repeats the `kind` param once per value. */
  kind?: readonly string[]
  /** Multi-select. Repeats the `severity` param once per value. */
  severity?: readonly string[]
  /** Multi-select. Repeats the `phase` param once per value. */
  phase?: readonly string[]
  /** ISO timestamp lower bound (inclusive). */
  since?: string
  /** ISO timestamp upper bound (exclusive). */
  until?: string
  /** Full-text payload search. SQLite LIKE on the JSON column. */
  q?: string
  cursor?: string
  limit?: number
}

/**
 * Fetch a page of trace events from the daemon (via the UI server proxy).
 *
 * Two consumers:
 *   - Action queue detail panel's Traces section — passes `{ taskId, limit }` and
 *     paginates with `cursor`.
 *   - The Events tab — passes the full multi-filter surface.
 *
 * Multi-select filters (`kind`, `severity`, `phase`) repeat the param key
 * once per value, matching the `/events` endpoint's `params.getAll(...)`
 * shape. Newest-first ordering.
 */
export const fetchEvents = async (
  filter: EventsFilter,
  projectId?: string,
): Promise<EventsResponse> => {
  const params = new URLSearchParams()
  if (filter.taskId !== undefined) params.set('taskId', filter.taskId)
  if (filter.originId !== undefined) params.set('originId', filter.originId)
  if (filter.kind !== undefined) {
    for (const k of filter.kind) params.append('kind', k)
  }
  if (filter.severity !== undefined) {
    for (const s of filter.severity) params.append('severity', s)
  }
  if (filter.phase !== undefined) {
    for (const p of filter.phase) params.append('phase', p)
  }
  if (filter.since !== undefined) params.set('since', filter.since)
  if (filter.until !== undefined) params.set('until', filter.until)
  if (filter.q !== undefined) params.set('q', filter.q)
  if (filter.cursor !== undefined) params.set('cursor', filter.cursor)
  if (filter.limit !== undefined) params.set('limit', String(filter.limit))
  if (projectId !== undefined) params.set('project', projectId)
  const qs = params.toString()
  const path = qs ? `/api/trace-events?${qs}` : '/api/trace-events'
  return fetchJson(path, eventsResponseSchema)
}

/**
 * Fetch the origin tree for a task. Root is the highest-level known ancestor
 * (a proposal, a sliced PRD, or the originating task). The current task sits
 * inside the tree; the UI highlights it on render.
 */
export const fetchOrigins = async (
  taskId: string,
  projectId?: string,
): Promise<OriginsResponse> => {
  return fetchJson(
    appendProject(`/api/origins/${encodeURIComponent(taskId)}`, projectId),
    originsResponseSchema,
  )
}

/**
 * Fetch the list of registered projects. Each entry carries daemon health so
 * the ProjectSelector can render live / degraded / down badges and a Start
 * control for down projects.
 */
export const fetchProjects = async (): Promise<Project[]> => {
  const json = await fetchJson('/api/projects', projectsResponseSchema)
  return json.projects
}

/**
 * Start the daemon for a project whose health is 'down'. Operator-gated: the
 * dashboard never starts a daemon except via an explicit Start click in the
 * ProjectSelector.
 */
export const startProject = async (projectId: string): Promise<void> => {
  const r = await fetch(
    `${BASE}/api/projects/${encodeURIComponent(projectId)}/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  )
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(
      `startProject(${projectId}) failed (${r.status})${body.error ? `: ${body.error}` : ''}`,
    )
  }
}

/**
 * Restart the daemon for a project, whether or not it is currently running.
 * Backs onto `mars daemon restart --repo <repoRoot>` — idempotent w.r.t.
 * liveness; starts a fresh daemon even if the existing one is dead or stale.
 * Unlike the `restart-daemon` action verb (which POSTs into the running daemon),
 * this spawns a fresh OS process, so it works even when the daemon is down.
 */
export const restartProject = async (projectId: string): Promise<void> => {
  const r = await fetch(
    `${BASE}/api/projects/${encodeURIComponent(projectId)}/restart`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  )
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(
      `restartProject(${projectId}) failed (${r.status})${body.error ? `: ${body.error}` : ''}`,
    )
  }
}

/**
 * Fetch the arc-grouped release-notes feed. Entries are returned newest-first.
 * Each entry covers one landed arc (origin task + any recovery tasks folded in).
 */
export const fetchReleaseNotes = async (projectId?: string): Promise<ReleaseNoteEntry[]> => {
  return fetchJson(appendProject('/api/release-notes', projectId), releaseNotesResponseSchema)
}

/**
 * Fetch the release-notes view cursor — the timestamp the user last viewed the
 * release notes for this project. Returns `{ lastViewedAt: null }` when the
 * cursor has never been set (first-ever view).
 */
export const getReleaseNotesCursor = async (projectId?: string): Promise<ReleaseNotesCursor> => {
  return fetchJson(
    appendProject('/api/release-notes-cursor', projectId),
    releaseNotesCursorSchema,
  )
}

/**
 * POST to mark the release notes as viewed right now. Returns the updated cursor.
 * Callers should invalidate the `['release-notes-cursor', projectId]` query key
 * after this resolves.
 */
export const postReleaseNotesViewed = async (projectId?: string): Promise<ReleaseNotesCursor> => {
  const path = appendProject('/api/release-notes-cursor', projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/release-notes-cursor → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
  const raw = await r.json()
  const result = releaseNotesCursorSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(
      `POST /api/release-notes-cursor → response failed schema validation: ${result.error.message}`,
    )
  }
  return result.data
}

export const dismissTodoItem = async (
  id: string,
  kind: 'draft' | 'stale',
): Promise<void> => {
  const r = await fetch(`${BASE}/api/action-queue/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, kind }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/action-queue/dismiss → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Chat presentation preference
// ---------------------------------------------------------------------------

const chatLayoutPreferenceSchema = z.object({
  layout: z.enum(['focus', 'threads']),
})

export type ChatLayout = z.infer<typeof chatLayoutPreferenceSchema>['layout']

export const fetchChatLayoutPreference = async (): Promise<{ layout: ChatLayout }> => {
  return fetchJson('/api/preferences/chat-layout', chatLayoutPreferenceSchema)
}

export const putChatLayoutPreference = async (
  layout: ChatLayout,
): Promise<{ layout: ChatLayout }> => {
  const path = '/api/preferences/chat-layout'
  const response = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout }),
  })
  if (!response.ok) await throwMutationError(path, response)
  return chatLayoutPreferenceSchema.parse(await response.json())
}

// ---------------------------------------------------------------------------
// Chat API — threads, messages, mutations
// ---------------------------------------------------------------------------

/**
 * List all chat threads for the focused project, newest-first.
 */
export interface ChatThreadForkFilter {
  parentThreadId?: string
  hasParent?: boolean
}

export const fetchChatThreads = async (
  projectId?: string,
  forkFilter: ChatThreadForkFilter = {},
): Promise<ChatThread[]> => {
  const params = new URLSearchParams()
  if (forkFilter.parentThreadId) params.set('parentThreadId', forkFilter.parentThreadId)
  if (forkFilter.hasParent) params.set('hasParent', 'true')
  const path = appendProject('/api/chat/threads', projectId)
  const json = await fetchJson(
    params.size > 0 ? `${path}${path.includes('?') ? '&' : '?'}${params}` : path,
    chatThreadsResponseSchema,
  )
  return json.threads
}

/** List every persisted message in the global Subthread conversation order. */
export const fetchChatConversation = async (projectId?: string): Promise<ChatConversationResponse> => {
  return fetchJson(
    appendProject('/api/chat/conversation', projectId),
    chatConversationResponseSchema,
  )
}

/**
 * Fetch a single thread with its full message list.
 */
export const fetchChatThread = async (
  id: string,
  projectId?: string,
): Promise<ChatThreadDetail> => {
  return fetchJson(
    appendProject(`/api/chat/thread/${encodeURIComponent(id)}`, projectId),
    chatThreadDetailSchema,
  )
}

const threadTasksResponseSchema = z.object({
  tasks: z.array(z.string()),
})

/** List task IDs linked to one chat thread, in creation order. */
export const fetchTasksForThread = async (threadId: string): Promise<string[]> => {
  const json = await fetchJson(
    `/api/chat/threads/${encodeURIComponent(threadId)}/tasks`,
    threadTasksResponseSchema,
  )
  return json.tasks
}

export interface CreateChatThreadOptions {
  projectId?: string
  title?: string
  objective?: string
  origin?: string
}

/**
 * Create a new chat thread. Returns the created thread (id, title, status, …).
 */
export const createChatThread = async ({
  projectId,
  title,
  objective,
  origin,
}: CreateChatThreadOptions): Promise<ChatThread> => {
  const path = appendProject('/api/chat/threads', projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, objective, origin }),
  })
  if (!r.ok) await throwMutationError(path, r)
  const raw = await r.json()
  const result = chatThreadsResponseSchema.shape.threads.element.safeParse(raw)
  if (!result.success) {
    throw new Error(`POST ${path} → response failed schema validation: ${result.error.message}`)
  }
  return result.data
}

/**
 * Start a fresh inline Subthread with its situation report and first message in
 * one request. The daemon only returns after it has accepted the chat run.
 */
export const createSubthreadAndSend = async (
  message: string,
  projectId?: string,
  attachments?: AttachmentInfo[],
): Promise<ChatThread> => {
  const path = appendProject('/api/chat/subthreads', projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, ...(attachments && attachments.length > 0 ? { attachments } : {}) }),
  })
  if (!r.ok) await throwMutationError(path, r)
  const raw = await r.json()
  const result = chatThreadsResponseSchema.shape.threads.element.safeParse(raw)
  if (!result.success) {
    throw new Error(`POST ${path} → response failed schema validation: ${result.error.message}`)
  }
  return result.data
}

/**
 * Metadata returned by the daemon after a successful file upload.
 * Mirrors the daemon's `AttachmentInfo` interface and is accepted verbatim
 * by `postChatMessage`'s `attachments` parameter.
 */
export interface AttachmentInfo {
  id: string
  path: string
  mimeType: string
  name: string
  size: number
}

/**
 * Post a user message to a thread. The daemon queues a Claude response.
 * Returns once the message is enqueued — the response arrives via SSE or
 * a subsequent `fetchChatThread` call.
 *
 * Pass `attachments` (returned by `uploadAttachment`) to send uploaded files
 * alongside the message. The full metadata (including `size`) is required by
 * the daemon schema — passing only ids is not supported.
 */
export const postChatMessage = async (
  threadId: string,
  text: string,
  projectId?: string,
  attachments?: AttachmentInfo[],
): Promise<void> => {
  const path = appendProject(`/api/chat/threads/${encodeURIComponent(threadId)}/message`, projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }),
  })
  if (!r.ok) await throwMutationError(path, r)
}

/**
 * Upload a file attachment to a thread. Returns the server-assigned attachment
 * metadata (id, path, mimeType, name, size). Pass the full returned object in
 * `postChatMessage`'s `attachments` array to reference the file in the message.
 *
 * The multipart body is streamed to the daemon via the UI server proxy without
 * buffering the entire file in memory.
 */
export const uploadAttachment = async (
  threadId: string,
  file: File,
  projectId?: string,
): Promise<AttachmentInfo> => {
  const path = appendProject(
    `/api/chat/threads/${encodeURIComponent(threadId)}/attachments`,
    projectId,
  )
  const fd = new FormData()
  fd.append('file', file)
  let r: Response
  try {
    r = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError(
        `POST ${path} → cannot reach the mars-ui API server`,
        'unreachable',
      )
    }
    throw err
  }
  if (!r.ok) await throwMutationError(path, r)
  return r.json() as Promise<AttachmentInfo>
}

/**
 * Rename a thread. The title is updated server-side; the client should
 * invalidate the threads list query after this resolves.
 */
export const renameChatThread = async (
  threadId: string,
  title: string,
  projectId?: string,
): Promise<void> => {
  const path = appendProject(`/api/chat/threads/${encodeURIComponent(threadId)}/title`, projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!r.ok) await throwMutationError(path, r)
}

/**
 * Stop a running thread response early.
 */
export const stopChatThread = async (
  threadId: string,
  projectId?: string,
): Promise<void> => {
  const path = appendProject(`/api/chat/threads/${encodeURIComponent(threadId)}/stop`, projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!r.ok) await throwMutationError(path, r)
}

/** Explicitly close an open-ended Subthread without invoking the chat provider. */
export const endChatSubthread = async (
  threadId: string,
  projectId?: string,
): Promise<void> => {
  const path = appendProject(`/api/chat/threads/${encodeURIComponent(threadId)}/end`, projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!r.ok) await throwMutationError(path, r)
}

/**
 * Upsert thumbs-up / thumbs-down feedback for an assistant message.
 * Passing the same rating that's already active clears it (call `clearMessageFeedback`
 * instead when you know you want to remove it).
 */
export const setMessageFeedback = async (
  messageId: string,
  rating: 'up' | 'down',
  note: string | null,
): Promise<void> => {
  const path = `/api/chat/messages/${encodeURIComponent(messageId)}/feedback`
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, ...(note !== null ? { note } : {}) }),
  })
  if (!r.ok) await throwMutationError(path, r)
}

/**
 * Remove feedback from a message (idempotent).
 */
export const clearMessageFeedback = async (messageId: string): Promise<void> => {
  const path = `/api/chat/messages/${encodeURIComponent(messageId)}/feedback/clear`
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!r.ok) await throwMutationError(path, r)
}

/** Execute a Notice's stored zero-token response without sending a chat turn. */
export const postPreloadedResponse = async (
  messageId: string,
  responseId: string,
  projectId?: string,
): Promise<{ threadId?: string }> => {
  const path = appendProject(
    `/api/chat/messages/${encodeURIComponent(messageId)}/responses/${encodeURIComponent(responseId)}`,
    projectId,
  )
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!r.ok) await throwMutationError(path, r)
  const result = await r.json() as { threadId?: unknown }
  return typeof result.threadId === 'string' ? { threadId: result.threadId } : {}
}

/**
 * Fetch the evaporated (history) chat threads.
 */
export const fetchChatHistory = async (projectId?: string): Promise<ChatThread[]> => {
  const json = await fetchJson(appendProject('/api/chat/history', projectId), chatThreadsResponseSchema)
  return json.threads
}

/**
 * Fetch the global Codex auth state (whether any thread is stalled due to
 * an auth failure).
 */
export const fetchCodexAuthState = async (
  projectId?: string,
): Promise<{ needsAuth: boolean }> => {
  const r = await fetch(`${BASE}${appendProject('/api/codex-auth', projectId)}`)
  if (!r.ok) return { needsAuth: false }
  const data = await r.json() as { needsAuth: boolean }
  return { needsAuth: Boolean(data.needsAuth) }
}

/**
 * Fetch the chat agent's effective configuration: model, resolved system
 * prompt (+ source), built-in tools, skill index, and MCP servers.
 */
export const fetchChatConfig = async (projectId?: string): Promise<ChatConfig> =>
  fetchJson(appendProject('/api/chat/config', projectId), chatConfigSchema)

/**
 * Notify the daemon that the user has re-authenticated with Codex so all
 * throttled threads can resume.
 */
export const refreshCodexAuth = async (projectId?: string): Promise<void> => {
  const path = appendProject('/api/codex-auth/refresh', projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (!r.ok) await throwMutationError(path, r)
}

// ---------------------------------------------------------------------------
// Context rail data — glossary terms and skills
// ---------------------------------------------------------------------------

/**
 * Fetch the project glossary from the daemon (via the UI server proxy).
 * Returns an empty terms list when the daemon is unreachable or the
 * glossary directory does not exist.
 */
export const fetchGlossary = async (): Promise<GlossaryTerm[]> => {
  const json = await fetchJson('/api/glossary', glossaryResponseSchema)
  return json.terms
}

/**
 * Fetch available skills from the daemon (via the UI server proxy).
 * Returns an empty skills list when the daemon is unreachable or the
 * `.claude/skills/` directory does not exist.
 */
export const fetchSkills = async (): Promise<Skill[]> => {
  const json = await fetchJson('/api/skills', skillsResponseSchema)
  return json.skills
}

/**
 * Fetch the ADR list from the daemon (via the UI server proxy).
 * Returns ADRs in descending-number order (newest first).
 * Returns an empty array when the daemon is unreachable or docs/adr/ does not exist.
 */
export const fetchAdrs = async (projectId?: string): Promise<AdrEntry[]> => {
  const json = await fetchJson(appendProject('/api/adrs', projectId), adrsResponseSchema)
  return json.adrs
}

/** Fetch the stable product context shown alongside session artifacts. */
export const fetchProjectMeta = async (projectId?: string): Promise<ProjectMeta> =>
  fetchJson(appendProject('/api/project/context', projectId), projectMetaSchema)

/**
 * Fetch the project vision from VISION.md (via the UI server).
 * Returns `null` when VISION.md does not exist in the project repo.
 * Never throws — errors degrade gracefully to null in the caller.
 */
export const fetchVision = async (projectId?: string): Promise<string | null> => {
  const json = await fetchJson(appendProject('/api/vision', projectId), visionResponseSchema)
  return json.content
}

// ---------------------------------------------------------------------------
// Learned recipes
// ---------------------------------------------------------------------------

/** Fetch all operator-taught auto-run rules. Returns [] when daemon unreachable. */
export const fetchLearnedRecipes = async (): Promise<LearnedRecipe[]> => {
  const json = await fetchJson('/api/failure-kinds/learned-recipes', learnedRecipesResponseSchema)
  return json.learnedRecipes
}

/** Teach the daemon to auto-run `op` next time `signature` fires. Idempotent. */
export const teachRecipe = async (signature: string, op: string): Promise<void> => {
  let r: Response
  try {
    r = await fetch(`${BASE}/api/failure-kinds/${encodeURIComponent(signature)}/recipe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op }),
    })
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError(`POST /api/failure-kinds/recipe → cannot reach the mars-ui API server`, 'unreachable')
    }
    throw err
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; errorCode?: string }
    throw new ApiError(
      `POST /api/failure-kinds/recipe → ${r.status}${body.error ? `: ${body.error}` : ''}`,
      errorCodeToKind(body.errorCode),
      r.status,
    )
  }
}

/** Remove the auto-run rule for `signature`. No-op when no rule is stored. */
export const unlearnRecipe = async (signature: string): Promise<void> => {
  let r: Response
  try {
    r = await fetch(`${BASE}/api/failure-kinds/${encodeURIComponent(signature)}/recipe`, { method: 'DELETE' })
  } catch (err) {
    if (err instanceof TypeError) {
      throw new ApiError(`DELETE /api/failure-kinds/recipe → cannot reach the mars-ui API server`, 'unreachable')
    }
    throw err
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; errorCode?: string }
    throw new ApiError(
      `DELETE /api/failure-kinds/recipe → ${r.status}${body.error ? `: ${body.error}` : ''}`,
      errorCodeToKind(body.errorCode),
      r.status,
    )
  }
}

/** Fetch recent auto-recipe run log entries, newest-first. Used by WYWA panel. */
export const fetchAutoRecipeRuns = async (opts?: { since?: string; limit?: number }): Promise<AutoRecipeRun[]> => {
  const params: string[] = []
  if (opts?.since) params.push(`since=${encodeURIComponent(opts.since)}`)
  if (opts?.limit !== undefined) params.push(`limit=${opts.limit}`)
  const qs = params.length > 0 ? `?${params.join('&')}` : ''
  const json = await fetchJson(`/api/auto-recipe-runs${qs}`, autoRecipeRunsResponseSchema)
  return json.autoRecipeRuns
}

/** Fetch Steward's immutable intervention history, optionally for one target. */
export const fetchStewardLedger = async (
  targetKind?: string,
  targetId?: string,
): Promise<StewardLedgerEntry[]> => {
  const params: string[] = []
  if (targetKind) params.push(`targetKind=${encodeURIComponent(targetKind)}`)
  if (targetId) params.push(`targetId=${encodeURIComponent(targetId)}`)
  const qs = params.length > 0 ? `?${params.join('&')}` : ''
  const json = await fetchJson(`/api/steward-ledger${qs}`, stewardLedgerResponseSchema)
  return json.entries
}

/**
 * Fetch the unified "while you were away" delta from the daemon — merges,
 * recoveries, auto-recipes, throttle events, and evaporated threads — all
 * since the given cursor, newest first and capped at `limit` (default 30).
 */
export const fetchWywaDelta = async (opts?: {
  since?: string
  limit?: number
}): Promise<WywaDeltaResponse> => {
  const params: string[] = []
  if (opts?.since) params.push(`since=${encodeURIComponent(opts.since)}`)
  if (opts?.limit !== undefined) params.push(`limit=${opts.limit}`)
  const qs = params.length > 0 ? `?${params.join('&')}` : ''
  return fetchJson(`/api/wywa-delta${qs}`, wywaDeltaResponseSchema)
}

export type {
  ActionQueueHistoryResponse,
  ActionQueueItem,
  ActionQueueResolution,
  AdrEntry,
  AutoRecipeRun,
  ChatThread,
  ChatThreadDetail,
  DaemonHealth,
  Decision,
  EventsResponse,
  FrameworkUpdate,
  GlossaryTerm,
  Kpi,
  KpiArc,
  KpiArcsResponse,
  KpiKey,
  LearnedRecipe,
  OriginsResponse,
  ProgressProposalNode,
  Project,
  ProposalDetail,
  ProposalsPayload,
  ReleaseNoteEntry,
  ReleaseNotesCursor,
  ReleaseNoteSpec,
  SessionOutcome,
  Skill,
  StewardLedgerEntry,
  StaleWorktree,
  StaleWorktreesPayload,
  TraceEvent,
  WorkerSession,
  WywaDeltaResponse,
  WywaEvent,
} from './schemas'
