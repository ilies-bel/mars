/**
 * terminalMatcher — watches outbox events and, when a Subject's declared
 * terminal condition fires, flips its alert status to 'resolved' and raises
 * exactly one Closure card.
 *
 * The Subject itself is NOT closed — lifecycle_status (`closed_at`) remains
 * null. The operator acts on the Closure card to actually close the Subject.
 *
 * Matching logic:
 *   - `event.type` must equal `subject.terminal_event_type`.
 *   - If `subject.terminal_entity_id` is set, at least one string value in
 *     the event payload must equal it (covers `taskId`, `proposalId`, etc.).
 *   - Only Subjects with `closed_at IS NULL` and `alert_resolved = 0` are
 *     candidates so a re-fired event never double-processes a resolved Subject.
 *
 * Idempotency: `raiseClosureCard` checks for an existing Closure card before
 * inserting, so calling it more than once for the same Subject is safe.
 */

import { randomUUID } from 'node:crypto'
import type { DbClient } from '../lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from '../daemon/subscriber-drain.js'
import { registerSubscriberName } from '../../outbox/registry.js'

export const TERMINAL_MATCHER_SUBSCRIBER = 'terminal-matcher'
registerSubscriberName(TERMINAL_MATCHER_SUBSCRIBER)

/**
 * Register the durable subscriber cursor. Idempotent — safe to call on every
 * daemon boot before events are published.
 */
export async function ensureTerminalMatcher(client: DbClient): Promise<void> {
  await registerSubscriber(client, TERMINAL_MATCHER_SUBSCRIBER, { replay: false })
}

/** Minimal view of a `chat_threads` row sufficient for terminal matching. */
export interface SubjectTerminalView {
  id: string
  terminal_event_type: string | null
  terminal_entity_id: string | null
}

/**
 * Pure predicate: returns `true` when `event` satisfies the Subject's
 * declared terminal condition.
 *
 * - A null `terminal_event_type` means no condition is declared → always false.
 * - A null `terminal_entity_id` means "any entity" → match on type alone.
 * - Otherwise at least one string value in the event payload must equal
 *   `terminal_entity_id`.
 */
export function matchTerminal(
  subject: SubjectTerminalView,
  event: BusEvent<EventName>,
): boolean {
  if (!subject.terminal_event_type) return false
  if (event.type !== subject.terminal_event_type) return false
  if (!subject.terminal_entity_id) return true
  const payload = event.payload as Record<string, unknown>
  return Object.values(payload).some((v) => v === subject.terminal_entity_id)
}

/**
 * Flip the Subject's alert status to 'resolved' and insert one Closure card.
 *
 * - Sets `alert_resolved = 1` so the sidebar renders the alert as resolved.
 * - Does NOT touch `closed_at` — the Subject remains open (lifecycle_status
 *   stays 'open') until the operator accepts the Closure card.
 * - Skips card insertion when a Closure card for this Subject already exists,
 *   making this function safe to call more than once.
 */
export async function raiseClosureCard(
  client: DbClient,
  subject: SubjectTerminalView,
): Promise<void> {
  const now = Date.now()
  await client.execute({
    sql: `UPDATE chat_threads SET alert_resolved = 1, updated_at = ? WHERE id = ?`,
    args: [now, subject.id],
  })
  const existing = await client.execute({
    sql: `SELECT id FROM cards WHERE kind = 'closure' AND subject_id = ?`,
    args: [subject.id],
  })
  if (existing.rows.length === 0) {
    await client.execute({
      sql: `INSERT INTO cards (id, kind, subject_id, autonomy_level, producer_key, body, created_at)
            VALUES (?, 'closure', ?, 'tell', 'terminal-matcher', '', ?)`,
      args: [randomUUID(), subject.id, now],
    })
  }
}

/**
 * Drain pending outbox events through the terminal-matcher gate.
 *
 * For each event, queries open Subjects whose `terminal_event_type` equals
 * the event type and whose alert has not yet been resolved. For each matching
 * Subject, flips `alert_resolved` to 1 and inserts a Closure card.
 *
 * Returns `{ processed }` where `processed` counts events that matched at
 * least one Subject.
 */
export async function drainTerminalMatcher(
  client: DbClient,
): Promise<{ processed: number }> {
  return drainWithStall({
    client,
    subscriberId: TERMINAL_MATCHER_SUBSCRIBER,
    handle: async (event: BusEvent<EventName>) => {
      const result = await client.execute({
        sql: `SELECT id, terminal_event_type, terminal_entity_id
              FROM chat_threads
              WHERE terminal_event_type = ? AND closed_at IS NULL AND alert_resolved = 0`,
        args: [event.type],
      })
      const subjects = result.rows as unknown as SubjectTerminalView[]
      let matched = false
      for (const subject of subjects) {
        if (matchTerminal(subject, event)) {
          await raiseClosureCard(client, subject)
          matched = true
        }
      }
      return matched
    },
  })
}
