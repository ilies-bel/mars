import type { ZodType } from 'zod'
import { DAEMON_ERROR } from './daemonErrors'
import {
  actionQueueHistoryResponseSchema,
  actionQueueResponseSchema,
  budgetStatusSchema,
  chatThreadDetailSchema,
  chatThreadsResponseSchema,
  eventsResponseSchema,
  frameworkUpdateSchema,
  glossaryResponseSchema,
  kpiArcsResponseSchema,
  kpisResponseSchema,
  originsResponseSchema,
  progressResponseSchema,
  projectsResponseSchema,
  proposalDetailSchema,
  proposalsResponseSchema,
  releaseNotesCursorSchema,
  releaseNotesResponseSchema,
  skillsResponseSchema,
  staleWorktreesResponseSchema,
  tasksResponseSchema,
  workerSessionsResponseSchema,
  type ActionQueueHistoryResponse,
  type ActionQueueItem,
  type BudgetStatus,
  type ChatThread,
  type ChatThreadDetail,
  type EventsResponse,
  type FrameworkUpdate,
  type GlossaryTerm,
  type Kpi,
  type KpiArcsResponse,
  type KpiKey,
  type OriginsResponse,
  type ProgressProposalNode,
  type ProgressTask,
  type Project,
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
const appendProject = (path: string, projectId: string | undefined): string => {
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

const fetchJson = async <T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> => {
  let r: Response
  try {
    r = await fetch(`${BASE}${path}`, signal ? { signal } : undefined)
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
 * Fetch the spend-meter status (observe-and-warn token-budget alerting).
 * `configured: false` means the operator has not set thresholds via
 * `mars budget set` — the tile renders a quiet "not configured" state,
 * never a fake zero.
 */
export const fetchBudgetStatus = async (projectId?: string): Promise<BudgetStatus> =>
  fetchJson(appendProject('/api/budget', projectId), budgetStatusSchema)

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

export const eventsUrl = (): string => `${BASE}/events`

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
// Chat API — threads, messages, mutations
// ---------------------------------------------------------------------------

/**
 * List all chat threads for the focused project, newest-first.
 */
export const fetchChatThreads = async (projectId?: string): Promise<ChatThread[]> => {
  const json = await fetchJson(appendProject('/api/chat/threads', projectId), chatThreadsResponseSchema)
  return json.threads
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

/**
 * Create a new chat thread. Returns the created thread (id, title, status, …).
 */
export const createChatThread = async (projectId?: string): Promise<ChatThread> => {
  const path = appendProject('/api/chat/threads', projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
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
 * Post a user message to a thread. The daemon queues a Claude response.
 * Returns once the message is enqueued — the response arrives via SSE or
 * a subsequent `fetchChatThread` call.
 */
export const postChatMessage = async (
  threadId: string,
  text: string,
  projectId?: string,
): Promise<void> => {
  const path = appendProject(`/api/chat/threads/${encodeURIComponent(threadId)}/message`, projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!r.ok) await throwMutationError(path, r)
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
 * Delete a thread and all its messages. Irreversible.
 */
export const deleteChatThread = async (
  threadId: string,
  projectId?: string,
): Promise<void> => {
  const path = appendProject(`/api/chat/threads/${encodeURIComponent(threadId)}/delete`, projectId)
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
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

// ---------------------------------------------------------------------------
// Context rail data — glossary terms and skills
// ---------------------------------------------------------------------------

/**
 * Fetch the project glossary from the daemon (via the UI server proxy).
 * Returns an empty terms list when the daemon is unreachable or the
 * CONTEXT.md file does not exist.
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

export type {
  ActionQueueHistoryResponse,
  ActionQueueItem,
  ActionQueueResolution,
  ChatThread,
  ChatThreadDetail,
  DaemonHealth,
  EventsResponse,
  FrameworkUpdate,
  GlossaryTerm,
  Kpi,
  KpiArc,
  KpiArcsResponse,
  KpiKey,
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
  StaleWorktree,
  StaleWorktreesPayload,
  TraceEvent,
  WorkerSession,
} from './schemas'
