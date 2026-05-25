import type { Client, Transaction } from '@libsql/client';

/**
 * Schema for the per-subscriber dedup table.
 *
 * One row per (subscriber, event) pair successfully processed. The primary
 * key enforces that a Subscriber can never observe a side effect more than
 * once for the same event id, even across daemon restarts.
 */
export const SUBSCRIBER_PROCESSED_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS subscriber_processed_events (
    subscriber_id TEXT    NOT NULL,
    event_id      INTEGER NOT NULL,
    processed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (subscriber_id, event_id)
  )
`;

/**
 * Ensure the dedup table exists on `client`. Safe to call repeatedly;
 * idempotent via `CREATE TABLE IF NOT EXISTS`.
 */
export async function ensureProcessedOnceSchema(client: Client): Promise<void> {
  await client.execute(SUBSCRIBER_PROCESSED_EVENTS_DDL);
}

export interface ProcessedOnceArgs {
  client: Client;
  subscriberId: string;
  eventId: number;
  /**
   * The side effect to execute within the same write transaction as the
   * dedup row. Throwing causes the transaction to roll back — both the
   * dedup row and any work performed by `sideEffect` disappear, so the
   * next invocation re-runs the handler.
   */
  sideEffect: (tx: Transaction) => Promise<void>;
}

export interface ProcessedOnceResult {
  /** `true` when the handler ran, `false` when it was skipped as a duplicate. */
  ran: boolean;
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
 *
 * The caller must have ensured the schema via {@link ensureProcessedOnceSchema}.
 */
export async function processedOnce(
  args: ProcessedOnceArgs,
): Promise<ProcessedOnceResult> {
  const { client, subscriberId, eventId, sideEffect } = args;
  const tx = await client.transaction('write');
  try {
    try {
      await tx.execute({
        sql:
          'INSERT INTO subscriber_processed_events (subscriber_id, event_id) VALUES (?, ?)',
        args: [subscriberId, eventId],
      });
    } catch (err) {
      // UNIQUE constraint violation → this (subscriber, event) pair has
      // already been processed. Roll back and report a skip.
      if (isUniqueConstraint(err)) {
        tx.close();
        return { ran: false };
      }
      throw err;
    }

    await sideEffect(tx);
    await tx.commit();
    return { ran: true };
  } catch (err) {
    try {
      tx.close();
    } catch {
      // already closed
    }
    throw err;
  }
}

function isUniqueConstraint(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  if (e.code === 'SQLITE_CONSTRAINT' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return true;
  }
  return /UNIQUE constraint failed|PRIMARY KEY/i.test(e.message);
}
