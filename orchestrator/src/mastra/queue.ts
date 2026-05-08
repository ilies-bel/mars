import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { resolveContext } from './context'
import type { Author, AuthorKind } from './author'

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'ready'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'blocked'

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
  author: Author | null
  dropReason: string | null
  retryCount: number
  blockerId: string | null
  fixForTaskId: string | null
  failureSignature: string | null
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
      drop_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
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
  if (!names.has('author_kind')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN author_kind TEXT`)
  }
  if (!names.has('author_name')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN author_name TEXT`)
  }
  if (!names.has('drop_reason')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN drop_reason TEXT`)
  }
  if (!names.has('retry_count')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`)
  }
  if (!names.has('blocker_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN blocker_id TEXT`)
  }
  if (!names.has('fix_for_task_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN fix_for_task_id TEXT`)
  }
  if (!names.has('failure_signature')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN failure_signature TEXT`)
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_fix_for ON tasks(fix_for_task_id, failure_signature)`,
  )
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
      kind TEXT NOT NULL DEFAULT 'reflection',
      created_task_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_task_id) REFERENCES tasks(id)
    )
  `)
  const sugCols = await c.execute(`PRAGMA table_info(task_suggestions)`)
  const sugNames = new Set(
    sugCols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!sugNames.has('kind')) {
    await c.execute(
      `ALTER TABLE task_suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'reflection'`,
    )
    await c.execute(
      `UPDATE task_suggestions SET kind = 'reflection' WHERE kind IS NULL`,
    )
  }
  if (!sugNames.has('failure_signature')) {
    await c.execute(
      `ALTER TABLE task_suggestions ADD COLUMN failure_signature TEXT`,
    )
  }
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_suggestions_source_task_id ON task_suggestions(source_task_id)
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_suggestions_failure_signature ON task_suggestions(failure_signature)
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_signals (
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (task_id, step_id)
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_signals_task_id ON task_signals(task_id)
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_blockers (
      task_id TEXT NOT NULL,
      blocker_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, blocker_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (blocker_task_id) REFERENCES tasks(id)
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_blockers_task ON task_blockers(task_id)
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_blockers_blocker ON task_blockers(blocker_task_id)
  `)
  await healBlobPrompts(c)
}

const healBlobPrompts = async (c: Client): Promise<void> => {
  const r = await c.execute(
    `SELECT count(*) AS n FROM tasks WHERE typeof(prompt) = 'blob'`,
  )
  const n = Number((r.rows[0] as unknown as { n: number | bigint }).n)
  if (n > 0) {
    await c.execute(
      `UPDATE tasks SET prompt = CAST(prompt AS TEXT) WHERE typeof(prompt) = 'blob'`,
    )
  }
}

const coerceToString = (value: unknown, label: string): string => {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder('utf-8').decode(value)
  if (value instanceof ArrayBuffer) {
    return new TextDecoder('utf-8').decode(new Uint8Array(value))
  }
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  throw new TypeError(
    `${label} must be a string; got ${value === null ? 'null' : typeof value}`,
  )
}

const rowToTask = (row: Record<string, unknown>): Task => {
  const functional = (row.plan_functional as string | null) ?? null
  const technical = (row.plan_technical as string | null) ?? null
  const plan: TaskPlan | null =
    functional !== null || technical !== null
      ? { functional: functional ?? '', technical: technical ?? '' }
      : null
  const authorKindRaw = (row.author_kind as string | null) ?? null
  const authorName = (row.author_name as string | null) ?? null
  const author: Author | null =
    authorKindRaw === 'human' || authorKindRaw === 'agent'
      ? { kind: authorKindRaw as AuthorKind, name: authorName ?? 'unknown' }
      : null
  return {
    id: row.id as string,
    prompt: coerceToString(row.prompt, 'rowToTask: prompt'),
    status: row.status as TaskStatus,
    plan,
    branch: (row.branch as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    claudeSessionId: (row.claude_session_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    author,
    dropReason: (row.drop_reason as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    blockerId: (row.blocker_id as string | null) ?? null,
    fixForTaskId: (row.fix_for_task_id as string | null) ?? null,
    failureSignature: (row.failure_signature as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export interface EnqueueTaskOptions {
  skipTriage?: boolean
  author?: Author
}

export const enqueueTask = async (
  prompt: string,
  plan?: TaskPlan,
  opts?: EnqueueTaskOptions,
): Promise<Task> => {
  const promptText = coerceToString(prompt, 'enqueueTask: prompt')
  await initQueue()
  const id = randomUUID().slice(0, 8)
  const now = new Date().toISOString()
  const status: TaskStatus = opts?.skipTriage ? 'queued' : 'draft'
  const authorKind = opts?.author?.kind ?? null
  const authorName = opts?.author?.name ?? null
  await getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, author_kind, author_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      promptText,
      status,
      plan?.functional ?? null,
      plan?.technical ?? null,
      authorKind,
      authorName,
      now,
      now,
    ],
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

  if (patch.status === 'done') {
    const dependents = await getClient().execute({
      sql: `SELECT DISTINCT task_id FROM task_blockers WHERE blocker_task_id = ?`,
      args: [id],
    })
    for (const row of dependents.rows) {
      const dependentId = (row as unknown as { task_id: string }).task_id
      await promoteDraftToQueued(dependentId)
    }
  }
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

export const insertReflectionTask = async (corpusSize: number): Promise<string> => {
  await initQueue()
  const id = `reflect-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const prompt = `mars reflect run over ${corpusSize} task(s) at ${now}`
  await getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at) VALUES (?, ?, 'done', ?, ?)`,
    args: [id, prompt, now, now],
  })
  return id
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

export const rejectSuggestion = async (id: string): Promise<void> => {
  await initQueue()
  const result = await getClient().execute({
    sql: `UPDATE task_suggestions SET status = 'rejected' WHERE id = ? AND status = 'proposed'`,
    args: [id],
  })
  if (result.rowsAffected === 0) {
    throw new Error(
      `no proposed suggestion with id=${id} (already accepted/rejected, or unknown id)`,
    )
  }
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

export const addBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  if (blockerIds.length === 0) return
  await initQueue()
  const now = new Date().toISOString()
  const c = getClient()
  for (const blockerId of blockerIds) {
    if (blockerId === taskId) continue
    await c.execute({
      sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
      args: [taskId, blockerId, now],
    })
  }
}

export const clearBlockers = async (taskId: string): Promise<void> => {
  await initQueue()
  await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
}

export const listBlockers = async (taskId: string): Promise<string[]> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT b.blocker_task_id AS id
            FROM task_blockers b
            JOIN tasks t ON t.id = b.blocker_task_id
           WHERE b.task_id = ? AND t.status != 'done'`,
    args: [taskId],
  })
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

export const hasIncompleteBlockers = async (taskId: string): Promise<boolean> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT 1
            FROM task_blockers b
            JOIN tasks t ON t.id = b.blocker_task_id
           WHERE b.task_id = ? AND t.status != 'done'
           LIMIT 1`,
    args: [taskId],
  })
  return r.rows.length > 0
}

export const promoteDraftToQueued = async (
  taskId: string,
): Promise<Task | null> => {
  await initQueue()
  const now = new Date().toISOString()
  const upd = await getClient().execute({
    sql: `UPDATE tasks
             SET status = 'queued', updated_at = ?
           WHERE id = ?
             AND status = 'draft'
             AND NOT EXISTS (
               SELECT 1 FROM task_blockers b
               JOIN tasks t ON t.id = b.blocker_task_id
               WHERE b.task_id = ? AND t.status != 'done'
             )`,
    args: [now, taskId, taskId],
  })
  if (upd.rowsAffected === 0) return null
  const r = await getClient().execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}
