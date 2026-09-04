/**
 * Durable, zero-token delivery of template-authored conversation notices.
 *
 * Routine messages wait while Mars is generating; urgent messages append to
 * the current conversation immediately. Neither path starts a provider run.
 *
 * A Notice is never silently dropped. It always has a row to hang on — the
 * Subject a run is currently active on, or the main thread sentinel — and it
 * is always written with `context_scope='main'`, so it surfaces in the main
 * feed whichever row it landed on.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveStateClient } from '../store/state-client'
import { appendMessage } from './chat-store'
import { MAIN_THREAD_ID } from './pg-schema.js'
import type { ViewInvalidationBus } from '../../bus/view-invalidation.js'
import {
  renderConversationNotice,
  offersForConversationNotice,
  type AutonomousConversationNoticeInput,
} from './conversation-copy'

const stateClient = resolveStateClient

const ConversationPrioritySchema = z.enum(['urgent', 'routine'])
export type ConversationPriority = z.infer<typeof ConversationPrioritySchema>

/**
 * One hour in milliseconds. When a delivered `chat_messages` row with the same
 * `backing_entity_id` exists within this window, `postConversationNotice`
 * updates that row in-place instead of inserting a new pending row.
 */
const COALESCE_WINDOW_MS = 3_600_000

/** The delivery-side facts, shared by both ways of authoring a Notice. */
interface ConversationNoticeDelivery {
  priority: ConversationPriority
  /**
   * Ordered typed segments to persist beside the Notice text — the Offer set
   * the operator can act on. Omitted means "body only".
   */
  segments?: unknown[]
  /** Supplied by the daemon when it has an in-memory ChatRunner. */
  hasActiveRuns?: () => boolean
  /** Supplied by the daemon so a delivered Notice invalidates live UI views. */
  bus?: ViewInvalidationBus
  /**
   * When set, multiple firings of the same notice kind are coalesced into one
   * pending or delivered row rather than producing separate chat messages.
   *
   * - If an undelivered `conversation_pending_messages` row with the same
   *   `dedup_key` exists, its body, segments, and occurrence_count are updated
   *   in-place and no new row is inserted.
   * - If a delivered `chat_messages` row with `backing_entity_id = dedupKey`
   *   exists within `COALESCE_WINDOW_MS`, that row's content and segments are
   *   updated in-place and the call returns immediately as delivered.
   *
   * Also used as the `backing_entity_id` for any row created by this call,
   * enabling the in-place update path for future firings.
   */
  dedupKey?: string
}

export type ConversationNoticeInput =
  | (ConversationNoticeDelivery & {
      body: string
      /** Entity whose resolution disables the Notice's response controls. */
      backingEntityId?: string
    })
  | (ConversationNoticeDelivery & AutonomousConversationNoticeInput)

interface PendingConversationNotice {
  id: string
  body: string
  segments: string | null
  backing_entity_id: string | null
}

/**
 * Resolve the row a Notice hangs on.
 *
 * A run in flight means the operator is inside a Subject: the Notice lands
 * there so it reaches them mid-grill. Otherwise it lands on the main thread
 * sentinel. The sentinel is excluded from the active-run lookup — it never
 * runs, but excluding it keeps the "most recently touched" ordering honest
 * even if a future writer touches its `updated_at`.
 */
const resolveDeliveryThreadId = async (): Promise<string> => {
  const c = stateClient()
  const running = await c.execute({
    sql: `SELECT id FROM chat_threads
           WHERE status IN ('running', 'throttled')
             AND closed_at IS NULL
             AND id <> ?
           ORDER BY updated_at DESC, created_at DESC, id DESC
           LIMIT 1`,
    args: [MAIN_THREAD_ID],
  })
  const threadId = (running.rows[0] as { id?: unknown } | undefined)?.id
  return typeof threadId === 'string' ? threadId : MAIN_THREAD_ID
}

const deliverPendingNotice = async (
  notice: PendingConversationNotice,
  bus?: ViewInvalidationBus,
): Promise<void> => {
  const c = stateClient()
  const threadId = await resolveDeliveryThreadId()

  await appendMessage(
    threadId,
    'assistant',
    notice.body,
    notice.segments === null
      ? [{ type: 'text', text: notice.body }]
      : JSON.parse(notice.segments) as unknown[],
    {
      kind: 'notice',
      contextScope: 'main',
      ...(notice.backing_entity_id !== null ? { backingEntityId: notice.backing_entity_id } : {}),
    },
  )
  await c.execute({
    sql: `UPDATE conversation_pending_messages
            SET delivered_at = ?
          WHERE id = ? AND delivered_at IS NULL`,
    args: [Date.now(), notice.id],
  })
  // The message is durable before the ping: a client that re-fetches on this
  // event always finds it.
  bus?.emit('view.chat-invalidated')
}

/**
 * Queue a template-authored Notice for the durable conversation. Urgent
 * notices interrupt the visible timeline; routine notices wait for a pause.
 *
 * When `dedupKey` is set, duplicate firings within the same hour are folded
 * into one row rather than producing separate chat messages.
 */
export const postConversationNotice = async (
  input: ConversationNoticeInput,
): Promise<{ id: string; delivered: boolean }> => {
  const priority = ConversationPrioritySchema.parse(input.priority)
  const body = 'body' in input
    ? input.body
    : renderConversationNotice(input.kind, input.payload)
  const c = stateClient()
  // An explicit Offer set always wins. Otherwise a registry-authored Notice
  // carries the chips its kind stands behind, and only a free-form Notice
  // with nothing to offer degrades to plain text.
  const segments = input.segments ?? [
    { type: 'text', text: body },
    ...('kind' in input
      ? [{
          type: 'preloaded_responses',
          responses: offersForConversationNotice(input.kind, input.payload),
        }]
      : []),
  ]

  const dedupKey = input.dedupKey ?? null
  // When a dedupKey is set it doubles as the backing_entity_id so future
  // in-place lookups on chat_messages can find the delivered row by entity id.
  const rawBackingEntityId = 'body' in input ? input.backingEntityId ?? null : null
  const backingEntityId = dedupKey ?? rawBackingEntityId

  // ── dedup: update an existing undelivered pending row ───────────────────
  if (dedupKey !== null) {
    const pendingRow = await c.execute({
      sql: `SELECT id, occurrence_count FROM conversation_pending_messages
             WHERE dedup_key = ? AND delivered_at IS NULL
             LIMIT 1`,
      args: [dedupKey],
    })
    const existing = pendingRow.rows[0] as { id?: unknown; occurrence_count?: unknown } | undefined
    if (existing?.id !== undefined) {
      const existingId = existing.id as string
      const nextCount = ((existing.occurrence_count as number | null) ?? 1) + 1
      await c.execute({
        sql: `UPDATE conversation_pending_messages
                 SET body = ?, segments = ?, occurrence_count = ?
               WHERE id = ?`,
        args: [body, JSON.stringify(segments), nextCount, existingId],
      })
      return { id: existingId, delivered: false }
    }

    // ── dedup: update a delivered chat_messages row in-place ──────────────
    const deliveredRow = await c.execute({
      sql: `SELECT id FROM chat_messages
             WHERE backing_entity_id = ? AND kind = 'notice'
               AND created_at > ?
             LIMIT 1`,
      args: [dedupKey, Date.now() - COALESCE_WINDOW_MS],
    })
    const deliveredMsg = deliveredRow.rows[0] as { id?: unknown } | undefined
    if (deliveredMsg?.id !== undefined) {
      const deliveredId = deliveredMsg.id as string
      await c.execute({
        sql: `UPDATE chat_messages SET content = ?, segments = ? WHERE id = ?`,
        args: [body, JSON.stringify(segments), deliveredId],
      })
      input.bus?.emit('view.chat-invalidated')
      return { id: deliveredId, delivered: true }
    }
  }

  // ── normal path: insert a new pending row ────────────────────────────────
  const id = randomUUID()
  await c.execute({
    sql: `INSERT INTO conversation_pending_messages
            (id, body, segments, backing_entity_id, priority, created_at, dedup_key, occurrence_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    args: [id, body, JSON.stringify(segments), backingEntityId, priority, Date.now(), dedupKey],
  })

  const hasActiveRuns = input.hasActiveRuns?.() ?? (
    await c.execute(`SELECT 1 FROM chat_threads WHERE status IN ('running', 'throttled') LIMIT 1`)
  ).rows.length > 0
  if (priority === 'routine' && hasActiveRuns) return { id, delivered: false }

  await deliverPendingNotice(
    { id, body, segments: JSON.stringify(segments), backing_entity_id: backingEntityId },
    input.bus,
  )
  return { id, delivered: true }
}

/**
 * Deliver every pending Notice the current pause allows.
 *
 * Routine notices are the reason this runs at a pause — they wait for one. An
 * urgent notice left undelivered by an older build (or an interrupted write)
 * is retried here regardless of the run state: a Notice is never dropped for
 * having the wrong priority.
 */
export const flushRoutineConversationNotices = async (
  hasActiveRuns: () => boolean,
  bus?: ViewInvalidationBus,
): Promise<number> => {
  const paused = !hasActiveRuns()
  const c = stateClient()
  const result = await c.execute(`
    SELECT id, body, segments, backing_entity_id FROM conversation_pending_messages
     WHERE delivered_at IS NULL${paused ? '' : ` AND priority <> 'routine'`}
     ORDER BY created_at ASC, id ASC
  `)
  let delivered = 0
  for (const row of result.rows as unknown as PendingConversationNotice[]) {
    await deliverPendingNotice(row, bus)
    delivered++
  }
  return delivered
}
