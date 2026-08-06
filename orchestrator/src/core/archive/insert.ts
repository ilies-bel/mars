/**
 * Archive-entries writer and durable Outbox Subscriber.
 *
 * Resolved Alerts (`action-queue.resolved`), ack'd Notices (wired inline in
 * the HTTP handler), and silently-completed tasks (`task.terminal { reason:
 * 'done' }`) all land here. Insertion is always silent — no Card or
 * action-queue row is ever raised from this table.
 *
 * The subscriber uses `processedOnce` so replaying the same outbox event id
 * never produces a duplicate archive entry, even across daemon restarts.
 */

import { randomUUID } from 'node:crypto'
import type { DbTx } from '../lib/db.js'
import type { DbClient } from '../lib/db.js'
import { processedOnce } from '../../bus/processed-once.js'
import type { BusEvent } from '../../bus/events.js'
import type { Subscriber } from '../../outbox/dispatcher.js'
import { registerSubscriberName } from '../../outbox/registry.js'
import { registerSubscriber, fetchPending, advanceCursor } from '../../bus/subscribers.js'

// ── Public types ──────────────────────────────────────────────────────────────

export type ArchiveSourceKind = 'alert' | 'notice' | 'silent_completion' | 'subject'

export interface ArchiveSource {
  /** Specific disposition: e.g. 'resolved', 'acked', 'done'. */
  kind: string
  /** Category of the originating entity. */
  sourceKind: ArchiveSourceKind
  /** Id of the originating entity (action-queue item id, message id, task id). */
  sourceId: string
  /** Free-form context captured at archive time. Never raises a Card. */
  provenance?: Record<string, unknown>
}

// ── Core insert ──────────────────────────────────────────────────────────────

/**
 * Insert one archive entry. Accepts a `DbTx` so it can be called either
 * directly (with a plain `DbClient`, which extends `DbTx`) or inside a
 * `processedOnce` sideEffect callback (which receives a transaction object).
 *
 * Insertion is silent by contract: callers that want non-fatal behaviour
 * should wrap in a try/catch — this function itself never raises an
 * action-queue item.
 */
export async function archiveEntry(tx: DbTx, source: ArchiveSource): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO archive_entries
            (id, kind, source_kind, source_id, occurred_at, provenance)
          VALUES (?, ?, ?, ?, now(), ?::jsonb)`,
    args: [
      randomUUID(),
      source.kind,
      source.sourceKind,
      source.sourceId,
      JSON.stringify(source.provenance ?? {}),
    ],
  })
}

// ── Durable Outbox Subscriber ─────────────────────────────────────────────────

/** Unique name for the durable archive-entries subscriber cursor. */
export const ARCHIVE_ENTRIES_SUBSCRIBER = 'archive-entries'
registerSubscriberName(ARCHIVE_ENTRIES_SUBSCRIBER)

/**
 * Register the archive-entries subscriber cursor. Idempotent — re-registering
 * an existing cursor is a no-op that preserves its position.
 *
 * Pass `{ replay: false }` so a freshly-provisioned cursor starts at the
 * current Outbox head and observes only future events.
 */
export async function ensureArchiveEntriesSubscriber(client: DbClient): Promise<void> {
  await registerSubscriber(client, ARCHIVE_ENTRIES_SUBSCRIBER, { replay: false })
}

/**
 * Build the archive-entries `Subscriber` objects.
 *
 * Two event types are handled:
 *   - `action-queue.resolved` → `source_kind: 'alert'`
 *   - `task.terminal { reason: 'done' }` → `source_kind: 'silent_completion'`
 *
 * The handler uses `processedOnce` for at-most-once idempotency across daemon
 * restarts. Calling `subscriber.handler(event)` directly is safe for tests.
 */
export function buildArchiveSubscribers(client: DbClient): Subscriber[] {
  return [archiveEntriesSubscriber(client)]
}

function archiveEntriesSubscriber(client: DbClient): Subscriber {
  return {
    name: ARCHIVE_ENTRIES_SUBSCRIBER,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type === 'action-queue.resolved') {
        const p = event.payload as {
          itemId: string
          fromState: string
          toState: string
          by: string
        }
        await processedOnce({
          client,
          subscriberId: ARCHIVE_ENTRIES_SUBSCRIBER,
          eventId: event.id,
          sideEffect: async (tx) => {
            await archiveEntry(tx, {
              kind: 'resolved',
              sourceKind: 'alert',
              sourceId: p.itemId,
              provenance: { fromState: p.fromState, toState: p.toState, by: p.by },
            })
          },
        })
      } else if (event.type === 'task.terminal') {
        const p = event.payload as { taskId: string; reason: string }
        if (p.reason !== 'done') return
        await processedOnce({
          client,
          subscriberId: ARCHIVE_ENTRIES_SUBSCRIBER,
          eventId: event.id,
          sideEffect: async (tx) => {
            await archiveEntry(tx, {
              kind: 'done',
              sourceKind: 'silent_completion',
              sourceId: p.taskId,
              provenance: { reason: p.reason },
            })
          },
        })
      }
    },
  }
}

// ── Production drain ──────────────────────────────────────────────────────────

/**
 * Drain all pending outbox events, inserting one archive entry per matching
 * event. Events of unhandled types advance the cursor without side effect.
 *
 * The handler is idempotent via `processedOnce`, so replaying a successfully
 * processed event id is a no-op.
 *
 * @returns The number of events whose cursor was advanced.
 */
export async function drainArchiveEntries(
  client: DbClient,
): Promise<{ processed: number }> {
  const [subscriber] = buildArchiveSubscribers(client)
  const pending = await fetchPending(client, ARCHIVE_ENTRIES_SUBSCRIBER)
  let processed = 0

  for (const event of pending) {
    await subscriber.handler(event)
    await advanceCursor(client, ARCHIVE_ENTRIES_SUBSCRIBER, event.id)
    processed++
  }

  return { processed }
}
