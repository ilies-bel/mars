import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { resolveContext } from './context'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'done'
  | 'failed'

export interface TaskPlan {
  functional: string
  technical: string
}

export interface Task {
  id: string
  prompt: string
  status: TaskStatus
  plan: TaskPlan | null
  branch: string | null
  worktreePath: string | null
  claudeSessionId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

let clientSingleton: Client | null = null

export const getClient = (): Client => {
  if (!clientSingleton) {
    const { queueDbPath } = resolveContext()
    clientSingleton = createClient({ url: `file:${queueDbPath}` })
  }
  return clientSingleton
}

export const initQueue = async (): Promise<void> => {
  const c = getClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_functional TEXT,
      plan_technical TEXT,
      branch TEXT,
      worktree_path TEXT,
      claude_session_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  // Migrate existing databases: add columns if missing.
  const cols = await c.execute(`PRAGMA table_info(tasks)`)
  const names = new Set(cols.rows.map((r) => (r as unknown as { name: string }).name))
  if (!names.has('plan_functional')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN plan_functional TEXT`)
  }
  if (!names.has('plan_technical')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN plan_technical TEXT`)
  }
  if (!names.has('claude_session_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN claude_session_id TEXT`)
  }
}

const rowToTask = (row: Record<string, unknown>): Task => {
  const functional = (row.plan_functional as string | null) ?? null
  const technical = (row.plan_technical as string | null) ?? null
  const plan: TaskPlan | null =
    functional !== null || technical !== null
      ? { functional: functional ?? '', technical: technical ?? '' }
      : null
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    status: row.status as TaskStatus,
    plan,
    branch: (row.branch as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    claudeSessionId: (row.claude_session_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export const enqueueTask = async (
  prompt: string,
  plan?: TaskPlan,
): Promise<Task> => {
  await initQueue()
  const id = randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
    args: [id, prompt, plan?.functional ?? null, plan?.technical ?? null, now, now],
  })
  const r = await getClient().execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [id],
  })
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

export const updateTask = async (
  id: string,
  patch: Partial<
    Pick<Task, 'status' | 'plan' | 'branch' | 'worktreePath' | 'claudeSessionId' | 'error'>
  >,
): Promise<void> => {
  const fields: string[] = []
  const args: unknown[] = []

  if (patch.status !== undefined) {
    fields.push('status = ?')
    args.push(patch.status)
  }
  if (patch.plan !== undefined) {
    fields.push('plan_functional = ?')
    args.push(patch.plan?.functional ?? null)
    fields.push('plan_technical = ?')
    args.push(patch.plan?.technical ?? null)
  }
  if (patch.branch !== undefined) {
    fields.push('branch = ?')
    args.push(patch.branch)
  }
  if (patch.worktreePath !== undefined) {
    fields.push('worktree_path = ?')
    args.push(patch.worktreePath)
  }
  if (patch.claudeSessionId !== undefined) {
    fields.push('claude_session_id = ?')
    args.push(patch.claudeSessionId)
  }
  if (patch.error !== undefined) {
    fields.push('error = ?')
    args.push(patch.error)
  }
  fields.push('updated_at = ?')
  args.push(new Date().toISOString())
  args.push(id)

  await getClient().execute({
    sql: `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`,
    args: args as never,
  })
}

export const getTask = async (id: string): Promise<Task | null> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

export const listTasks = async (status?: TaskStatus): Promise<Task[]> => {
  await initQueue()
  const r = status
    ? await getClient().execute({
        sql: `SELECT * FROM tasks WHERE status = ? ORDER BY created_at`,
        args: [status],
      })
    : await getClient().execute(`SELECT * FROM tasks ORDER BY created_at`)
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
}
