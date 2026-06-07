/**
 * Mastra-side re-export of the wire-bus `publish()` helpers.
 *
 * The implementation lives in `src/bus/publisher.ts` and is the only
 * sanctioned way to write to the `events` outbox table from inside a
 * libsql write transaction. Mastra-tree call sites import it from
 * here to keep the boundary explicit (and to give us a single place
 * to add cross-cutting concerns later: tracing, redaction, etc.).
 *
 * ADR-0052 sole-writer: every lifecycle `INSERT/UPDATE-status/DELETE` on
 * `tasks` lives in the Arc aggregate (`core/arc.ts`) and calls
 * `publish(tx, '<event>', { ... })` / `buildEventInsert(...)` inside the same
 * tx, so the row-change and its outbox event commit atomically. The arch test
 * in `__tests__/arc-sole-writer.test.ts` enforces this by construction:
 * `core/arc.ts` is the ONLY file allowed to write the task table, and it must
 * emit (call `publish(` / `buildEventInsert(`).
 */
export { publish, publishWithRetry, buildEventInsert, withWriteTx } from '../../bus/publisher.js'
export type { RetryOpts } from '../../bus/publisher.js'
export type { EventName, EventPayload } from '../../bus/events.js'
