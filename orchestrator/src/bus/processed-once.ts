import { withTransaction, type DbClient, type DbTx } from '../core/lib/db.js';

/**
 * Per-subscriber dedup over the `subscriber_processed_events` table (schema
 * owned by `core/lib/pg-schema.ts`).
 *
 * One row per (subscriber, event) pair successfully processed. The primary
 * key enforces that a Subscriber can never observe a side effect more than
 * once for the same event id, even across daemon restarts.
 */

export interface ProcessedOnceArgs {
  client: DbClient;
  subscriberId: string;
  eventId: number;
  /**
   * The side effect to execute within the same write transaction as the
   * dedup row. Throwing causes the transaction to roll back — both the
   * dedup row and any work performed by `sideEffect` disappear, so the
   * next invocation re-runs the handler.
   */
  sideEffect: (tx: DbTx) => Promise<void>;
}

export interface ProcessedOnceResult {
  /** `true` when the handler ran, `false` when it was skipped as a duplicate. */
  ran: boolean;
}

/** Sentinel thrown inside `withTransaction` to signal "already processed". */
class AlreadyProcessedSignal extends Error {
  constructor() {
    super('already-processed')
  }
}

/**
 * Run a Subscriber's side effect at most once per (subscriberId, eventId)
 * pair, durably.
 *
 * Inserts the dedup row and runs `sideEffect` inside the same write
 * transaction. If the row already exists the insert throws a UNIQUE
 * constraint error and the side effect is skipped — replay is structurally
 * impossible, not convention-policed.
 *
 * If `sideEffect` throws, the transaction is rolled back; no dedup row is
 * left behind, so the next call re-runs the handler.
 */
export async function processedOnce(
  args: ProcessedOnceArgs,
): Promise<ProcessedOnceResult> {
  const { client, subscriberId, eventId, sideEffect } = args;
  try {
    await withTransaction(client, async (tx) => {
      try {
        await tx.execute({
          sql:
            'INSERT INTO subscriber_processed_events (subscriber_id, event_id) VALUES (?, ?)',
          args: [subscriberId, eventId],
        });
      } catch (err) {
        // UNIQUE constraint violation → this (subscriber, event) pair has
        // already been processed. Throw the sentinel so withTransaction
        // rolls back cleanly, then signal a skip to the caller.
        if (isUniqueConstraint(err)) {
          throw new AlreadyProcessedSignal();
        }
        throw err;
      }
      await sideEffect(tx);
    });
    return { ran: true };
  } catch (err) {
    if (err instanceof AlreadyProcessedSignal) {
      return { ran: false };
    }
    throw err;
  }
}

function isUniqueConstraint(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  // PostgreSQL unique_violation; both pg and PGlite surface the SQLSTATE
  // on `code`, with the message fallback covering any wrapper re-throw.
  if (e.code === '23505') return true;
  return /duplicate key value violates unique constraint/i.test(e.message);
}
