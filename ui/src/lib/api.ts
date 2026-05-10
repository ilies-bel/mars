import type { DraftFeature, Task } from './types'

const BASE = import.meta.env.VITE_API_BASE ?? ''

const fetchJson = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${BASE}${path}`)
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`)
  const ct = r.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    throw new Error(
      `GET ${path} → expected JSON but got ${ct || 'unknown'} (is the mars-ui API server running on :7777?)`,
    )
  }
  return (await r.json()) as T
}

export const fetchTasks = async (): Promise<Task[]> => {
  const json = await fetchJson<{ tasks: Task[] }>('/api/tasks')
  return json.tasks
}

export interface StaleWorktree {
  taskId: string
  status: string
  ageHours: number
  updatedAt: string
}

export interface TodoPayload {
  drafts: DraftFeature[]
  staleWorktrees: StaleWorktree[]
}

export const fetchTodo = async (): Promise<TodoPayload> => {
  return fetchJson<TodoPayload>('/api/todo')
}

export const eventsUrl = (): string => `${BASE}/events`
