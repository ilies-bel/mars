import type { DbClient } from '../lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { advanceCursor, fetchPending } from '../../bus/subscribers.js'
import { processedOnce } from '../../bus/processed-once.js'

/**
 * Shared drain loop for durable outbox Subscribers, implementing the
 * ADR-0032 stall contract:
 *
 *   - Events are processed in ascending id order, at-least-once.
 *   - A handler that throws BLOCKS the cursor on the failing event id and
 *     breaks the loop; the next drain retries from the same event. There is
 *     no dead-letter queue — Mars events are causally dependent, so skipping
 *     a poison terminal would strand every downstream task.
 *   - After K consecutive failures on the SAME event id, a row is written to
 *     the `subscriber_stalls` table and a log line is emitted. The
 *     operator-visible `subscriber-stalled` alert is derived on read from that
 *     table (ADR-0057) — no stored action-queue row is written here. The row is
 *     deleted again as soon as the event processes, so the alert disappears
 *     with the condition.
 *
 * Side effects run at-most-once per (subscriber, event) via `processedOnce`.
 * The dedup row is claimed BEFORE the handler runs, so the claim is exclusive
 * against a concurrent drain of the same subscriber; a handler that throws
 * releases it so the retry contract above still holds.
 *
 * Do NOT reorder this to run the handler first. That shape deduped only the
 * bookkeeping — concurrent drains all passed the "already processed?" check
 * and all executed the side effect. It was survivable while every handler was
 * idempotent (they only touched OPEN rows), but it is not a property the
 * contract can assume: `arc-verifier` shells out and the failure-reflector
 * path spawns headless agents. Under a failure storm that fan-out melted the
 * host. The interval callers are additionally single-flighted in server.ts;
 * this claim is the correctness guarantee, that gate is the pressure relief.
 */

/** Consecutive-failure threshold before a `subscriber_stalls` row is written. */
export const STALL_THRESHOLD = 3

/**
 * In-memory per-(subscriber,event) consecutive-failure counter. The cursor
 * itself is the durable record of progress; this counter only gates WHEN to
 * write the stall row. Losing it across a restart simply resets the K-count
 * (the row is re-inserted after K more failures, and the table's primary key
 * collapses the repeat). Keyed `subscriberId:eventId`.
 */
const failureCounts = new Map<string, number>()

const stallKey = (subscriberId: string, eventId: number): string =>
  `${subscriberId}:${eventId}`

/**
 * Release a claim taken by {@link drainWithStall} when the handler then threw.
 *
 * The ADR-0032 retry contract requires that a failed handler leave the dedup
 * slot unclaimed, so the next drain retries the same event. Because the claim
 * is now taken BEFORE the handler runs (to make it exclusive against a
 * concurrent drain), a handler failure has to undo it explicitly.
 */
async function releaseClaim(
  client: DbClient,
  subscriberId: string,
  eventId: number,
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM subscriber_processed_events
           WHERE subscriber_id = ? AND event_id = ?`,
    args: [subscriberId, eventId],
  })
}

export interface DrainWithStallArgs {
  client: DbClient
  subscriberId: string
  /**
   * Per-event side effect. Return `true` if the event did work (counts
   * toward `processed`), `false` if it was an ignored/no-op event. Throwing
   * blocks the cursor and triggers the stall machinery.
   */
  handle: (event: BusEvent<EventName>) => Promise<boolean>
  log?: (msg: string) => void
}

/**
 * Drain a Subscriber's pending events with the ADR-0032 stall contract.
 * Returns the number of events whose side effect ran.
 */
export async function drainWithStall(
  args: DrainWithStallArgs,
): Promise<{ processed: number }> {
  const { client, subscriberId, handle, log } = args
  const pending = await fetchPending(client, subscriberId)
  let processed = 0

  for (const event of pending) {
    const key = stallKey(subscriberId, event.id)
    try {
      // At-most-once with retry-on-failure. CLAIM FIRST, then run the side
      // effect. `processedOnce` inserts the dedup row inside a transaction and
      // reports ran=false when it already exists, so the claim is atomic
      // against a concurrent drain of the same subscriber.
      //
      // The previous shape ran `handle()` first and claimed afterwards. That
      // deduped only the BOOKKEEPING: two concurrent drains both read "not yet
      // processed", both executed the side effect, and one then lost the
      // insert race. For handlers that merely touch OPEN action-queue rows
      // that is harmless, but for handlers that spawn agents or shell out it
      // multiplies without bound — the failure-reflector fan-out that melted
      // the host came through exactly this door.
      //
      // A handler that THROWS releases the claim below, so the next drain
      // retries it (and the cursor stays put) — the retry path the ADR-0032
      // stall contract depends on is preserved.
      const claim = await processedOnce({
        client,
        subscriberId,
        eventId: event.id,
        sideEffect: async (_tx) => {},
      })
      if (claim.ran) {
        try {
          const did = await handle(event)
          if (did) processed++
        } catch (err) {
          await releaseClaim(client, subscriberId, event.id).catch(() => {
            // Best-effort: if the release fails the event is simply not
            // retried. Losing a retry is strictly safer than holding the
            // cursor against a slot we can no longer clear.
          })
          throw err
        }
      }
      // Success — clear the stall counter and the durable stall entry.
      //
      // The DELETE is unconditional rather than gated on `failureCounts`
      // holding an entry: the counter is in-memory and is lost across a daemon
      // restart, and the most common fix for a real stall IS a restart (so the
      // subscriber re-binds to corrected code). Gating on the counter would
      // strand a stall row written by the previous process forever. The
      // statement is a no-op when no row exists, so running it on every
      // successful event is safe.
      failureCounts.delete(key)
      await client
        .execute({
          sql: `DELETE FROM subscriber_stalls
                 WHERE subscriber_id = ? AND event_id = ?`,
          args: [subscriberId, event.id],
        })
        .catch(() => {
          // Best-effort: failing to clear the stall entry must not re-stall a
          // subscriber that just made progress. The next successful drain of
          // this subscriber retries the delete.
        })
    } catch (err) {
      const lastError = (err as Error).message
      const count = (failureCounts.get(key) ?? 0) + 1
      failureCounts.set(key, count)
      log?.(
        `[${subscriberId}] event ${event.id} (${event.type}) failed ` +
          `(${count} consecutive): ${lastError}`,
      )
      // subscriber-stalled action-queue rows are derived on read from
      // `subscriber_stalls` (ADR-0057), so crossing the threshold has to write
      // that table — it is the only durable record the derivation can see.
      // Every production subscriber drains through this function, so without
      // this write the operator surface for a blocked cursor is silent.
      if (count >= STALL_THRESHOLD) {
        await client
          .execute({
            sql: `INSERT INTO subscriber_stalls (subscriber_id, event_id, last_error, fail_count)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT (subscriber_id, event_id)
                    DO UPDATE SET last_error = EXCLUDED.last_error, fail_count = EXCLUDED.fail_count`,
            args: [subscriberId, event.id, lastError, count],
          })
          .catch((writeErr) => {
            log?.(
              `[${subscriberId}] failed to record subscriber stall: ` +
                `${(writeErr as Error).message}`,
            )
          })
        log?.(
          `[${subscriberId}] stall threshold crossed (${count} consecutive failures on event ${event.id}); ` +
            `condition is visible in the derived action-queue view`,
        )
      }
      // Cursor stays put on the failing event; the next drain retries here.
      break
    }
    await advanceCursor(client, subscriberId, event.id)
  }

  return { processed }
}
