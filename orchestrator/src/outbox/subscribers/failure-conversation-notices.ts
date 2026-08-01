import type { DbClient } from '../../core/lib/db.js'
import { causeForSignature } from '../../core/lib/failure-signature.js'
import { postConversationNotice } from '../../core/lib/conversation-delivery.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../../core/daemon/subscriber-drain.js'
import { registerSubscriberName } from '../registry.js'

/** Durable cursor for coalesced task-blocked conversation Notices. */
export const FAILURE_CONVERSATION_NOTICE_SUBSCRIBER = 'failure-conversation-notices'
registerSubscriberName(FAILURE_CONVERSATION_NOTICE_SUBSCRIBER)

/** A matching failure has this long to join an open Notice. */
export const FAILURE_NOTICE_COALESCE_MS = 30_000

const scheduledFlushes = new WeakMap<DbClient, ReturnType<typeof setTimeout>>()

export async function ensureFailureConversationNoticeSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, FAILURE_CONVERSATION_NOTICE_SUBSCRIBER, { replay: false })
}

/**
 * Record newly-blocked tasks by their canonical failure signature. Replayed
 * outbox events are claimed by drainWithStall before this handler runs, so a
 * replay cannot inflate the persisted count.
 */
export async function drainFailureConversationNotices(
  client: DbClient,
  now: () => number = Date.now,
  log?: (message: string) => void,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: FAILURE_CONVERSATION_NOTICE_SUBSCRIBER,
    log,
    handle: async (event: BusEvent<EventName>) => {
      await flushFailureConversationNotices(client, now())
      if (event.type !== 'task.blocked') return false

      const payload = event.payload as { taskId: string; failureSignature: string }
      const open = await client.execute({
        sql: `SELECT id, event_count, entity_ids_json
                FROM conversation_notice_batches
               WHERE cause_key = ? AND flushed_at IS NULL
               LIMIT 1`,
        args: [payload.failureSignature],
      })

      if (open.rows.length === 0) {
        await client.execute({
          sql: `INSERT INTO conversation_notice_batches
                  (cause_key, opened_at, event_count, entity_ids_json)
                VALUES (?, ?, ?, ?)`,
          args: [payload.failureSignature, now(), 1, JSON.stringify([payload.taskId])],
        })
        return true
      }

      const batch = open.rows[0] as unknown as {
        id: number | bigint
        event_count: number | bigint
        entity_ids_json: string
      }
      const entityIds = JSON.parse(batch.entity_ids_json) as unknown
      const ids = Array.isArray(entityIds)
        ? entityIds.filter((id): id is string => typeof id === 'string')
        : []
      if (ids.includes(payload.taskId)) return false

      ids.push(payload.taskId)
      await client.execute({
        sql: `UPDATE conversation_notice_batches
                SET event_count = ?, entity_ids_json = ?
              WHERE id = ? AND flushed_at IS NULL`,
        args: [ids.length, JSON.stringify(ids), batch.id],
      })
      return true
    },
  })
}

/**
 * Append every due batch once. The resulting chat message is never updated:
 * later failures use a new row after this row receives its immutable flushed
 * timestamp.
 */
export async function flushFailureConversationNotices(
  client: DbClient,
  now = Date.now(),
): Promise<number> {
  const due = await client.execute({
    sql: `SELECT id, cause_key, event_count, entity_ids_json
            FROM conversation_notice_batches
           WHERE flushed_at IS NULL AND opened_at + ? <= ?
           ORDER BY opened_at ASC, id ASC`,
    args: [FAILURE_NOTICE_COALESCE_MS, now],
  })

  let flushed = 0
  for (const row of due.rows) {
    const batch = row as unknown as {
      id: number | bigint
      cause_key: string
      event_count: number | bigint
      entity_ids_json: string
    }
    const parsedIds = JSON.parse(batch.entity_ids_json) as unknown
    const firstTaskId = Array.isArray(parsedIds) && typeof parsedIds[0] === 'string'
      ? parsedIds[0]
      : 'affected task'
    const cause = causeForSignature(batch.cause_key, firstTaskId)
      ?? `tasks failed with ${batch.cause_key}`

    await postConversationNotice({
      kind: 'failure.batch',
      payload: { taskCount: Number(batch.event_count), cause },
      priority: 'urgent',
    })
    const result = await client.execute({
      sql: `UPDATE conversation_notice_batches
              SET flushed_at = ?
            WHERE id = ? AND flushed_at IS NULL`,
      args: [now, batch.id],
    })
    if (result.rowsAffected > 0) flushed++
  }
  return flushed
}

/** Schedule the earliest open batch at its precise coalescing deadline. */
export async function scheduleFailureConversationNoticeFlush(
  client: DbClient,
  log?: (message: string) => void,
): Promise<void> {
  const existing = scheduledFlushes.get(client)
  if (existing) clearTimeout(existing)

  const open = await client.execute(
    `SELECT opened_at FROM conversation_notice_batches
      WHERE flushed_at IS NULL
      ORDER BY opened_at ASC, id ASC
      LIMIT 1`,
  )
  if (open.rows.length === 0) {
    scheduledFlushes.delete(client)
    return
  }

  const openedAt = Number((open.rows[0] as { opened_at: number | bigint }).opened_at)
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await flushFailureConversationNotices(client)
        await scheduleFailureConversationNoticeFlush(client, log)
      } catch (error) {
        log?.(`[failure-conversation-notices] flush failed: ${(error as Error).message}`)
      }
    })()
  }, Math.max(0, openedAt + FAILURE_NOTICE_COALESCE_MS - Date.now()))
  timer.unref()
  scheduledFlushes.set(client, timer)
}

export function clearFailureConversationNoticeFlush(client: DbClient): void {
  const timer = scheduledFlushes.get(client)
  if (timer) clearTimeout(timer)
  scheduledFlushes.delete(client)
}
