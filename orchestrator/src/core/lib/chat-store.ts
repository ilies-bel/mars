/**
 * Chat persistence layer — `chat_threads`, `chat_messages` and
 * `chat_feedback` tables in the Mars database.
 *
 * Schema ownership: all three tables (and their indexes) are created by
 * `ensureSchema` in core/lib/pg-schema.ts (migration 0002) — this module
 * carries no DDL. The `resolveStateClient` function (not its result) is
 * stored so the DB client is resolved lazily and tests can reset it via
 * `vi.resetModules()`.
 */

import { randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client'

const stateClient = resolveStateClient

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initChatStore = async (): Promise<void> => {
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(stateClient())
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ThreadStatus = 'idle' | 'running'
export type MessageRole = 'user' | 'assistant'
export type FeedbackRating = 'up' | 'down'

export interface ChatFeedback {
  message_id: string
  thread_id: string
  rating: FeedbackRating
  note: string | null
  created_at: string
  updated_at: string
}

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
  /**
   * ISO-8601 timestamp set when the thread is marked as evaporated (i.e. its
   * purpose has been fulfilled and it is eligible for retention-window purge).
   * Null for active threads.
   */
  evaporated_at: string | null
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
  /** Per-message feedback keyed by message id. Populated by `getThread` via a LEFT JOIN. */
  feedbacks: Map<string, { rating: FeedbackRating; note: string | null }>
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
  feedback: { rating: FeedbackRating; note: string | null } | null
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
export const toMessageApiView = (
  m: ChatMessage,
  feedback?: { rating: FeedbackRating; note: string | null } | null,
): ChatMessageApiView => {
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
    feedback: feedback ?? null,
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
  /**
   * One plain sentence a non-expert understands, from the recipe registry.
   * Additive field — the UI task will switch from `title`/`whyNow` to this
   * once both land.
   */
  humanSummary?: string
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
  evaporated_at: (row.evaporated_at as string | null) ?? null,
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
    evaporated_at: null,
  }
}

/**
 * List all threads, alert-origin unresolved threads first, then newest-first.
 * Each thread is augmented with the text of its most recent message.
 */
export const listThreads = async (): Promise<ThreadPreview[]> => {
  const c = stateClient()
  const result = await c.execute(`
    SELECT t.*,
           (SELECT content
              FROM chat_messages m
             WHERE m.thread_id = t.id
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT 1) AS last_message
      FROM chat_threads t
     ORDER BY
       -- Alert threads that are not yet resolved sort first.
       CASE WHEN t.origin = 'alert' AND (t.alert_resolved = 0 OR t.alert_resolved IS NULL) THEN 0 ELSE 1 END ASC,
       t.created_at DESC, t.id DESC
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
  const c = stateClient()
  const threadResult = await c.execute({
    sql: `SELECT * FROM chat_threads WHERE id = ?`,
    args: [id],
  })
  if (threadResult.rows.length === 0) return null
  const thread = rowToThread(threadResult.rows[0] as unknown as Record<string, unknown>)

  // Single round trip: LEFT JOIN brings feedback alongside each message.
  const msgResult = await c.execute({
    sql: `SELECT m.*, f.rating AS feedback_rating, f.note AS feedback_note
          FROM chat_messages m
          LEFT JOIN chat_feedback f ON f.message_id = m.id
          WHERE m.thread_id = ?
          ORDER BY m.created_at ASC, m.id ASC`,
    args: [id],
  })
  const feedbacks = new Map<string, { rating: FeedbackRating; note: string | null }>()
  const messages = (msgResult.rows as unknown as Record<string, unknown>[]).map((row) => {
    const msg = rowToMessage(row)
    const feedbackRating = row.feedback_rating as string | null
    if (feedbackRating === 'up' || feedbackRating === 'down') {
      feedbacks.set(msg.id, {
        rating: feedbackRating,
        note: (row.feedback_note as string | null) ?? null,
      })
    }
    return msg
  })
  return { thread, messages, feedbacks }
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
  const c = stateClient()
  await c.execute({ sql: `DELETE FROM chat_messages WHERE thread_id = ?`, args: [id] })
  await c.execute({ sql: `DELETE FROM chat_threads WHERE id = ?`, args: [id] })
}

/**
 * Startup sweep: find every thread whose status is still `'running'` (orphaned
 * by a daemon crash/restart, since the in-memory run map starts empty), flip
 * each to `'idle'`, and append a short assistant message so the user sees why
 * their turn produced no reply. Returns the number of threads recovered.
 */
export const recoverOrphanedChatRuns = async (): Promise<number> => {
  const c = stateClient()
  const result = await c.execute({
    sql: `SELECT id FROM chat_threads WHERE status = 'running'`,
    args: [],
  })
  const threadIds = (result.rows as unknown as Array<{ id: string }>).map((r) => r.id)
  for (const threadId of threadIds) {
    await c.execute({
      sql: `UPDATE chat_threads SET status = 'idle', updated_at = ? WHERE id = ?`,
      args: [now(), threadId],
    })
    await appendMessage(
      threadId,
      'assistant',
      'This chat run was interrupted when the daemon restarted. Please resend your message to continue.',
    )
  }
  return threadIds.length
}

/** Transition a thread between `'idle'` and `'running'` states. */
export const setThreadStatus = async (id: string, status: ThreadStatus): Promise<void> => {
  const c = stateClient()
  await c.execute({
    sql: `UPDATE chat_threads SET status = ?, updated_at = ? WHERE id = ?`,
    args: [status, now(), id],
  })
}

/** Bind (or unbind) a Claude session ID to a thread. */
export const setThreadSession = async (id: string, sessionId: string | null): Promise<void> => {
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
  const c = stateClient()
  await c.execute({
    sql: `UPDATE chat_threads SET context_seeded = 1, updated_at = ? WHERE id = ?`,
    args: [now(), id],
  })
}

/**
 * Mark a thread as evaporated by stamping `evaporated_at` with the current
 * ISO-8601 timestamp. Idempotent: if the thread is already evaporated, the
 * existing timestamp is preserved (the WHERE clause guards against overwrite).
 */
export const markThreadEvaporated = async (id: string): Promise<void> => {
  const c = stateClient()
  const ts = now()
  await c.execute({
    sql: `UPDATE chat_threads SET evaporated_at = ?, updated_at = ? WHERE id = ? AND evaporated_at IS NULL`,
    args: [ts, ts, id],
  })
}

// ── Feedback API ──────────────────────────────────────────────────────────────

/**
 * Upsert feedback for an assistant message. Throws when the message does not
 * exist or is not `role='assistant'`. Returns the stored row.
 *
 * `note` is stored as-is (callers are responsible for trimming and capping
 * length). An empty string is stored as NULL.
 */
export const setMessageFeedback = async (
  messageId: string,
  rating: FeedbackRating,
  note: string | null,
): Promise<ChatFeedback> => {
  const c = stateClient()
  const msgResult = await c.execute({
    sql: `SELECT id, thread_id, role FROM chat_messages WHERE id = ?`,
    args: [messageId],
  })
  if (msgResult.rows.length === 0) {
    throw new Error(`message ${messageId} not found`)
  }
  const msgRow = msgResult.rows[0] as unknown as { id: string; thread_id: string; role: string }
  if (msgRow.role !== 'assistant') {
    throw new Error(`message ${messageId} is not an assistant message`)
  }
  const ts = now()
  const storedNote = note === '' ? null : note
  await c.execute({
    sql: `INSERT INTO chat_feedback (message_id, thread_id, rating, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            rating     = excluded.rating,
            note       = excluded.note,
            updated_at = excluded.updated_at`,
    args: [messageId, msgRow.thread_id, rating, storedNote, ts, ts],
  })
  // Re-read to return the full stored row (created_at may differ on first insert).
  const stored = await c.execute({
    sql: `SELECT * FROM chat_feedback WHERE message_id = ?`,
    args: [messageId],
  })
  const row = stored.rows[0] as unknown as Record<string, unknown>
  return {
    message_id: row.message_id as string,
    thread_id: row.thread_id as string,
    rating: row.rating as FeedbackRating,
    note: (row.note as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

/**
 * Remove feedback for a message. Idempotent — returns `false` when no feedback
 * existed for the message.
 */
export const clearMessageFeedback = async (messageId: string): Promise<boolean> => {
  const c = stateClient()
  const result = await c.execute({
    sql: `DELETE FROM chat_feedback WHERE message_id = ?`,
    args: [messageId],
  })
  return ((result as unknown as { rowsAffected?: number }).rowsAffected ?? 0) > 0
}

// ── Alert thread API ──────────────────────────────────────────────────────────

/**
 * Find the alert-origin thread for a given action-queue item id.
 * Returns null when no such thread exists (not yet created or different item).
 */
export const findAlertThreadByItemId = async (
  alertItemId: string,
): Promise<ChatThread | null> => {
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
    evaporated_at: null,
  }
}

/**
 * Mark the alert thread associated with `alertItemId` as resolved.
 * Updates the alert segment's `resolved` flag in-place.
 * Returns `true` if a thread was found and updated, `false` if none exists.
 */
export const resolveAlertThread = async (alertItemId: string): Promise<boolean> => {
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
           ORDER BY created_at ASC, id ASC LIMIT 1`,
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
