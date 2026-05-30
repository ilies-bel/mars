import type { ZodType } from 'zod'
import {
  actionQueueResponseSchema,
  agentsResponseSchema,
  eventsResponseSchema,
  failureReasonsResponseSchema,
  kpisResponseSchema,
  originsResponseSchema,
  progressResponseSchema,
  projectsResponseSchema,
  tasksResponseSchema,
  todoResponseSchema,
  workerSessionsResponseSchema,
  type ActionQueueItem,
  type Agent,
  type EventsResponse,
  type FailureReasonCatalogEntry,
  type Kpi,
  type OriginsResponse,
  type ProgressProposalNode,
  type ProgressTask,
  type Project,
  type Task,
  type TodoPayload,
  type WorkerSession,
} from './schemas'

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

const fetchJson = async <T>(path: string, schema: ZodType<T>): Promise<T> => {
  let r: Response
  try {
    r = await fetch(`${BASE}${path}`)
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(
        `GET ${path} → cannot reach the mars-ui API server. Start it with \`cd ui && npm run dev:server\` (or \`npm run dev:all\` to run UI + API together).`,
      )
    }
    throw err
  }
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`)
  const ct = r.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    throw new Error(
      `GET ${path} → expected JSON but got ${ct || 'unknown'} (is the mars-ui API server running on :7777?)`,
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
  failedWindowMs?: number | null,
  projectId?: string,
): Promise<{ tasks: ProgressTask[]; proposals: ProgressProposalNode[] }> => {
  let path = '/api/progress'
  if (failedWindowMs === null) {
    path += '?failedWindow=all'
  } else if (failedWindowMs !== undefined) {
    path += `?failedWindow=${failedWindowMs}`
  }
  path = appendProject(path, projectId)
  const data = await fetchJson(path, progressResponseSchema)
  return { tasks: data.tasks, proposals: data.proposals }
}

export const fetchTodo = async (projectId?: string): Promise<TodoPayload> => {
  return fetchJson(appendProject('/api/todo', projectId), todoResponseSchema)
}

export const fetchActionQueue = async (projectId?: string): Promise<ActionQueueItem[]> => {
  return fetchJson(appendProject('/api/action-queue/action-queue', projectId), actionQueueResponseSchema)
}

export const dismissActionQueueItem = async (id: string): Promise<void> => {
  const r = await fetch(`${BASE}/api/action-queue/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/action-queue/dismiss → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

export const ackActionQueueItem = async (id: string): Promise<void> => {
  const r = await fetch(`${BASE}/api/action-queue/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/action-queue/ack → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

export const resolveActionQueueItem = async (id: string): Promise<void> => {
  const r = await fetch(`${BASE}/api/action-queue/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/action-queue/resolve → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

export const fetchAgents = async (projectId?: string): Promise<Agent[]> => {
  const json = await fetchJson(appendProject('/api/agents', projectId), agentsResponseSchema)
  return json.agents
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
 * Invoke a recovery action against the daemon (via the UI server proxy). `op`
 * is the registry verb; `entityId` is the task/worktree id, omitted for
 * process-level ops (`restart-daemon`). Throws with the daemon's error message
 * on a non-2xx so the caller can surface it.
 */
export const invokeAction = async (
  op: string,
  entityId?: string,
): Promise<void> => {
  const r = await fetch(`${BASE}/api/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, entityId }),
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(
      `${op} failed (${r.status})${body.error ? `: ${body.error}` : ''}`,
    )
  }
}

export const eventsUrl = (): string => `${BASE}/events`

/**
 * Fetch the resolved failure-reason catalog from the daemon (proxied through
 * the UI server). The catalog is keyed by `code`. The actionQueue detail panel
 * looks up `failureReasonCode` to render `Reason: <userMessage>` plus the
 * `availableActions` button list. Falls back to the catalog's `unknown`
 * entry when the code is absent or not in the catalog.
 */
export const fetchFailureReasons = async (
  projectId?: string,
): Promise<FailureReasonCatalogEntry[]> => {
  return fetchJson(appendProject('/api/failure-reasons', projectId), failureReasonsResponseSchema)
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

export const dismissTodoItem = async (
  id: string,
  kind: 'draft' | 'stale',
): Promise<void> => {
  const r = await fetch(`${BASE}/api/todo/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, kind }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/todo/dismiss → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

export type {
  ActionQueueItem,
  Agent,
  DaemonHealth,
  EventsResponse,
  FailureReasonCatalogEntry,
  Kpi,
  OriginsResponse,
  ProgressProposalNode,
  Project,
  SessionOutcome,
  StaleWorktree,
  TodoPayload,
  TraceEvent,
  WorkerSession,
} from './schemas'
