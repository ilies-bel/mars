import type { Client, InStatement, ResultSet } from '@libsql/client'

/**
 * Deep seam over `.mars/queue.db`. Per ADR-0021 the TaskStore is the only
 * interface lib/cousin modules use to reach queue data — the raw libsql
 * `Client` never crosses the seam.
 *
 * This first slice introduces TaskStore as a minimal pass-through:
 *
 * - `query` is the read-only side door (SELECTs). Today it shares a code
 *   path with `execute`; a later slice tightens it to libsql's `'read'`
 *   mode so write attempts fail closed.
 * - `execute` is the single-statement write side door.
 *
 * `atomic(fn)` (callback-scoped multi-statement transactions) and typed
 * domain methods land in subsequent slices.
 */
export interface TaskStore {
  query(stmt: InStatement): Promise<ResultSet>
  execute(stmt: InStatement): Promise<ResultSet>
}

/**
 * Wrap an existing libsql `Client` as a `TaskStore`. Used at the composition
 * root for production wiring, and in tests over an in-memory client.
 */
export const createLibsqlTaskStore = (client: Client): TaskStore => ({
  query: (stmt) => client.execute(stmt),
  execute: (stmt) => client.execute(stmt),
})

let cachedDefaultStore: TaskStore | null = null

/**
 * Composition-root convenience: lazily run the queue migrations, then return
 * a TaskStore backed by the queue module's singleton client. Callers that
 * already receive a TaskStore via dependency injection (the eventual end
 * state per ADR-0021) should ignore this helper.
 *
 * Exists during the migration so call sites can drop their direct
 * `getClient()/initQueue()` imports without simultaneously rewiring the
 * composition root.
 */
export const getDefaultTaskStore = async (): Promise<TaskStore> => {
  if (cachedDefaultStore) return cachedDefaultStore
  const { initQueue, getClient } = await import('../queue')
  await initQueue()
  cachedDefaultStore = createLibsqlTaskStore(getClient())
  return cachedDefaultStore
}

/**
 * Test-only: drop the cached default store so a subsequent
 * `getDefaultTaskStore()` rebuilds against whatever queue client is current.
 */
export const __resetDefaultTaskStoreForTests = (): void => {
  cachedDefaultStore = null
}
