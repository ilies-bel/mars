import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { resolveContext } from './context'

export type TaskStatus =
  | 'queued'
  | 'ready'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'done'
  | 'failed'

export type QuestionCategory = 'scope' | 'tech' | 'ux' | 'risk'

export interface QuestionInput {
  taskId: string
  question: string
  rationale: string | null
  category: QuestionCategory | null
}

export interface SuggestionInput {
  sourceTaskId: string
  title: string
  prompt: string
  rationale: string | null
}

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
  await c.execute(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      question TEXT NOT NULL,
      rationale TEXT,
      category TEXT,
      answer TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_questions_task_id ON questions(task_id)
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_suggestions (
      id TEXT PRIMARY KEY,
      source_task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_task_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_task_id) REFERENCES tasks(id)
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_suggestions_source_task_id ON task_suggestions(source_task_id)
  `)
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

export const deleteTask = async (id: string): Promise<void> => {
  await initQueue()
  await getClient().execute({
    sql: `DELETE FROM tasks WHERE id = ?`,
    args: [id],
  })
}

export const claimReadyTask = async (id: string): Promise<Task | null> => {
  await initQueue()
  const now = new Date().toISOString()
  const upd = await getClient().execute({
    sql: `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'ready'`,
    args: [now, id],
  })
  if (upd.rowsAffected === 0) return null
  const r = await getClient().execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

export const insertQuestion = async (input: QuestionInput): Promise<void> => {
  await initQueue()
  const id = randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `INSERT INTO questions (id, task_id, question, rationale, category, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    args: [id, input.taskId, input.question, input.rationale, input.category, now],
  })
}

export const insertSuggestion = async (input: SuggestionInput): Promise<void> => {
  await initQueue()
  const id = randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `INSERT INTO task_suggestions (id, source_task_id, title, prompt, rationale, status, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)`,
    args: [id, input.sourceTaskId, input.title, input.prompt, input.rationale, now],
  })
}

export const clearQuestions = async (taskId: string): Promise<void> => {
  await initQueue()
  await getClient().execute({
    sql: `DELETE FROM questions WHERE task_id = ?`,
    args: [taskId],
  })
}

export const clearSuggestions = async (taskId: string): Promise<void> => {
  await initQueue()
  await getClient().execute({
    sql: `DELETE FROM task_suggestions WHERE source_task_id = ?`,
    args: [taskId],
  })
}
