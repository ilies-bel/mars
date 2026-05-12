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
  fixForTaskId: string | null
  failureSignature: string | null
  originId: string
  priority: number
  createdAt: string
  updatedAt: string
}

export const MIN_PRIORITY = 0
export const MAX_PRIORITY = 3

export const validatePriority = (value: number): void => {
  if (!Number.isInteger(value) || value < MIN_PRIORITY || value > MAX_PRIORITY) {
    throw new Error(
      `priority must be an integer in ${MIN_PRIORITY}..${MAX_PRIORITY}; got ${value}`,
    )
  }
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
  if (!names.has('fix_for_task_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN fix_for_task_id TEXT`)
  }
  if (!names.has('failure_signature')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN failure_signature TEXT`)
  }
  if (!names.has('priority')) {
    // CHECK constraint cannot be added via ALTER TABLE in SQLite; the
    // application-level validatePriority() guards inserts/updates instead.
    await c.execute(
      `ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
    )
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks(priority DESC, created_at ASC)`,
  )
  // origin_id: stable id of the originating row (idea or self-task) for an
  // arc of work. @libsql/client does not honour `DEFAULT (id)` self-reference
  // reliably, so the column is added without a default and back/forward-filled
  // explicitly: backfill old rows below, populate new rows in enqueueTask.
  if (!names.has('origin_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN origin_id TEXT`)
    await c.execute(`UPDATE tasks SET origin_id = id WHERE origin_id IS NULL`)
  }
  // parent_idea_id: link from a task to the PRD it slices. NULL for direct
  // `mars task add` rows. slice_index records which slice this is within
  // the PRD (1..N), again NULL for direct tasks.
  if (!names.has('parent_idea_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN parent_idea_id TEXT`)
  }
  if (!names.has('slice_index')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN slice_index INTEGER`)
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_fix_for ON tasks(fix_for_task_id, failure_signature)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_origin_id ON tasks(origin_id)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_parent_idea_id ON tasks(parent_idea_id)`,
  )
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
  // Migrate legacy `tasks.blocker_id` -> `task_blockers` rows. blocker_id used
  // to point into task_suggestions; the fix task itself is reachable via the
  // suggestion's created_task_id. Where the suggestion no longer exists or
  // has no created_task_id, the link is dropped (the dependent task is left
  // blocked but with no recorded blocker — `mars unblock` is the escape
  // hatch). After backfill the column is dropped to keep the schema honest.
  if (names.has('blocker_id')) {
    const sugTable = await c.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_suggestions'`,
    )
    if (sugTable.rows.length > 0) {
      const linkRows = await c.execute(`
        SELECT t.id AS task_id, s.created_task_id AS fix_task_id
          FROM tasks t
          JOIN task_suggestions s ON s.id = t.blocker_id
         WHERE t.blocker_id IS NOT NULL
           AND s.created_task_id IS NOT NULL
      `)
      const now = new Date().toISOString()
      for (const row of linkRows.rows) {
        const r = row as unknown as { task_id: string; fix_task_id: string }
        const fixTask = await c.execute({
          sql: `SELECT 1 FROM tasks WHERE id = ?`,
          args: [r.fix_task_id],
        })
        if (fixTask.rows.length === 0) continue
        await c.execute({
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
                VALUES (?, ?, ?)`,
          args: [r.task_id, r.fix_task_id, now],
        })
      }
    }
    await c.execute(`UPDATE tasks SET blocker_id = NULL`)
    await c.execute(`ALTER TABLE tasks DROP COLUMN blocker_id`)
  }
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_transcripts (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      conversation_json TEXT NOT NULL,
      verify_output TEXT,
      bytes INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_transcripts_recorded_at ON task_transcripts(recorded_at)
  `)
  await healBlobPrompts(c)
}

const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024
const HALF_WINDOW_BYTES = 1 * 1024 * 1024

export const capConversationJson = (json: string): string => {
  if (json.length <= MAX_CONVERSATION_BYTES) return json
  const head = json.slice(0, HALF_WINDOW_BYTES)
  const tail = json.slice(json.length - HALF_WINDOW_BYTES)
  const skipped = json.length - head.length - tail.length
  const marker = JSON.stringify({ truncated: true, skippedBytes: skipped })
  return `${head}\n${marker}\n${tail}`
}

export interface UpsertTranscriptInput {
  taskId: string
  conversationJson?: string
  verifyOutput?: string | null
}

export const upsertTranscript = async (
  input: UpsertTranscriptInput,
): Promise<void> => {
  await initQueue()
  const c = getClient()
  const now = new Date().toISOString()

  if (input.conversationJson !== undefined) {
    const capped = capConversationJson(input.conversationJson)
    await c.execute({
      sql: `INSERT INTO task_transcripts
              (task_id, conversation_json, verify_output, bytes, recorded_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
              conversation_json = excluded.conversation_json,
              bytes             = excluded.bytes,
              recorded_at       = excluded.recorded_at`,
      args: [input.taskId, capped, input.verifyOutput ?? null, capped.length, now],
    })
    return
  }

  if (input.verifyOutput !== undefined) {
    const cappedVerify =
      input.verifyOutput === null
        ? null
        : input.verifyOutput.length > 64 * 1024
          ? input.verifyOutput.slice(0, 64 * 1024)
          : input.verifyOutput
    await c.execute({
      sql: `UPDATE task_transcripts
              SET verify_output = ?, recorded_at = ?
            WHERE task_id = ?`,
      args: [cappedVerify, now, input.taskId],
    })
  }
}

export interface TaskTranscriptRow {
  taskId: string
  conversationJson: string
  verifyOutput: string | null
  bytes: number
  recordedAt: string
}

export const getTranscript = async (
  taskId: string,
): Promise<TaskTranscriptRow | null> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT task_id, conversation_json, verify_output, bytes, recorded_at
            FROM task_transcripts
           WHERE task_id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as Record<string, unknown>
  return {
    taskId: row.task_id as string,
    conversationJson: row.conversation_json as string,
    verifyOutput: (row.verify_output as string | null) ?? null,
    bytes: Number(row.bytes ?? 0),
    recordedAt: row.recorded_at as string,
  }
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
    fixForTaskId: (row.fix_for_task_id as string | null) ?? null,
    failureSignature: (row.failure_signature as string | null) ?? null,
    originId: ((row.origin_id as string | null) ?? (row.id as string)),
    priority: Number(row.priority ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export interface EnqueueTaskOptions {
  skipTriage?: boolean
  author?: Author
  originId?: string
  priority?: number
  parentIdeaId?: string
  sliceIndex?: number
}

export const enqueueTask = async (
  prompt: string,
  plan?: TaskPlan,
  opts?: EnqueueTaskOptions,
): Promise<Task> => {
  const promptText = coerceToString(prompt, 'enqueueTask: prompt')
  if (opts?.priority !== undefined) validatePriority(opts.priority)
  await initQueue()
  const id = `mars-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const status: TaskStatus = opts?.skipTriage ? 'queued' : 'draft'
  const authorKind = opts?.author?.kind ?? null
  const authorName = opts?.author?.name ?? null
  const originId = opts?.originId ?? id
  const priority = opts?.priority ?? 0
  const parentIdeaId = opts?.parentIdeaId ?? null
  const sliceIndex = opts?.sliceIndex ?? null
  await getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, author_kind, author_name, origin_id, priority, parent_idea_id, slice_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      promptText,
      status,
      plan?.functional ?? null,
      plan?.technical ?? null,
      authorKind,
      authorName,
      originId,
      priority,
      parentIdeaId,
      sliceIndex,
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
        sql: `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC`,
        args: [status],
      })
    : await getClient().execute(
        `SELECT * FROM tasks ORDER BY priority DESC, created_at ASC`,
      )
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
}

export const setTaskPriority = async (
  id: string,
  priority: number,
): Promise<Task> => {
  validatePriority(priority)
  await initQueue()
  const c = getClient()
  const before = await c.execute({
    sql: `SELECT status FROM tasks WHERE id = ?`,
    args: [id],
  })
  if (before.rows.length === 0) {
    throw new Error(`task ${id} not found`)
  }
  const status = (before.rows[0] as unknown as { status: string }).status
  if (status !== 'queued') {
    throw new Error(
      `task ${id} is ${status}; only queued tasks can be reprioritized`,
    )
  }
  const now = new Date().toISOString()
  await c.execute({
    sql: `UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`,
    args: [priority, now, id],
  })
  const r = await c.execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [id],
  })
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
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

export const insertReflectionTask = async (corpusSize: number): Promise<string> => {
  await initQueue()
  const id = `reflect-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const prompt = `mars reflect run over ${corpusSize} task(s) at ${now}`
  await getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)`,
    args: [id, prompt, id, now, now],
  })
  return id
}

export const addBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  if (blockerIds.length === 0) return
  await initQueue()
  const c = getClient()

  const taskRow = await c.execute({
    sql: `SELECT 1 FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (taskRow.rows.length === 0) {
    throw new Error(`task ${taskId} not found`)
  }
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of blockerIds) {
    if (id === taskId) continue
    if (seen.has(id)) continue
    seen.add(id)
    const r = await c.execute({
      sql: `SELECT 1 FROM tasks WHERE id = ?`,
      args: [id],
    })
    if (r.rows.length === 0) {
      throw new Error(`blocker ${id} not found`)
    }
    unique.push(id)
  }

  if (unique.length === 0) return
  const now = new Date().toISOString()
  const stmts = unique.map((blockerId) => ({
    sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
    args: [taskId, blockerId, now],
  }))
  await c.batch(stmts, 'write')
}

export const removeBlocker = async (
  taskId: string,
  blockerId: string,
): Promise<{ removed: boolean }> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
    args: [taskId, blockerId],
  })
  return { removed: r.rowsAffected > 0 }
}

export const clearBlockers = async (taskId: string): Promise<void> => {
  await initQueue()
  await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
}

export interface UnblockTaskResult {
  taskId: string
  outcome: 'unblocked' | 'noop'
  previousStatus: string
}

/**
 * Manual escape hatch: flip a `blocked` task to `failed`, clearing any
 * `task_blockers` rows pointing from it. Used by `mars unblock <id>` so users
 * do not need to reach for sqlite when the row has slipped into an
 * inconsistent state (stale junction rows after a blocker was purged).
 */
export const unblockTask = async (
  taskId: string,
): Promise<UnblockTaskResult> => {
  await initQueue()
  const c = getClient()
  const before = await c.execute({
    sql: `SELECT status FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (before.rows.length === 0) {
    throw new Error(`task ${taskId} not found`)
  }
  const previousStatus = (before.rows[0] as unknown as { status: string }).status
  if (previousStatus !== 'blocked') {
    return { taskId, outcome: 'noop', previousStatus }
  }
  const now = new Date().toISOString()
  await c.execute({
    sql: `UPDATE tasks
             SET status = 'failed',
                 updated_at = ?
           WHERE id = ? AND status = 'blocked'`,
    args: [now, taskId],
  })
  await c.execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
  return { taskId, outcome: 'unblocked', previousStatus }
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
