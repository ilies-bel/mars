/**
 * Mastra-side re-export of the wire-bus `publish()` helper.
 *
 * The implementation lives in `src/bus/publisher.ts` and is the only
 * sanctioned way to write to the `events` outbox table from inside a
 * libsql write transaction. Mastra-tree call sites import it from
 * here to keep the boundary explicit (and to give us a single place
 * to add cross-cutting concerns later: tracing, redaction, etc.).
 *
 * Phase 1 (in progress): wrap every `INSERT/UPDATE/DELETE` on
 * `tasks` and `task_blockers` in a libsql write transaction and call
 * `publish(tx, '<event>', { ... })` inside the same tx. Once all four
 * allowlisted writer files (`queue.ts`, `queue-fix-tasks.ts`,
 * `queue-retry.ts`, `blocker-resolution.ts`) route through this
 * helper, the arch test in `__tests__/db-writes-eventful.test.ts`
 * flips its `it.todo` assertions to real `it()`.
 */
export { publish } from '../../bus/publisher.js'
export type { EventName, EventPayload } from '../../bus/events.js'
