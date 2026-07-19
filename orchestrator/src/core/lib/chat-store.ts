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
  // Alert-thread columns — added via ALTER TABLE so existing DBs get them too.
  const cols = await c.execute(`PRAGMA table_info(chat_threads)`)
  const colNames = new Set(
    (cols.rows as unknown as Array<{ name: string }>).map((r) => r.name),
  )
  if (!colNames.has('origin')) {
    await c.execute(`ALTER TABLE chat_threads ADD COLUMN origin TEXT`)
  }
  if (!colNames.has('alert_item_id')) {
    await c.execute(`ALTER TABLE chat_threads ADD COLUMN alert_item_id TEXT`)
  }
  if (!colNames.has('alert_resolved')) {
    await c.execute(
      `ALTER TABLE chat_threads ADD COLUMN alert_resolved INTEGER NOT NULL DEFAULT 0`,
    )
  }
  if (!colNames.has('context_seeded')) {
    await c.execute(
      `ALTER TABLE chat_threads ADD COLUMN context_seeded INTEGER NOT NULL DEFAULT 0`,
    )
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_chat_threads_alert_item_id ON chat_threads(alert_item_id)`,
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
  /** 'alert' for proactive alert-origin threads; null for user-created threads. */
  origin: string | null
  /** The action-queue item id this thread tracks. Null for non-alert threads. */
  alert_item_id: string | null
  /** True when the underlying action-queue item has been resolved. */
  alert_resolved: boolean
  /**
   * True once the chat runner has injected the thread-context preamble into
   * the first claude prompt for this thread. Prevents the preamble from being
   * prepended on every subsequent turn.
   */
  context_seeded: boolean
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

/** Camelcase view shape served over the HTTP API (matches the UI's chatThreadSchema). */
export interface ChatThreadApiView {
  id: string
  title: string
  status: ThreadStatus
  createdAt: string
  updatedAt: string
  /** 'alert' for proactive threads; null for user-created threads. */
  origin: string | null
  /** The action-queue item id this thread tracks. */
  alertItemId: string | null
  /** True when the underlying action-queue item has been resolved. */
  alertResolved: boolean
}

/** Camelcase view shape for messages served over the HTTP API. */
export interface ChatMessageApiView {
  id: string
  threadId: string
  role: MessageRole
  segments: unknown[]
  createdAt: string
}

/** Convert a stored thread to its API view shape. */
export const toThreadApiView = (t: ChatThread): ChatThreadApiView => ({
  id: t.id,
  title: t.title,
  status: t.status,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  origin: t.origin,
  alertItemId: t.alert_item_id,
  alertResolved: t.alert_resolved,
})

/**
 * Convert a stored message to its API view shape.
 *
 * The runner persists segments using its internal field names, which differ
 * from the UI schema:
 *   runner `thinking.thinking` → UI `thinking.text`
 *   runner `tool_use.name`     → UI `tool_use.toolName`
 *
 * This function normalises those differences so the UI receives segments it
 * can parse without error.
 */
export const toMessageApiView = (m: ChatMessage): ChatMessageApiView => {
  const raw: unknown[] = Array.isArray(m.segments) ? (m.segments as unknown[]) : []
  const segments = raw.map((seg) => {
    if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) return seg
    const s = seg as Record<string, unknown>
    if (s['type'] === 'thinking' && typeof s['thinking'] === 'string') {
      return { type: 'thinking', text: s['thinking'] }
    }
    if (s['type'] === 'tool_use' && typeof s['name'] === 'string') {
      return {
        type: 'tool_use',
        id: typeof s['id'] === 'string' ? s['id'] : '',
        toolName: s['name'],
        input: s['input'] ?? null,
        isError: false,
        status: 'complete',
      }
    }
    return s
  })
  return {
    id: m.id,
    threadId: m.thread_id,
    role: m.role,
    segments,
    createdAt: m.created_at,
  }
}

/** One action button on an alert card. */
export interface AlertSegmentAction {
  op: string
  label: string
  style: 'primary' | 'destructive' | 'default'
}

/**
 * Alert segment stored on the opening assistant message of an alert-origin thread.
 * Mirrors the action-queue row enough to render a rich card without re-fetching
 * the action queue.
 */
export interface AlertSegment {
  type: 'alert'
  kind: string
  entityId: string
  priority: string
  title: string
  whyNow: string
  actions: AlertSegmentAction[]
  /** True once the underlying action-queue item has been superseded/resolved. */
  resolved: boolean
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
  origin: (row.origin as string | null) ?? null,
  alert_item_id: (row.alert_item_id as string | null) ?? null,
  alert_resolved: Boolean(row.alert_resolved),
  context_seeded: Boolean(row.context_seeded),
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
  return {
    id,
    title: threadTitle,
    session_id: null,
    status: 'idle',
    created_at: ts,
    updated_at: ts,
    origin: null,
    alert_item_id: null,
    alert_resolved: false,
    context_seeded: false,
  }
}

/**
 * List all threads, alert-origin unresolved threads first, then newest-first.
 * Each thread is augmented with the text of its most recent message.
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
     ORDER BY
       -- Alert threads that are not yet resolved sort first.
       CASE WHEN t.origin = 'alert' AND (t.alert_resolved = 0 OR t.alert_resolved IS NULL) THEN 0 ELSE 1 END ASC,
       t.rowid DESC
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

/**
 * Mark the thread's context as seeded. Called by the chat runner after it has
 * injected the thread-context preamble into the first claude prompt so that
 * subsequent turns do not receive a duplicate preamble.
 */
export const markContextSeeded = async (id: string): Promise<void> => {
  await initChatStore()
  const c = stateClient()
  await c.execute({
    sql: `UPDATE chat_threads SET context_seeded = 1, updated_at = ? WHERE id = ?`,
    args: [now(), id],
  })
}

// ── Alert thread API ──────────────────────────────────────────────────────────

/**
 * Find the alert-origin thread for a given action-queue item id.
 * Returns null when no such thread exists (not yet created or different item).
 */
export const findAlertThreadByItemId = async (
  alertItemId: string,
): Promise<ChatThread | null> => {
  await initChatStore()
  const c = stateClient()
  const result = await c.execute({
    sql: `SELECT * FROM chat_threads WHERE alert_item_id = ? LIMIT 1`,
    args: [alertItemId],
  })
  if (result.rows.length === 0) return null
  return rowToThread(result.rows[0] as unknown as Record<string, unknown>)
}

/**
 * Create a proactive alert-origin thread for the given action-queue item.
 * Inserts one assistant message containing the alert segment. Idempotent via
 * `findAlertThreadByItemId` — callers should check before calling.
 */
export const createAlertThread = async (
  alertItemId: string,
  title: string,
  segment: AlertSegment,
): Promise<ChatThread> => {
  await initChatStore()
  const c = stateClient()
  const threadId = randomUUID()
  const msgId = randomUUID()
  const ts = now()
  await c.execute({
    sql: `INSERT INTO chat_threads
            (id, title, session_id, status, created_at, updated_at, origin, alert_item_id, alert_resolved)
          VALUES (?, ?, NULL, 'idle', ?, ?, 'alert', ?, 0)`,
    args: [threadId, title, ts, ts, alertItemId],
  })
  // Persist one assistant message with the alert segment.
  await c.execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?)`,
    args: [msgId, threadId, title, JSON.stringify([segment]), ts],
  })
  return {
    id: threadId,
    title,
    session_id: null,
    status: 'idle',
    created_at: ts,
    updated_at: ts,
    origin: 'alert',
    alert_item_id: alertItemId,
    alert_resolved: false,
    context_seeded: false,
  }
}

/**
 * Mark the alert thread associated with `alertItemId` as resolved.
 * Updates the alert segment's `resolved` flag in-place.
 * Returns `true` if a thread was found and updated, `false` if none exists.
 */
export const resolveAlertThread = async (alertItemId: string): Promise<boolean> => {
  await initChatStore()
  const c = stateClient()
  const ts = now()
  // Find the thread
  const found = await c.execute({
    sql: `SELECT id FROM chat_threads WHERE alert_item_id = ? AND alert_resolved = 0 LIMIT 1`,
    args: [alertItemId],
  })
  if (found.rows.length === 0) return false
  const threadId = (found.rows[0] as unknown as { id: string }).id
  // Mark the thread as resolved
  await c.execute({
    sql: `UPDATE chat_threads SET alert_resolved = 1, updated_at = ? WHERE id = ?`,
    args: [ts, threadId],
  })
  // Update the alert segment's `resolved` field inside the persisted message
  const msgResult = await c.execute({
    sql: `SELECT id, segments FROM chat_messages
           WHERE thread_id = ? AND role = 'assistant'
           ORDER BY rowid ASC LIMIT 1`,
    args: [threadId],
  })
  if (msgResult.rows.length > 0) {
    const msgRow = msgResult.rows[0] as unknown as { id: string; segments: string | null }
    if (msgRow.segments) {
      try {
        const segs = JSON.parse(msgRow.segments) as unknown[]
        const updated = segs.map((s) => {
          if (
            s !== null &&
            typeof s === 'object' &&
            (s as Record<string, unknown>).type === 'alert'
          ) {
            return { ...(s as Record<string, unknown>), resolved: true }
          }
          return s
        })
        await c.execute({
          sql: `UPDATE chat_messages SET segments = ? WHERE id = ?`,
          args: [JSON.stringify(updated), msgRow.id],
        })
      } catch {
        // Non-fatal: the thread is still marked resolved.
      }
    }
  }
  return true
}
