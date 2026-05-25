import type { Client, Transaction } from '@libsql/client';
import { EventMap, type EventName, type EventPayload } from './events.js';

/**
 * Publish an event to the outbox.
 *
 * Validates `payload` against the registered zod schema for `type` and
 * inserts a row into `events`. Call inside an active libsql write
 * transaction so the event commits atomically with the state row it
 * describes.
 *
 * Throws if the payload fails validation; the surrounding transaction
 * will then roll back, leaving no orphan event or partial state.
 */
export async function publish<T extends EventName>(
  tx: Transaction,
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  const schema = EventMap[type];
  if (!schema) {
    throw new Error(`Unknown event type: ${String(type)}`);
  }
  const validated = schema.parse(payload);
  await tx.execute({
    sql: 'INSERT INTO events (type, payload) VALUES (?, ?)',
    args: [type, JSON.stringify(validated)],
  });
}

/** Options for {@link publishWithRetry}. All fields are optional; defaults match the PRD. */
export interface RetryOpts {
  /** Maximum number of attempts including the first (default 5). */
  attempts?: number;
  /** Base delay in ms for exponential backoff (default 10). */
  baseMs?: number;
  /** Jitter factor in [0, 1] applied as ±jitter×exp (default 0.5 → ±50%). */
  jitter?: number;
  /** Upper cap on computed delay in ms (default 200). */
  capMs?: number;
}

function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string };
  return e.code === 'SQLITE_BUSY' || e.message.includes('database is locked');
}

/**
 * Publish an event to the outbox, opening and committing its own write
 * transaction.
 *
 * On a SQLITE_BUSY error (code `'SQLITE_BUSY'` or message containing
 * `'database is locked'`) retries with bounded jittered exponential
 * backoff; rethrows the original error once all attempts are exhausted.
 *
 * Default retry parameters: 5 attempts, 10 ms base, ±50% jitter, 200 ms cap.
 */
export async function publishWithRetry<T extends EventName>(
  client: Client,
  type: T,
  payload: EventPayload<T>,
  opts?: RetryOpts,
): Promise<void> {
  const maxAttempts = opts?.attempts ?? 5;
  const baseMs = opts?.baseMs ?? 10;
  const jitter = opts?.jitter ?? 0.5;
  const capMs = opts?.capMs ?? 200;

  let firstBusyErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const tx = await client.transaction('write');
      try {
        await publish(tx, type, payload);
        await tx.commit();
        return;
      } catch (err) {
        tx.close();
        throw err;
      }
    } catch (err) {
      if (!isSqliteBusy(err)) {
        throw err;
      }
      if (firstBusyErr === undefined) {
        firstBusyErr = err;
      }
      if (attempt < maxAttempts - 1) {
        // Reconnect to get a fresh underlying SQLite connection. The libsql
        // local backend leaves the connection in an unusable state after a
        // SQLITE_BUSY on BEGIN IMMEDIATE; without this, every subsequent
        // transaction attempt on the same client returns
        // "cannot commit transaction - SQL statements in progress".
        await client.reconnect();
        const exp = Math.min(baseMs * 2 ** attempt, capMs);
        const jitterFactor = 1 - jitter + Math.random() * jitter * 2;
        await new Promise<void>(r => setTimeout(r, exp * jitterFactor));
      }
    }
  }

  throw firstBusyErr;
}
