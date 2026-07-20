import type { DbClient } from '../core/lib/db.js';
import type { BusEvent } from '../bus/events.js';
import { publishWithRetry } from '../bus/publisher.js';
import { startDispatcher, type Subscriber, type Dispatcher } from './dispatcher.js';

/** Consecutive-failure threshold before a stall is declared. */
export const STALL_THRESHOLD = 3;

/**
 * A running stall-aware dispatcher handle.
 * Identical interface to {@link Dispatcher} — stall detection is transparent
 * to callers.
 */
export type StallAwareDispatcher = Dispatcher;

/**
 * Start a stall-aware dispatcher. Each Subscriber's handler is wrapped with
 * consecutive-failure tracking. When a handler fails {@link STALL_THRESHOLD}
 * times in a row on the same event id:
 *
 *   1. A single stall row is inserted into `subscriber_stalls` (PRIMARY KEY
 *      dedup prevents duplicates on further failures in the same run or after
 *      a restart).
 *   2. A `subscriber.stalled` event is written to the Outbox so observers can
 *      react.
 *
 * The cursor stays blocked on the failing event — a stalled Subscriber does
 * not advance until the handler eventually succeeds. Other Subscribers
 * continue to advance independently.
 *
 * The `subscriber_stalls` table is part of the canonical schema
 * (`core/lib/pg-schema.ts` — `ensureSchema`); production init applies it
 * before any dispatcher starts.
 */
export function startStallAwareDispatcher(
  client: DbClient,
  subscribers: Subscriber[],
  opts?: { pollMs?: number },
): StallAwareDispatcher {
  // In-memory consecutive-failure counters. Keyed `subscriberId:eventId`.
  // Reset to 0 on a successful handler return. Losing this state across
  // a restart only delays the re-raise by STALL_THRESHOLD additional failures
  // — the stall row's PRIMARY KEY dedup collapses the re-insert, keeping
  // exactly one row per (subscriber, event).
  const failureCounts = new Map<string, number>();

  // Tracks which (subscriber, event) pairs have already triggered a stall
  // declaration in this process lifetime. Prevents re-emitting the
  // `subscriber.stalled` Outbox event on every additional failure past the
  // threshold (the stall row dedup handles the DB side; this handles the
  // event side).
  const declared = new Set<string>();

  const wrapped: Subscriber[] = subscribers.map(sub => ({
    name: sub.name,
    handler: async (event: BusEvent): Promise<void> => {
      const key = `${sub.name}:${event.id}`;
      try {
        await sub.handler(event);
        // If a stall row exists in the DB for this (subscriber, event), emit
        // subscriber.unstalled so the Invalidator can close it durably. We
        // check the DB rather than the in-memory `declared` set so a daemon
        // restart between the stall insert and this success path still emits
        // the closing event.
        const hadStall = await client
          .execute({
            sql: 'SELECT 1 FROM subscriber_stalls WHERE subscriber_id = ? AND event_id = ? LIMIT 1',
            args: [sub.name, event.id],
          })
          .then(r => r.rows.length > 0)
          .catch(() => false);
        if (hadStall) {
          await publishWithRetry(client, 'subscriber.unstalled', {
            subscriberId: sub.name,
            eventId: event.id,
          }).catch(() => {
            // Best-effort: Outbox emission failure must not mask the handler
            // success. The stall row will remain open until the next successful
            // attempt re-emits the event.
          });
        }
        // Success — reset stall tracking for this (subscriber, event).
        failureCounts.delete(key);
        declared.delete(key);
      } catch (err) {
        const lastError = err instanceof Error ? err.message : String(err);
        const count = (failureCounts.get(key) ?? 0) + 1;
        failureCounts.set(key, count);

        if (count >= STALL_THRESHOLD && !declared.has(key)) {
          declared.add(key);

          // Insert stall row. PRIMARY KEY dedup means a re-insert after a
          // restart is a silent no-op, so the operator always sees at most
          // one open row per (subscriber, event).
          await client
            .execute({
              sql: `INSERT INTO subscriber_stalls
                      (subscriber_id, event_id, last_error)
                    VALUES (?, ?, ?)
                    ON CONFLICT (subscriber_id, event_id) DO NOTHING`,
              args: [sub.name, event.id, lastError],
            })
            .catch(() => {
              // Best-effort: a DB error here must not mask the original handler
              // failure that caused the stall.
            });

          // Emit subscriber.stalled to the Outbox so observers can react.
          await publishWithRetry(client, 'subscriber.stalled', {
            subscriberId: sub.name,
            eventId: event.id,
            lastError,
          }).catch(() => {
            // Best-effort: Outbox emission failure must not mask the original
            // handler failure.
          });
        }

        // Re-throw so the underlying dispatcher leaves the cursor in place.
        throw err;
      }
    },
  }));

  return startDispatcher(client, wrapped, opts);
}
