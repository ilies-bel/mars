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
 *   - After K consecutive failures on the SAME event id, the in-memory
 *     {@link failureCounts} counter crosses {@link STALL_THRESHOLD} and a log
 *     line is emitted. The operator-visible `subscriber-stalled` alert is
 *     derived on read from the `subscriber_stalls` table (written by
 *     `outbox/stall.ts`); no stored action-queue row is written here.
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

/** Consecutive-failure threshold before the stall-threshold log line fires. */
export const STALL_THRESHOLD = 3

/**
 * In-memory per-(subscriber,event) consecutive-failure counter. The cursor
 * itself is the durable record of progress; this counter only gates WHEN to
 * log the stall-threshold notice. Losing it across a restart simply resets
 * the K-count (the log is emitted again after K more failures).
 * Keyed `subscriberId:eventId`.
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
      // Success — clear any stall counter.
      // subscriber-stalled rows are derived on read from subscriber_stalls;
      // once the event processes, the stall entry disappears automatically
      // (the DB write from stall.ts is absent for a succeeded event), so no
      // stored row needs closing here.
      failureCounts.delete(key)
    } catch (err) {
      const lastError = (err as Error).message
      const count = (failureCounts.get(key) ?? 0) + 1
      failureCounts.set(key, count)
      log?.(
        `[${subscriberId}] event ${event.id} (${event.type}) failed ` +
          `(${count} consecutive): ${lastError}`,
      )
      // subscriber-stalled rows are now derived on read from subscriber_stalls;
      // no stored row is written here. The failureCounts counter still gates
      // logging so the daemon log shows when a stall threshold is crossed.
      if (count >= STALL_THRESHOLD) {
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
