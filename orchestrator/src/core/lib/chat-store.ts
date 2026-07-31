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
import { z } from 'zod'
import { resolveStateClient } from '../store/state-client'
import { humanSummary } from './action-queue-recipes'
import type { NoticeRow } from './notice-store'

const stateClient = resolveStateClient

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initChatStore = async (): Promise<void> => {
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(stateClient())
}

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Envelope kind for chat messages.
 * - 'validation'    — cleared from the projection when its backing entity
 *                     mutates out of 'awaiting-human' state (ADR-0048).
 * - 'acknowledgment' — plain first-person history; always visible.
 */
export const ChatMessageKindSchema = z.enum(['validation', 'acknowledgment'])
export type ChatMessageKind = z.infer<typeof ChatMessageKindSchema>

export type ThreadStatus = 'idle' | 'running' | 'throttled'
export type ChatPosture = 'triage' | 'grill'
export type AttentionStatus = 'generating' | 'ready' | 'drafting' | 'idle'
export type MessageRole = 'user' | 'assistant'
export type FeedbackRating = 'up' | 'down'

/**
 * A deterministic Mars-authored feed entry. The persistence adapter currently
 * stores this as an assistant message, preserving the chat transport's
 * user/assistant transcript contract.
 */
export interface ChatMessageDraft {
  author: 'mars'
  role: 'notice'
  body: string
}

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
  status: ThreadStatus
  posture: ChatPosture
  created_at: string
  updated_at: string
  /** 'alert' for proactive alert-origin threads; null for user-created threads. */
  origin: string | null
  /** The action-queue item id this thread tracks. Null for non-alert threads. */
  alert_item_id: string | null
  /** True when the underlying action-queue item has been resolved. */
  alert_resolved: boolean
  /**
   * ISO-8601 timestamp set when the thread is marked as evaporated (i.e. its
   * purpose has been fulfilled and it is eligible for retention-window purge).
   * Null for active threads.
   */
  evaporated_at: string | null
  parent_thread_id: string | null
  fork_idempotency_key: string | null
}

export interface ChatMessage {
  id: string
  thread_id: string
  role: MessageRole
  content: string
  segments: unknown | null
  created_at: string
  /** Envelope kind — controls projection visibility (ADR-0048). */
  kind: ChatMessageKind
  /**
   * ID of the task (or proposal) this validation message is anchored to.
   * Null for acknowledgment messages and for validation messages with no
   * specific backing entity.
   */
  backing_entity_id: string | null
}

export interface ThreadPreview extends ChatThread {
  /** Text of the most recent message, or null when the thread has no messages. */
  last_message: string | null
  /** Role of the most recent message, or null when the thread has no messages. */
  last_message_role: string | null
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
  attentionStatus: AttentionStatus
  createdAt: string
  updatedAt: string
  /** 'alert' for proactive threads; null for user-created threads. */
  origin: string | null
  /** The action-queue item id this thread tracks. */
  alertItemId: string | null
  /** True when the underlying action-queue item has been resolved. */
  alertResolved: boolean
  parentThreadId: string | null
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

/**
 * A persisted message in the continuous conversation projection. Unlike a
 * thread detail message it retains `content`, so records written before typed
 * segments existed still have an honest text representation for the UI.
 */
export interface ChatConversationEntryApiView {
  id: string
  threadId: string
  /** Subject identity (the backing chat thread). */
  subjectId: string
  subjectTitle: string
  subjectClosed: boolean
  role: MessageRole
  content: string
  segments: unknown[]
  createdAt: string
  kind: ChatMessageKind
  backingEntityId: string | null
}

/**
 * Compute the attention status for a thread given its run status and the role
 * of the most recent message. This is a pure function — no side effects.
 *
 * - generating: the thread is actively running or waiting to retry (throttled).
 * - ready:      idle + last message is from the assistant (unread response).
 * - drafting:   idle + last message is from the user (response expected but not yet started).
 * - idle:       idle + no messages yet.
 */
export const computeAttentionStatus = (
  status: ThreadStatus,
  lastMessageRole: string | null | undefined,
): AttentionStatus => {
  if (status === 'running' || status === 'throttled') return 'generating'
  if (status === 'idle' && lastMessageRole === 'assistant') return 'ready'
  if (status === 'idle' && lastMessageRole === 'user') return 'drafting'
  return 'idle'
}

/** Render a Notice into the Mars voice used by the continuous chat feed. */
export function noticeToChatMessage(notice: NoticeRow): ChatMessageDraft {
  return {
    author: 'mars',
    role: 'notice',
    body: humanSummary(notice.kind, notice.payload),
  }
}

/** Convert a stored thread to its API view shape. */
export const toThreadApiView = (
  t: ChatThread,
  lastMessageRole?: string | null,
): ChatThreadApiView => ({
  id: t.id,
  title: t.title,
  status: t.status,
  attentionStatus: computeAttentionStatus(t.status, lastMessageRole),
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  origin: t.origin,
  alertItemId: t.alert_item_id,
  alertResolved: t.alert_resolved,
  parentThreadId: t.parent_thread_id,
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
  /**
   * The arc's main goal — "what it was trying to achieve". Populated for
   * arc-failed items from the origin task's intent/prompt. Absent for other
   * kinds where a goal is not meaningful.
   */
  goal?: string
}

// ── Fork-seed segment types ───────────────────────────────────────────────────

/** Segment type referencing a task created during a thread. */
export interface TaskRefSegment {
  type: 'task_ref'
  taskId: string
}

/** Segment type referencing an ADR cited during a thread. */
export interface AdrRefSegment {
  type: 'adr_ref'
  ref: string
}

/** Segment type referencing a glossary term cited during a thread. */
export interface GlossaryRefSegment {
  type: 'glossary_ref'
  ref: string
}

/** Segment type referencing an artifact surfaced during a thread. */
export interface ArtifactRefSegment {
  type: 'artifact_ref'
  ref: string
}

/**
 * Opening seed segment inserted as the first assistant message in a forked
 * thread. Carries compact context distilled from the source thread.
 */
export interface ForkSeedSegment {
  type: 'fork_seed'
  goalSummary: string
  transcriptSummary: string
  artifactRefs: string[]
  taskIds: string[]
  adrRefs: string[]
  glossaryRefs: string[]
  files: Array<{ path: string; note?: string }>
}

/**
 * Replay checkpoint inserted after compacting an inactive transcript. The
 * underlying messages remain intact; this segment only changes replay.
 */
export interface CompactionSegment {
  type: 'compaction'
  summary: string
  coveredThrough: string
  messageCount: number
  taskIds: string[]
  adrRefs: string[]
  glossaryRefs: string[]
  artifactRefs: string[]
}

/** Structured context seeded into a forked thread's opening assistant message. */
export interface ForkSeed {
  goalSummary: string
  transcriptSummary: string
  artifactRefs: string[]
  taskIds: string[]
  adrRefs: string[]
  glossaryRefs: string[]
  files: Array<{ path: string; note?: string }>
}

/** Structured references retained when prose transcript content is compacted. */
export interface StructuredChatRefs {
  taskIds: string[]
  adrRefs: string[]
  glossaryRefs: string[]
  artifactRefs: string[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const now = (): string => new Date().toISOString()

/**
 * Collect the durable structured references carried by persisted segments.
 * Accepts DB-shaped JSON strings as well as already-parsed message segments so
 * both fork seeds and compaction checkpoints preserve the same references.
 */
export const collectStructuredChatRefs = (
  messages: ReadonlyArray<{ segments: unknown | null }>,
): StructuredChatRefs => {
  const taskIds: string[] = []
  const adrRefs: string[] = []
  const glossaryRefs: string[] = []
  const artifactRefs: string[] = []

  for (const message of messages) {
    let segments: unknown
    if (typeof message.segments === 'string') {
      try {
        segments = JSON.parse(message.segments) as unknown
      } catch {
        continue
      }
    } else {
      segments = message.segments
    }
    if (!Array.isArray(segments)) continue

    for (const segment of segments) {
      if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) continue
      const value = segment as Record<string, unknown>
      if (value['type'] === 'task_ref' && typeof value['taskId'] === 'string') {
        if (!taskIds.includes(value['taskId'])) taskIds.push(value['taskId'])
      } else if (value['type'] === 'adr_ref' && typeof value['ref'] === 'string') {
        if (!adrRefs.includes(value['ref'])) adrRefs.push(value['ref'])
      } else if (value['type'] === 'glossary_ref' && typeof value['ref'] === 'string') {
        if (!glossaryRefs.includes(value['ref'])) glossaryRefs.push(value['ref'])
      } else if (value['type'] === 'artifact_ref' && typeof value['ref'] === 'string') {
        if (!artifactRefs.includes(value['ref'])) artifactRefs.push(value['ref'])
      }
    }
  }

  return { taskIds, adrRefs, glossaryRefs, artifactRefs }
}

const rowToThread = (row: Record<string, unknown>): ChatThread => ({
  id: row.id as string,
  title: row.title as string,
  status: row.status as ThreadStatus,
  posture: row.posture === 'grill' ? 'grill' : 'triage',
  created_at: row.created_at as string,
  updated_at: row.updated_at as string,
  origin: (row.origin as string | null) ?? null,
  alert_item_id: (row.alert_item_id as string | null) ?? null,
  alert_resolved: Boolean(row.alert_resolved),
  evaporated_at: (row.evaporated_at as string | null) ?? null,
  parent_thread_id: (row.parent_thread_id as string | null) ?? null,
  fork_idempotency_key: (row.fork_idempotency_key as string | null) ?? null,
})

const rowToMessage = (row: Record<string, unknown>): ChatMessage => {
  const rawSegments = row.segments as string | null
  const rawKind = row.kind as string | null
  return {
    id: row.id as string,
    thread_id: row.thread_id as string,
    role: row.role as MessageRole,
    content: row.content as string,
    segments: rawSegments != null ? (JSON.parse(rawSegments) as unknown) : null,
    created_at: row.created_at as string,
    kind: (rawKind === 'validation' ? 'validation' : 'acknowledgment') as ChatMessageKind,
    backing_entity_id: (row.backing_entity_id as string | null) ?? null,
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
    sql: `INSERT INTO chat_threads (id, title, status, created_at, updated_at)
          VALUES (?, ?, 'idle', ?, ?)`,
    args: [id, threadTitle, ts, ts],
  })
  return {
    id,
    title: threadTitle,
    status: 'idle',
    posture: 'triage',
    created_at: ts,
    updated_at: ts,
    origin: null,
    alert_item_id: null,
    alert_resolved: false,
    evaporated_at: null,
    parent_thread_id: null,
    fork_idempotency_key: null,
  }
}

/**
 * Build a compact seed from a source thread's transcript.
 *
 * Scans `chat_messages.segments` for structured reference types
 * (`task_ref`, `adr_ref`, `glossary_ref`, `artifact_ref`) and collects
 * unique values. `transcriptSummary` is a plain concatenation of all
 * message content, capped at 2000 characters. No LLM call is made here.
 *
 * @param sourceThreadId - The thread to derive context from.
 * @param files          - Operator-supplied file references to embed in the seed.
 */
export const buildForkSeed = async (
  sourceThreadId: string,
  files?: Array<{ path: string; note?: string }>,
): Promise<ForkSeed> => {
  const c = stateClient()

  const threadResult = await c.execute({
    sql: `SELECT title FROM chat_threads WHERE id = ?`,
    args: [sourceThreadId],
  })
  const goalSummary =
    threadResult.rows.length > 0
      ? ((threadResult.rows[0] as Record<string, unknown>).title as string)
      : ''

  const msgResult = await c.execute({
    sql: `SELECT content, segments FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, seq ASC`,
    args: [sourceThreadId],
  })

  const contentParts: string[] = []

  for (const row of msgResult.rows as unknown as Array<Record<string, unknown>>) {
    contentParts.push(row.content as string)
  }

  const refs = collectStructuredChatRefs(
    msgResult.rows as unknown as Array<{ segments: unknown | null }>,
  )

  const full = contentParts.join('\n')
  const transcriptSummary = full.length > 2000 ? `${full.slice(0, 2000)}…` : full

  return {
    goalSummary,
    transcriptSummary,
    ...refs,
    files: files ?? [],
  }
}

/**
 * Fork a chat thread. Creates a new human-lifecycle thread linked to the
 * source via `parent_thread_id`. Uses `fork_idempotency_key` to deduplicate:
 * repeated calls with the same (sourceThreadId, idempotencyKey) return the
 * existing child thread. The fork is always a plain human thread
 * (`origin=null`, `alert_item_id=null`) regardless of the source's origin.
 *
 * On first creation, inserts one assistant message carrying a `fork_seed`
 * segment so the operator opening the child thread sees source context
 * immediately. The idempotent-repeat path skips this insertion.
 */
export const forkThread = async (opts: {
  sourceThreadId: string
  goal: string
  idempotencyKey: string
  files?: Array<{ path: string; note?: string }>
}): Promise<{ thread: ChatThread; deduped: boolean }> => {
  const c = stateClient()
  const existing = await c.execute({
    sql: `SELECT * FROM chat_threads
          WHERE parent_thread_id = ? AND fork_idempotency_key = ?`,
    args: [opts.sourceThreadId, opts.idempotencyKey],
  })
  if (existing.rows.length > 0) {
    return { thread: rowToThread(existing.rows[0] as Record<string, unknown>), deduped: true }
  }
  const id = randomUUID()
  const ts = now()
  await c.execute({
    sql: `INSERT INTO chat_threads
            (id, title, status, created_at, updated_at, origin, alert_item_id,
             alert_resolved, parent_thread_id, fork_idempotency_key)
          VALUES (?, ?, 'idle', ?, ?, NULL, NULL, 0, ?, ?)`,
    args: [id, opts.goal, ts, ts, opts.sourceThreadId, opts.idempotencyKey],
  })

  const seed = await buildForkSeed(opts.sourceThreadId, opts.files)
  const forkSeedSegment: ForkSeedSegment = { type: 'fork_seed', ...seed }
  await appendMessage(id, 'assistant', seed.goalSummary || opts.goal, [forkSeedSegment])

  return {
    thread: {
      id,
      title: opts.goal,
      status: 'idle',
      posture: 'triage',
      created_at: ts,
      updated_at: ts,
      origin: null,
      alert_item_id: null,
      alert_resolved: false,
      evaporated_at: null,
      parent_thread_id: opts.sourceThreadId,
      fork_idempotency_key: opts.idempotencyKey,
    },
    deduped: false,
  }
}

/**
 * List all active (non-evaporated) threads newest-first. Each thread is
 * augmented with the text and role of its most recent message.
 */
export const listThreads = async (): Promise<ThreadPreview[]> => {
  const c = stateClient()
  const result = await c.execute(`
    SELECT t.*,
           (SELECT content
              FROM chat_messages m
             WHERE m.thread_id = t.id
             ORDER BY m.created_at DESC, m.seq DESC
             LIMIT 1) AS last_message,
           (SELECT role
              FROM chat_messages m
             WHERE m.thread_id = t.id
             ORDER BY m.created_at DESC, m.seq DESC
             LIMIT 1) AS last_message_role
      FROM chat_threads t
     WHERE t.evaporated_at IS NULL
     ORDER BY t.created_at DESC, t.id DESC
  `)
  return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
    ...rowToThread(row),
    last_message: (row.last_message as string | null) ?? null,
    last_message_role: (row.last_message_role as string | null) ?? null,
  }))
}

/**
 * List the persisted conversation across every Subject in the one global
 * insertion order. `chat_messages.seq` is deliberately the sole sort key: it
 * is the ordering the persistence layer assigned, even when timestamps tie.
 */
export const listConversationEntries = async (): Promise<ChatConversationEntryApiView[]> => {
  const c = stateClient()
  const result = await c.execute(`
    SELECT m.*, t.title AS subject_title, t.evaporated_at AS subject_evaporated_at
      FROM chat_messages m
      JOIN chat_threads t ON t.id = m.thread_id
     ORDER BY m.seq ASC
  `)
  return (result.rows as unknown as Record<string, unknown>[]).map((row) => {
    const message = rowToMessage(row)
    return {
      id: message.id,
      threadId: message.thread_id,
      subjectId: message.thread_id,
      subjectTitle: row.subject_title as string,
      subjectClosed: row.subject_evaporated_at != null,
      role: message.role,
      content: message.content,
      segments: Array.isArray(message.segments) ? message.segments : [],
      createdAt: message.created_at,
      kind: message.kind,
      backingEntityId: message.backing_entity_id,
    }
  })
}

/**
 * List all evaporated threads newest-first. Used to populate the History
 * section in the chat sidebar.
 */
export const listEvaporatedThreads = async (): Promise<ThreadPreview[]> => {
  const c = stateClient()
  const result = await c.execute(`
    SELECT t.*,
           (SELECT content
              FROM chat_messages m
             WHERE m.thread_id = t.id
             ORDER BY m.created_at DESC, m.seq DESC
             LIMIT 1) AS last_message,
           (SELECT role
              FROM chat_messages m
             WHERE m.thread_id = t.id
             ORDER BY m.created_at DESC, m.seq DESC
             LIMIT 1) AS last_message_role
      FROM chat_threads t
     WHERE t.evaporated_at IS NOT NULL
     ORDER BY t.evaporated_at DESC, t.id DESC
  `)
  return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({
    ...rowToThread(row),
    last_message: (row.last_message as string | null) ?? null,
    last_message_role: (row.last_message_role as string | null) ?? null,
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
          ORDER BY m.created_at ASC, m.seq ASC`,
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
 *
 * @param opts.kind          - Envelope kind (default: 'acknowledgment').
 * @param opts.backingEntityId - Task or proposal id this validation message
 *                              tracks. Only meaningful when kind='validation'.
 */
export const appendMessage = async (
  threadId: string,
  role: MessageRole,
  content: string,
  segments?: unknown,
  opts?: { kind?: ChatMessageKind; backingEntityId?: string },
): Promise<ChatMessage> => {
  const c = stateClient()
  const id = randomUUID()
  const ts = now()
  const segmentsJson = segments !== undefined ? JSON.stringify(segments) : null
  const kind: ChatMessageKind = opts?.kind ?? 'acknowledgment'
  const backingEntityId = opts?.backingEntityId ?? null
  await c.execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at, kind, backing_entity_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, threadId, role, content, segmentsJson, ts, kind, backingEntityId],
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
    kind,
    backing_entity_id: backingEntityId,
  }
}

/**
 * Return the visible messages for a thread, applying the ADR-0048 projection
 * rule: 'acknowledgment' messages are always visible; 'validation' messages are
 * visible only while their backing entity (task) is still in 'awaiting-human'
 * state. A validation message with no backing_entity_id is always visible.
 *
 * Messages are returned in chronological order (created_at ASC, seq ASC).
 */
export const listVisibleChatMessages = async (threadId: string): Promise<ChatMessage[]> => {
  const c = stateClient()
  const result = await c.execute({
    sql: `SELECT m.*
          FROM chat_messages m
          WHERE m.thread_id = ?
            AND (
              m.kind = 'acknowledgment'
              OR (m.kind = 'validation' AND m.backing_entity_id IS NULL)
              OR (
                m.kind = 'validation'
                AND m.backing_entity_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM tasks t
                  WHERE t.id = m.backing_entity_id AND t.status = 'awaiting-human'
                )
              )
            )
          ORDER BY m.created_at ASC, m.seq ASC`,
    args: [threadId],
  })
  return (result.rows as unknown as Record<string, unknown>[]).map(rowToMessage)
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

/** Persist the chat agent's conversation mode for a thread. */
export const setThreadPosture = async (id: string, posture: ChatPosture): Promise<void> => {
  const c = stateClient()
  await c.execute({
    sql: `UPDATE chat_threads SET posture = ?, updated_at = ? WHERE id = ?`,
    args: [posture, now(), id],
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

/**
 * Evaporate idle threads that have never received a user message (i.e. they
 * were created but never used). Returns the number of threads evaporated.
 */
export const evaporateUnengagedThreads = async (): Promise<number> => {
  const c = stateClient()
  const result = await c.execute(`
    SELECT id FROM chat_threads
     WHERE status = 'idle'
       AND evaporated_at IS NULL
       AND id NOT IN (
         SELECT DISTINCT thread_id FROM chat_messages WHERE role = 'user'
       )
  `)
  const threadIds = (result.rows as unknown as Array<{ id: string }>).map((r) => r.id)
  const ts = now()
  for (const id of threadIds) {
    await c.execute({
      sql: `UPDATE chat_threads SET evaporated_at = ?, updated_at = ? WHERE id = ? AND evaporated_at IS NULL`,
      args: [ts, ts, id],
    })
  }
  return threadIds.length
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

// ── Alert-pull thread API (human-triggered, slice 4) ──────────────────────────

/**
 * Find the existing alert-origin thread that tracks `arcId`, or null. A lean
 * lookup scoped to {@link startThreadFromAlert}'s dedup: matches on
 * `origin='alert' AND alert_item_id = arcId` so re-clicking the same Alert
 * reuses its thread instead of spawning a duplicate.
 */
const findThreadByArc = async (arcId: string): Promise<ChatThread | null> => {
  const c = stateClient()
  const result = await c.execute({
    sql: `SELECT * FROM chat_threads WHERE origin = 'alert' AND alert_item_id = ? LIMIT 1`,
    args: [arcId],
  })
  if (result.rows.length === 0) return null
  return rowToThread(result.rows[0] as unknown as Record<string, unknown>)
}

/**
 * Human-pull path (ADR-0048): turn an Alert into a chat thread when the operator
 * clicks it in the Bell or the hero "next action" shortcut. Unlike the removed
 * proactive `createAlertThread`, nothing mints these on raise — they exist only
 * once a human pulls the Alert in.
 *
 * Dedup: if a thread already tracks this arc (`origin='alert'`,
 * `alert_item_id = arcId`), it is returned unchanged so a second click reuses
 * the same conversation. Otherwise a fresh alert-origin thread is inserted with
 * one assistant message carrying the alert `segment`; the chat runner replays
 * that message (rendered as alert text) as part of the transcript, so the
 * agent sees the alert card on every turn.
 *
 * Picking an Alert into a thread does NOT clear it from the Bell — an Alert
 * clears only when its arc resolves (ADR-0048).
 */
export const startThreadFromAlert = async (
  arcId: string,
  title: string,
  segment: AlertSegment,
): Promise<ChatThread> => {
  const existing = await findThreadByArc(arcId)
  if (existing) return existing

  const c = stateClient()
  const threadId = randomUUID()
  const msgId = randomUUID()
  const ts = now()
  await c.execute({
    sql: `INSERT INTO chat_threads
            (id, title, status, created_at, updated_at, origin, alert_item_id, alert_resolved)
          VALUES (?, ?, 'idle', ?, ?, 'alert', ?, 0)`,
    args: [threadId, title, ts, ts, arcId],
  })
  // Persist one assistant message with the alert segment (the seed card).
  await c.execute({
    sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?)`,
    args: [msgId, threadId, title, JSON.stringify([segment]), ts],
  })
  return {
    id: threadId,
    title,
    status: 'idle',
    posture: 'triage',
    created_at: ts,
    updated_at: ts,
    origin: 'alert',
    alert_item_id: arcId,
    alert_resolved: false,
    evaporated_at: null,
    parent_thread_id: null,
    fork_idempotency_key: null,
  }
}

/**
 * Resolve an alert-origin thread: flip `alert_resolved = 1` and stamp
 * `evaporated_at` with the current timestamp in the same UPDATE, starting the
 * retention clock. COALESCE guards the evaporated_at column so a pre-existing
 * value is never overwritten (idempotent at the column level).
 *
 * @returns `true` on the first resolution, `false` when the thread was already
 *   resolved (second call is a no-op).
 */
export const resolveAlertThread = async (threadId: string): Promise<boolean> => {
  const c = stateClient()
  const ts = now()
  const result = await c.execute({
    sql: `UPDATE chat_threads
          SET alert_resolved = 1, updated_at = ?, evaporated_at = COALESCE(evaporated_at, ?)
          WHERE id = ? AND alert_resolved = 0`,
    args: [ts, ts, threadId],
  })
  return ((result as unknown as { rowsAffected?: number }).rowsAffected ?? 0) > 0
}

// ── Retention purge ───────────────────────────────────────────────────────────

/** Default retention window: 2 days in milliseconds. */
export const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

/**
 * Hard-delete every evaporated thread whose `evaporated_at` is older than
 * `now - retentionMs`, together with its `chat_messages` rows (and, via
 * ON DELETE CASCADE, any `chat_feedback` rows on those messages).
 *
 * Deletion order inside each transaction: messages first, then the thread,
 * so a mid-purge crash cannot leave orphaned messages.
 *
 * @param opts.retentionMs - Retention window in ms (default: TWO_DAYS_MS).
 * @param opts.nowMs       - Injectable clock for tests (default: Date.now()).
 * @returns The ids of every thread that was deleted.
 */
export const purgeEvaporatedThreads = async (opts?: {
  retentionMs?: number
  nowMs?: number
}): Promise<{ purgedThreadIds: string[] }> => {
  const cutoffIso = new Date(
    (opts?.nowMs ?? Date.now()) - (opts?.retentionMs ?? TWO_DAYS_MS),
  ).toISOString()
  const c = stateClient()
  const result = await c.execute({
    sql: `SELECT id FROM chat_threads WHERE evaporated_at IS NOT NULL AND evaporated_at < ?`,
    args: [cutoffIso],
  })
  const threadIds = (result.rows as unknown as Array<{ id: string }>).map((r) => r.id)
  if (threadIds.length === 0) return { purgedThreadIds: [] }
  // Build one batch so messages + thread deletions are atomic per thread and
  // across all threads in a single transaction.
  const stmts: Array<{ sql: string; args: readonly string[] }> = []
  for (const id of threadIds) {
    stmts.push({ sql: `DELETE FROM chat_messages WHERE thread_id = ?`, args: [id] })
    stmts.push({ sql: `DELETE FROM chat_threads WHERE id = ?`, args: [id] })
  }
  await c.batch(stmts, 'write')
  return { purgedThreadIds: threadIds }
}
