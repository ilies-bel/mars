import type { ColumnKey, Role, Snapshot, Task, UITask } from './types'

const titleFromPrompt = (prompt: string): string => {
  const first = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  return first.length > 0 ? first : prompt.trim()
}

const roleFromTask = (t: Task): Role => {
  switch (t.status) {
    case 'running':
      return 'builder'
    case 'verifying':
      return 'reviewer'
    case 'merging':
    case 'vega-reconciling':
      return 'orchestrator'
    case 'draft':
    case 'queued':
      return 'planner'
    case 'blocked':
    case 'done':
    case 'failed':
    case 'dropped':
    case 'under_investigation':
      return 'orchestrator'
  }
}

const columnFor = (t: Task): ColumnKey | null => {
  switch (t.status) {
    case 'draft':
    case 'dropped':
    case 'under_investigation':
      // 'under_investigation' is a parked state — operator clicked Investigate
      // on a stale-worktree alert; task is not actively in-flight so it does
      // not appear in the Kanban board.
      return null
    case 'queued':
      return 'backlog'
    case 'running':
    case 'verifying':
    case 'merging':
    case 'vega-reconciling':
    case 'blocked':
      return 'in_progress'
    case 'done':
    case 'failed':
      return 'done'
  }
}

const toUI = (t: Task): UITask => ({
  id: t.id,
  title: titleFromPrompt(t.prompt),
  status: t.status,
  role: roleFromTask(t),
  failed: t.status === 'failed',
  dropReason: t.dropReason ?? null,
  retryCount: t.retryCount ?? 0,
  blockerTaskId: t.blockerTaskId ?? null,
  spec: t.spec ?? null,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
})

export const groupTasks = (tasks: Task[]): Snapshot => {
  const columns: Snapshot['columns'] = {
    backlog: [],
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
  const byUpdatedDesc = (a: UITask, b: UITask): number =>
    b.updatedAt.localeCompare(a.updatedAt)
  columns.backlog.sort(byUpdatedDesc)
  columns.in_progress.sort(byUpdatedDesc)
  columns.done.sort(byUpdatedDesc)
  return { columns, counts: { inProgress, todo, done } }
}
