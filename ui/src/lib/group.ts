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
    case 'done':
    case 'failed':
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
  createdAt: t.createdAt,
})

export const groupTasks = (tasks: Task[]): Snapshot => {
  const columns: Snapshot['columns'] = {
    backlog: [],
    planned: [],
    in_progress: [],
    done: [],
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
    else if (key === 'done') done++
    else todo++
  }
  return { columns, counts: { inProgress, todo, done } }
}
