/**
 * Durable, zero-token delivery of template-authored conversation notices.
 *
 * Routine messages wait while Mars is generating; urgent messages append to
 * the current conversation immediately. Neither path starts a provider run.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveStateClient } from '../store/state-client'
import { appendMessage } from './chat-store'
import {
  renderConversationNotice,
  type AutonomousConversationNoticeInput,
} from './conversation-copy'

const stateClient = resolveStateClient

export const ConversationPrioritySchema = z.enum(['urgent', 'routine'])
export type ConversationPriority = z.infer<typeof ConversationPrioritySchema>

export type ConversationNoticeInput = {
  body: string
  priority: ConversationPriority
  /** Supplied by the daemon when it has an in-memory ChatRunner. */
  hasActiveRuns?: () => boolean
} | (AutonomousConversationNoticeInput & {
  priority: ConversationPriority
  /** Supplied by the daemon when it has an in-memory ChatRunner. */
  hasActiveRuns?: () => boolean
})

interface PendingConversationNotice {
  id: string
  body: string
}

const deliverPendingNotice = async (notice: PendingConversationNotice): Promise<boolean> => {
  const c = stateClient()
  const subject = await c.execute(`
    SELECT id FROM chat_threads
     WHERE closed_at IS NULL
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1
  `)
  const threadId = (subject.rows[0] as { id?: unknown } | undefined)?.id
  if (typeof threadId !== 'string') return false

  await appendMessage(
    threadId,
    'assistant',
    notice.body,
    [{ type: 'text', text: notice.body }],
    { kind: 'notice', contextScope: 'main' },
  )
  await c.execute({
    sql: `UPDATE conversation_pending_messages
            SET delivered_at = ?
          WHERE id = ? AND delivered_at IS NULL`,
    args: [Date.now(), notice.id],
  })
  return true
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
  await c.execute({
    sql: `INSERT INTO conversation_pending_messages (id, body, priority, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [id, body, priority, Date.now()],
  })

  const hasActiveRuns = input.hasActiveRuns?.() ?? (
    await c.execute(`SELECT 1 FROM chat_threads WHERE status IN ('running', 'throttled') LIMIT 1`)
  ).rows.length > 0
  if (priority === 'routine' && hasActiveRuns) return { id, delivered: false }
  return { id, delivered: await deliverPendingNotice({ id, body }) }
}

/** Deliver every routine Notice once the current conversation is paused. */
export const flushRoutineConversationNotices = async (
  hasActiveRuns: () => boolean,
): Promise<number> => {
  if (hasActiveRuns()) return 0
  const c = stateClient()
  const result = await c.execute(`
    SELECT id, body FROM conversation_pending_messages
     WHERE priority = 'routine' AND delivered_at IS NULL
     ORDER BY created_at ASC, id ASC
  `)
  let delivered = 0
  for (const row of result.rows as unknown as PendingConversationNotice[]) {
    if (await deliverPendingNotice(row)) delivered++
  }
  return delivered
}
