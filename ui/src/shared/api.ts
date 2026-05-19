import type { ZodType } from 'zod'
import {
  agentsResponseSchema,
  inboxResponseSchema,
  progressResponseSchema,
  tasksResponseSchema,
  todoResponseSchema,
  type Agent,
  type InboxPayload,
  type ProgressTask,
  type Task,
  type TodoPayload,
} from './schemas'

const BASE = import.meta.env.VITE_API_BASE ?? ''

const fetchJson = async <T>(path: string, schema: ZodType<T>): Promise<T> => {
  const r = await fetch(`${BASE}${path}`)
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

export const fetchProgress = async (): Promise<ProgressTask[]> => {
  const json = await fetchJson('/api/progress', progressResponseSchema)
  return json.tasks
}

export const fetchTodo = async (): Promise<TodoPayload> => {
  return fetchJson('/api/todo', todoResponseSchema)
}

export const fetchInbox = async (): Promise<InboxPayload> => {
  return fetchJson('/api/inbox', inboxResponseSchema)
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

export type { Agent, InboxPayload, StaleWorktree, TodoPayload } from './schemas'
