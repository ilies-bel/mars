import type { ColumnKey, Role, Snapshot, Task, UITask } from './types'

const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return first.length > 0 ? first : prompt.trim()
}

const shortId = (id: string): string => `T${id.slice(0, 8)}`

const roleFromTask = (t: Task): Role => {
  switch (t.status) {
    case 'running':
      return 'builder'
    case 'verifying':
      return 'reviewer'
    case 'merging':
      return 'orchestrator'
    case 'draft':
    case 'queued':
      return 'planner'
    case 'blocked':
    case 'done':
    case 'failed':
    case 'dropped':
      return 'orchestrator'
  }
}

const columnFor = (t: Task): ColumnKey | null => {
  switch (t.status) {
    case 'draft':
      return null
    case 'queued':
      return t.plan ? 'planned' : 'backlog'
    case 'running':
    case 'verifying':
    case 'merging':
      return 'in_progress'
    case 'blocked':
      return 'blocked'
    case 'dropped':
      return 'dropped'
    case 'done':
    case 'failed':
      return 'done'
  }
}

const toUI = (t: Task): UITask => ({
  id: t.id,
  shortId: shortId(t.id),
  title: titleFromPrompt(t.prompt),
  status: t.status,
  role: roleFromTask(t),
  failed: t.status === 'failed',
  dropReason: t.dropReason ?? null,
  retryCount: t.retryCount ?? 0,
  blockerSuggestionId: t.blockerSuggestionId ?? null,
  createdAt: t.createdAt,
})

export const groupTasks = (tasks: Task[]): Snapshot => {
  const columns: Snapshot['columns'] = {
    backlog: [],
    planned: [],
    in_progress: [],
    blocked: [],
    done: [],
    dropped: [],
  }
  let inProgress = 0
  let todo = 0
  let done = 0
  for (const t of tasks) {
    const key = columnFor(t)
    if (key === null) continue
    const ui = toUI(t)
    columns[key].push(ui)
    if (key === 'in_progress') inProgress++
    else if (key === 'done' || key === 'dropped') done++
    else if (key === 'blocked') todo++
    else todo++
  }
  return { columns, counts: { inProgress, todo, done } }
}
