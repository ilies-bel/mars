/**
 * Chat persistence layer — `chat_threads` and `chat_messages` tables in mars.db.
 *
 * Follow the same idempotent-init pattern as `action-queue.ts`: every exported
 * function calls `await initChatStore()` as its first statement; the init is a
 * no-op after the first call. The `resolveStateClient` function (not its result)
 * is stored so the DB client is resolved lazily and tests can reset it via
 * `vi.resetModules()`.
 */

import { randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client'

const stateClient = resolveStateClient

let initialised = false

export const initChatStore = async (): Promise<void> => {
  if (initialised) return
  const c = stateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES chat_threads(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      segments TEXT,
      created_at TEXT NOT NULL
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_id ON chat_messages(thread_id)`,
  )
  initialised = true
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ThreadStatus = 'idle' | 'running'
export type MessageRole = 'user' | 'assistant'

export interface ChatThread {
  id: string
  title: string
  session_id: string | null
  status: ThreadStatus
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: string
  thread_id: string
  role: MessageRole
  content: string
  segments: unknown | null
  created_at: string
}

export interface ThreadPreview extends ChatThread {
  /** Text of the most recent message, or null when the thread has no messages. */
  last_message: string | null
}

export interface ThreadWithMessages {
  thread: ChatThread
  messages: ChatMessage[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const now = (): string => new Date().toISOString()

const rowToThread = (row: Record<string, unknown>): ChatThread => ({
  id: row.id as string,
  title: row.title as string,
  session_id: (row.session_id as string | null) ?? null,
  status: row.status as ThreadStatus,
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
})

const rowToMessage = (row: Record<string, unknown>): ChatMessage => {
  const rawSegments = row.segments as string | null
  return {
    id: row.id as string,
    thread_id: row.thread_id as string,
    role: row.role as MessageRole,
    content: row.content as string,
    segments: rawSegments != null ? (JSON.parse(rawSegments) as unknown) : null,
    created_at: row.created_at as string,
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new chat thread. `title` defaults to an empty string when omitted —
 * callers can update it later via {@link updateThreadTitle}.
 */
export const createThread = async (title?: string): Promise<ChatThread> => {
  await initChatStore()
  const c = stateClient()
  const id = randomUUID()
  const ts = now()
  const threadTitle = title ?? ''
  await c.execute({
    sql: `INSERT INTO chat_threads (id, title, session_id, status, created_at, updated_at)
          VALUES (?, ?, NULL, 'idle', ?, ?)`,
    args: [id, threadTitle, ts, ts],
  })
  return { id, title: threadTitle, session_id: null, status: 'idle', created_at: ts, updated_at: ts }
}

/**
 * List all threads newest-first, each augmented with the text of its most recent
 * message (or `null` when the thread has no messages yet).
 */
export const listThreads = async (): Promise<ThreadPreview[]> => {
  await initChatStore()
  const c = stateClient()
  const result = await c.execute(`
    SELECT t.*,
           (SELECT content
              FROM chat_messages m
             WHERE m.thread_id = t.id
             ORDER BY m.rowid DESC
             LIMIT 1) AS last_message
      FROM chat_threads t
     ORDER BY t.rowid DESC
  `)
  return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
    ...rowToThread(row),
    last_message: (row.last_message as string | null) ?? null,
  }))
}

/**
 * Fetch a single thread together with all its messages in chronological order,
 * or `null` when no thread with `id` exists.
 */
export const getThread = async (id: string): Promise<ThreadWithMessages | null> => {
  await initChatStore()
  const c = stateClient()
  const threadResult = await c.execute({
    sql: `SELECT * FROM chat_threads WHERE id = ?`,
    args: [id],
  })
  if (threadResult.rows.length === 0) return null
  const thread = rowToThread(threadResult.rows[0] as unknown as Record<string, unknown>)

  const msgResult = await c.execute({
    sql: `SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY rowid ASC`,
    args: [id],
  })
  const messages = (msgResult.rows as unknown as Record<string, unknown>[]).map(rowToMessage)
  return { thread, messages }
}

/**
 * Append a message to an existing thread. Also bumps `updated_at` on the parent
 * thread so `listThreads` ordering stays accurate.
 */
export const appendMessage = async (
  threadId: string,
  role: MessageRole,
  content: string,
  segments?: unknown,
): Promise<ChatMessage> => {
  await initChatStore()
  const c = stateClient()
  const id = randomUUID()
  const ts = now()
  const segmentsJson = segments !== undefined ? JSON.stringify(segments) : null
  await c.execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, threadId, role, content, segmentsJson, ts],
  })
  await c.execute({
    sql: `UPDATE chat_threads SET updated_at = ? WHERE id = ?`,
    args: [ts, threadId],
  })
  return {
    id,
    thread_id: threadId,
    role,
    content,
    segments: segments !== undefined ? segments : null,
    created_at: ts,
  }
}

/** Rename a thread. No-op when the thread does not exist. */
export const updateThreadTitle = async (id: string, title: string): Promise<void> => {
  await initChatStore()
  const c = stateClient()
  await c.execute({
    sql: `UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?`,
    args: [title, now(), id],
  })
}

/**
 * Delete a thread and cascade-delete all its messages. No-op when the thread
 * does not exist.
 */
export const deleteThread = async (id: string): Promise<void> => {
  await initChatStore()
  const c = stateClient()
  await c.execute({ sql: `DELETE FROM chat_messages WHERE thread_id = ?`, args: [id] })
  await c.execute({ sql: `DELETE FROM chat_threads WHERE id = ?`, args: [id] })
}

/** Transition a thread between `'idle'` and `'running'` states. */
export const setThreadStatus = async (id: string, status: ThreadStatus): Promise<void> => {
  await initChatStore()
  const c = stateClient()
  await c.execute({
    sql: `UPDATE chat_threads SET status = ?, updated_at = ? WHERE id = ?`,
    args: [status, now(), id],
  })
}

/** Bind (or unbind) a Claude session ID to a thread. */
export const setThreadSession = async (id: string, sessionId: string | null): Promise<void> => {
  await initChatStore()
  const c = stateClient()
  await c.execute({
    sql: `UPDATE chat_threads SET session_id = ?, updated_at = ? WHERE id = ?`,
    args: [sessionId, now(), id],
  })
}
