import type { ZodType } from 'zod'
import {
  actionQueueResponseSchema,
  agentsResponseSchema,
  progressResponseSchema,
  tasksResponseSchema,
  todoResponseSchema,
  type ActionQueueItem,
  type Agent,
  type ProgressProposalNode,
  type ProgressTask,
  type Task,
  type TodoPayload,
} from './schemas'

const BASE = import.meta.env.VITE_API_BASE ?? ''

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

export const fetchTasks = async (): Promise<Task[]> => {
  const json = await fetchJson('/api/tasks', tasksResponseSchema)
  return json.tasks
}

export const fetchProgress = async (): Promise<{
  tasks: ProgressTask[]
  proposals: ProgressProposalNode[]
}> => {
  const json = await fetchJson('/api/progress', progressResponseSchema)
  return { tasks: json.tasks, proposals: json.proposals }
}

export const fetchTodo = async (): Promise<TodoPayload> => {
  return fetchJson('/api/todo', todoResponseSchema)
}

export const fetchActionQueue = async (): Promise<ActionQueueItem[]> => {
  return fetchJson('/api/inbox/action-queue', actionQueueResponseSchema)
}

export const dismissInboxItem = async (id: string): Promise<void> => {
  const r = await fetch(`${BASE}/api/inbox/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/inbox/dismiss → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

export const ackInboxItem = async (id: string): Promise<void> => {
  const r = await fetch(`${BASE}/api/inbox/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/inbox/ack → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

export const resolveInboxItem = async (id: string): Promise<void> => {
  const r = await fetch(`${BASE}/api/inbox/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(
      `POST /api/inbox/resolve → ${r.status}${text ? `: ${text}` : ''}`,
    )
  }
}

export const fetchAgents = async (): Promise<Agent[]> => {
  const json = await fetchJson('/api/agents', agentsResponseSchema)
  return json.agents
}

export const eventsUrl = (): string => `${BASE}/events`

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
  ProgressProposalNode,
  StaleWorktree,
  TodoPayload,
} from './schemas'
