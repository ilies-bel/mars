import type { Client } from '@libsql/client'
import type { BusEvent, EventName } from '../../bus/events.js'
import { advanceCursor, fetchPending } from '../../bus/subscribers.js'
import {
  ensureProcessedOnceSchema,
  processedOnce,
} from '../../bus/processed-once.js'
import {
  raiseActionQueueItem,
  supersedeActionQueueItemsBySignature,
} from '../lib/action-queue.js'

/**
 * Shared drain loop for durable outbox Subscribers, implementing the
 * ADR-0032 stall contract:
 *
 *   - Events are processed in ascending id order, at-least-once.
 *   - A handler that throws BLOCKS the cursor on the failing event id and
 *     breaks the loop; the next drain retries from the same event. There is
 *     no dead-letter queue — Mars events are causally dependent, so skipping
 *     a poison terminal would strand every downstream task.
 *   - After K consecutive failures on the SAME event id, a
 *     `subscriber-stalled` actionQueue row is raised so the otherwise-silent stall
 *     gets an operator surface (the actionQueue is the single human-facing work
 *     surface).
 *   - When a previously-blocked event finally processes, the stalled row is
 *     superseded (the lightweight `subscriber.unstalled` recovery).
 *
 * Side effects run at-most-once per (subscriber, event) via `processedOnce`.
 * The side effect is idempotent (it only touches OPEN rows), so the
 * Phase-2-after-commit shape that cross-DB deployments force is benign: a
 * crash between the dedup commit and a re-run just replays a no-op.
 */

/** Consecutive-failure threshold before a stalled actionQueue row is raised. */
export const STALL_THRESHOLD = 3

/**
 * In-memory per-(subscriber,event) consecutive-failure counter. The cursor
 * itself is the durable record of progress; this counter only gates WHEN to
 * raise the stalled actionQueue row, so losing it across a restart simply resets
 * the K-count (the row is re-raised after K more failures, and dedup on
 * (kind, signature) collapses repeats). Keyed `subscriberId:eventId`.
 */
const failureCounts = new Map<string, number>()

const stallKey = (subscriberId: string, eventId: number): string =>
  `${subscriberId}:${eventId}`

/**
 * Read-only check of the at-most-once dedup table: has this (subscriber,
 * event) pair already been successfully processed? Used to skip re-running a
 * counting side effect on a re-drain without claiming the slot (the claim
 * happens only after a fresh successful handler run).
 */
async function alreadyProcessed(
  client: Client,
  subscriberId: string,
  eventId: number,
): Promise<boolean> {
  const r = await client.execute({
    sql: `SELECT 1 FROM subscriber_processed_events
           WHERE subscriber_id = ? AND event_id = ? LIMIT 1`,
    args: [subscriberId, eventId],
  })
  return r.rows.length > 0
}

const stallSignature = (subscriberId: string, eventId: number): string =>
  `${subscriberId}:${eventId}`

export interface DrainWithStallArgs {
  client: Client
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
  await ensureProcessedOnceSchema(client)
  const pending = await fetchPending(client, subscriberId)
  let processed = 0

  for (const event of pending) {
    const key = stallKey(subscriberId, event.id)
    try {
      // At-most-once with retry-on-failure. Read the dedup slot first: if the
      // side effect already succeeded for this (subscriber, event), skip it
      // — re-running would double-apply a counting side effect (e.g. bump an
      // actionQueue row's seen_count). If not yet processed, run the handler; only
      // on success claim the dedup slot. A handler that THROWS leaves the
      // slot unclaimed, so the next drain retries (and the cursor stays put
      // below) — that retry path is what the stall contract depends on.
      const already = await alreadyProcessed(client, subscriberId, event.id)
      if (!already) {
        const did = await handle(event)
        await processedOnce({
          client,
          subscriberId,
          eventId: event.id,
          sideEffect: async (_tx) => {},
        })
        if (did) processed++
      }
      // Success — clear any stall counter and close a stalled row if one was
      // raised for this event (subscriber.unstalled recovery).
      // supersedeActionQueueItemsBySignature is called unconditionally because
      // failureCounts is in-memory and is lost across daemon restarts. The
      // most common fix for a real stall is a daemon restart (so the subscriber
      // re-binds to corrected code), which clears failureCounts. Without this
      // unconditional call, a persisted subscriber-stalled row opened in the
      // previous process would never be closed by the restarted daemon even
      // after the event processes successfully. The call is a no-op when no
      // matching open row exists, so calling it on every success is safe.
      failureCounts.delete(key)
      await supersedeActionQueueItemsBySignature(
        'subscriber-stalled',
        stallSignature(subscriberId, event.id),
        'subscriber-unstalled',
        `subscriber:${subscriberId}`,
      ).catch(() => {
        // best-effort: failing to close the stalled row must not re-stall
      })
    } catch (err) {
      const lastError = (err as Error).message
      const count = (failureCounts.get(key) ?? 0) + 1
      failureCounts.set(key, count)
      log?.(
        `[${subscriberId}] event ${event.id} (${event.type}) failed ` +
          `(${count} consecutive): ${lastError}`,
      )
      if (count >= STALL_THRESHOLD) {
        await raiseSubscriberStalled({
          subscriberId,
          eventId: event.id,
          eventName: event.type,
          lastError,
        }).catch((raiseErr) => {
          log?.(
            `[${subscriberId}] failed to raise subscriber-stalled item: ` +
              `${(raiseErr as Error).message}`,
          )
        })
      }
      // Cursor stays put on the failing event; the next drain retries here.
      break
    }
    await advanceCursor(client, subscriberId, event.id)
  }

  return { processed }
}

interface SubscriberStalledInput {
  subscriberId: string
  eventId: number
  eventName: string
  lastError: string
}

async function raiseSubscriberStalled(
  input: SubscriberStalledInput,
): Promise<void> {
  const signature = stallSignature(input.subscriberId, input.eventId)
  await raiseActionQueueItem({
    kind: 'subscriber-stalled',
    category: 'orchestrator',
    priority: 'high',
    title: `Subscriber ${input.subscriberId} stalled on event ${input.eventId} (${input.eventName})`,
    body:
      `The durable subscriber '${input.subscriberId}' has failed to process ` +
      `event ${input.eventId} (${input.eventName}) ${STALL_THRESHOLD}+ times in a row. ` +
      `Its cursor is blocked on this event and will not advance until the ` +
      `handler succeeds — every later event for this subscriber is waiting ` +
      `behind it. There is no dead-letter queue (ADR-0032): the block is ` +
      `deliberate so a poison event cannot silently strand downstream work.\n\n` +
      `Last error:\n\`\`\`\n${input.lastError}\n\`\`\``,
    payload: {
      subscriberId: input.subscriberId,
      eventId: input.eventId,
      eventName: input.eventName,
      lastError: input.lastError,
    },
    context: {},
    raisedBy: `subscriber:${input.subscriberId}`,
    // Dedup on (kind, signature) collapses repeat raises onto one row and
    // lets the unstall path close it by the same signature.
    signature,
  })
}
