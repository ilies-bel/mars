import type { Question, Task, TaskSuggestion } from './types'

const BASE = import.meta.env.VITE_API_BASE ?? ''

export const fetchTasks = async (): Promise<Task[]> => {
  const r = await fetch(`${BASE}/api/tasks`)
  if (!r.ok) throw new Error(`GET /api/tasks → ${r.status}`)
  const json = (await r.json()) as { tasks: Task[] }
  return json.tasks
}

export const fetchQuestions = async (): Promise<Question[]> => {
  const r = await fetch(`${BASE}/api/questions`)
  if (!r.ok) throw new Error(`GET /api/questions → ${r.status}`)
  const json = (await r.json()) as { questions: Question[] }
  return json.questions
}

export const fetchSuggestions = async (): Promise<TaskSuggestion[]> => {
  const r = await fetch(`${BASE}/api/suggestions`)
  if (!r.ok) throw new Error(`GET /api/suggestions → ${r.status}`)
  const json = (await r.json()) as { suggestions: TaskSuggestion[] }
  return json.suggestions
}

export const eventsUrl = (): string => `${BASE}/events`
