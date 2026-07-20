import {
  withTransaction,
  type DbClient,
  type DbStatement,
  type DbTx,
} from '../core/lib/db.js';
import { EventMap, type EventName, type EventPayload } from './events.js';

/**
 * Validate `payload` against the registered Zod schema for `type` and
 * return the `INSERT INTO events` statement ready to pass to a transaction
 * or batch.
 *
 * The `events.id` column is `GENERATED ALWAYS AS IDENTITY`; no caller
 * consumes the generated id at insert time, so no `RETURNING id` clause is
 * needed (add one at the call site if that ever changes).
 *
 * Throws if the type is unknown or the payload fails Zod validation — let
 * the caller decide whether to propagate or swallow. When called upfront
 * (before opening a transaction), a validation error surfaces before any DB
 * write is attempted.
 */
export function buildEventInsert<T extends EventName>(
  type: T,
  payload: EventPayload<T>,
): DbStatement {
  const schema = EventMap[type];
  if (!schema) {
    throw new Error(`Unknown event type: ${String(type)}`);
  }
  const validated = schema.parse(payload);
  return {
    sql: 'INSERT INTO events (type, payload) VALUES (?, ?)',
    args: [type as string, JSON.stringify(validated)],
  };
}

/**
 * Publish an event to the outbox.
 *
 * Validates `payload` against the registered zod schema for `type` and
 * inserts a row into `events`. Call inside an active write transaction so
 * the event commits atomically with the state row it describes.
 *
 * Throws if the payload fails validation; the surrounding transaction
 * will then roll back, leaving no orphan event or partial state.
 */
export async function publish<T extends EventName>(
  tx: DbTx,
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  const stmt = buildEventInsert(type, payload);
  await tx.execute(stmt);
}

/**
 * Open a write transaction on `client`, run `fn` inside it, then commit.
 * Any error thrown by `fn` rolls the transaction back and surfaces to the
 * caller.
 *
 * Historically this carried SQLITE_BUSY retry + reconnect machinery; under
 * PostgreSQL MVCC that contention class no longer exists, so this is a plain
 * {@link withTransaction} wrapper kept for its call-site shape.
 */
export async function withWriteTx<T>(
  client: DbClient,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return withTransaction(client, fn);
}

/**
 * Publish an event to the outbox, opening and committing its own write
 * transaction on `client`.
 *
 * Throws if the payload fails validation or the insert fails; nothing is
 * committed in that case.
 */
export async function publishWithRetry<T extends EventName>(
  client: DbClient,
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  return withWriteTx(client, (tx) => publish(tx, type, payload));
}
