/**
 * Dependency-free leaf module for the shared task+state database client and its
 * memoized schema guarantee.
 *
 * ADR-0101 (item 1) prescribes this extraction: `resolveQueueClient` /
 * `ensureQueueSchema` are pure plumbing with no directional ownership story —
 * they write no `tasks`/`task_blockers` rows themselves, so they need no
 * `arc-sole-writer` allowlist entry — yet they used to live in `core/queue.ts`,
 * which imports the `Arc` aggregate for its facade verbs. Anything inside the
 * aggregate (`core/arc.ts`, `core/arc/*`) that needed a raw client therefore had
 * to import `core/queue.ts` and close a cycle.
 *
 * This module imports only `core/context` (a filesystem/env leaf) and
 * `core/lib/db` + `core/lib/pg-schema`, so importing it can never close a cycle
 * back through the aggregate. `core/queue.ts` re-exports both symbols so its
 * ~200 existing importers keep their current import site; new call sites inside
 * `core/arc*` must import from HERE, not from the facade, or the cycle comes
 * straight back.
 */
import { resolveDbTarget } from '../context'
import { markSchemaReady, openDb, type DbClient } from './db'
import { ensureSchema } from './pg-schema'

let clientSingleton: DbClient | null = null

/**
 * Seam-internal DB client resolver for the shared task+state database
 * (ADR-0034: tasks and proposals share one store; migration 0002: the store
 * is embedded PostgreSQL, resolved via `resolveDbTarget`). NOT part of the
 * public surface (ADR-0021): the only sanctioned importer is the TaskStore
 * seam (`store/task-store.ts`), which threads it to callers via the injected
 * store. No live module outside the store may import this — `getClient` is
 * gone.
 */
export const resolveQueueClient = (): DbClient => {
  if (!clientSingleton) {
    clientSingleton = openDb(resolveDbTarget())
  }
  return clientSingleton
}

/**
 * Seam-internal, memoized schema guarantee (ADR-0021: schema management lives
 * behind the store). The canonical DDL is `ensureSchema` in
 * `core/lib/pg-schema.ts` (migration 0002) — the old ~1300-line imperative
 * `migrateQueueSchema` introspection engine is gone. Queue's domain
 * functions call this defensively before touching tables; the TaskStore runs
 * `ensureSchema` itself on its own init path.
 */
let schemaReady: Promise<void> | null = null

export const ensureQueueSchema = (): Promise<void> => {
  if (!schemaReady) {
    // Call markSchemaReady after the DDL completes so that the first
    // execute() / batch() call on this client doesn't re-run ensureSchema.
    // Direct ensureSchema callers bypass ensureClientSchema and therefore
    // never update schemaReadyByTarget; without this, every test that calls
    // migrateQueueSchema() followed by a resolveStateClient().execute() pays
    // an extra ~10 s DDL pass on PGlite-backed databases.
    schemaReady = ensureSchema(resolveQueueClient()).then(() => {
      markSchemaReady(resolveQueueClient())
    })
  }
  return schemaReady
}
