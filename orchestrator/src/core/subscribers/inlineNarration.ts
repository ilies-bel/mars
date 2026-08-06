/**
 * Inline narration subscriber — writes a lightweight `inline_event` row into
 * the main thread for each narratable outbox event while the operator is present.
 *
 * Presence gate: when the operator is away the subscriber still advances its
 * cursor (so it does not replay on return) but writes nothing. Events that
 * arrive during an away span are held for the away-digest subscriber's
 * independent cursor.
 *
 * Narratable events:
 *   - task.terminal  reason=done    → "Task <id> landed"
 *   - task.terminal  reason=failed  → "Task <id> stumbled"
 *   - task.blocked                  → "Task <id> needs attention"
 */

import { randomUUID } from 'node:crypto'
import type { DbClient } from '../lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../daemon/subscriber-drain.js'
import { registerSubscriberName } from '../../outbox/registry.js'
import { MAIN_THREAD_ID } from '../lib/pg-schema.js'

export const INLINE_NARRATION_SUBSCRIBER = 'inline-narration'
registerSubscriberName(INLINE_NARRATION_SUBSCRIBER)

/** The two presence states the gate reads from the caller-supplied function. */
export type PresenceMode = 'present' | 'away'

/**
 * Register the durable subscriber cursor. Call once during daemon startup,
 * before any events are published. Idempotent — safe to call on every boot.
 */
export async function ensureInlineNarration(client: DbClient): Promise<void> {
  await registerSubscriber(client, INLINE_NARRATION_SUBSCRIBER, { replay: false })
}

/**
 * Drain pending outbox events through the inline-narration gate.
 *
 * `getMode` is called once per event so the gate can change between drains
 * (e.g. the operator leaves mid-drain). Injected for testability: in
 * production pass a closure over the daemon's live presence state.
 */
export async function drainInlineNarration(
  client: DbClient,
  getMode: () => Promise<PresenceMode>,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: INLINE_NARRATION_SUBSCRIBER,
    handle: async (event: BusEvent<EventName>) => {
      if ((await getMode()) !== 'present') return false

      const payload = event.payload as Record<string, unknown>
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : null

      let text: string
      if (event.type === 'task.terminal') {
        const reason = payload.reason
        if (reason === 'done') {
          text = `Task ${taskId ?? 'unknown'} landed`
        } else if (reason === 'failed') {
          text = `Task ${taskId ?? 'unknown'} stumbled`
        } else {
          return false
        }
      } else if (event.type === 'task.blocked') {
        text = `Task ${taskId ?? 'unknown'} needs attention`
      } else {
        return false
      }

      await client.execute({
        sql: `INSERT INTO chat_messages
                (id, thread_id, role, content, segments, created_at, context_scope, kind, backing_entity_id)
              VALUES (?, ?, 'assistant', ?, ?, ?, 'main', 'inline_event', ?)`,
        args: [
          randomUUID(),
          MAIN_THREAD_ID,
          text,
          JSON.stringify([{ type: 'text', text }]),
          Date.now(),
          taskId,
        ],
      })
      return true
    },
  })
}
