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
import {
  renderConversationNotice,
  offersForConversationNotice,
  type AutonomousConversationNoticeInput,
} from './conversation-copy'

const stateClient = resolveStateClient

export const ConversationPrioritySchema = z.enum(['urgent', 'routine'])
export type ConversationPriority = z.infer<typeof ConversationPrioritySchema>

/**
 * The slice of the daemon's view stream hub a delivery needs. Injected rather
 * than imported so this module keeps no dependency on the daemon process.
 */
export interface ConversationNoticeBroadcaster {
  broadcast: (channel: 'chat') => void
}

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
  viewStreamHub?: ConversationNoticeBroadcaster
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
  viewStreamHub?: ConversationNoticeBroadcaster,
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
  viewStreamHub?.broadcast('chat')
}

/**
 * Queue a template-authored Notice for the durable conversation. Urgent
 * notices interrupt the visible timeline; routine notices wait for a pause.
 */
export const postConversationNotice = async (
  input: ConversationNoticeInput,
): Promise<{ id: string; delivered: boolean }> => {
  const priority = ConversationPrioritySchema.parse(input.priority)
  const body = 'body' in input
    ? input.body
    : renderConversationNotice(input.kind, input.payload)
  const c = stateClient()
  const id = randomUUID()
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
  const backingEntityId = 'body' in input ? input.backingEntityId ?? null : null
  await c.execute({
    sql: `INSERT INTO conversation_pending_messages (id, body, segments, backing_entity_id, priority, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, body, JSON.stringify(segments), backingEntityId, priority, Date.now()],
  })

  const hasActiveRuns = input.hasActiveRuns?.() ?? (
    await c.execute(`SELECT 1 FROM chat_threads WHERE status IN ('running', 'throttled') LIMIT 1`)
  ).rows.length > 0
  if (priority === 'routine' && hasActiveRuns) return { id, delivered: false }

  await deliverPendingNotice(
    { id, body, segments: JSON.stringify(segments), backing_entity_id: backingEntityId },
    input.viewStreamHub,
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
  viewStreamHub?: ConversationNoticeBroadcaster,
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
    await deliverPendingNotice(row, viewStreamHub)
    delivered++
  }
  return delivered
}
