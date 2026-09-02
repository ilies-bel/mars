/**
 * ArcStorePort — minimal persistence interface for the Arc aggregate (ADR-0101).
 *
 * The Arc aggregate is the sole writer of the `tasks` / `task_blockers` tables
 * (ADR-0052). It only ever calls `query`, `execute`, `batch`, and `atomic` —
 * never the domain-level methods on `DomainTaskStore` such as `enqueueTask` or
 * `dropTask`. Expressing the parameter type as `ArcStorePort` (instead of the
 * full `DomainTaskStore`) lets Arc import this leaf without pulling in
 * `store/task-store`, which imports Arc back and would close a cycle.
 *
 * `DomainTaskStore` is structurally compatible with `ArcStorePort` — it
 * implements every method here — so callers that thread a `DomainTaskStore`
 * into Arc methods continue to type-check without changes (TypeScript's
 * structural typing).
 *
 * Rule: this file MUST NOT import from `../arc`, `../queue`, or
 * `../store/task-store`. Import from `../lib/queue-client` for the raw client.
 */

import type { DbStatement, DbInValue, DbResultSet } from '../lib/db'
import { withTransaction } from '../lib/db'
import { ensureQueueSchema, resolveQueueClient } from '../lib/queue-client'

// ── Interface ─────────────────────────────────────────────────────────────────

/**
 * Transaction scope handed to {@link ArcStorePort.atomic} callbacks. Exposes
 * only read + write — no commit / rollback controls, no raw client handle.
 * Not exported: callers accept `ArcStorePort` and let TypeScript infer the
 * callback parameter — importing `ArcScope` by name is never necessary.
 */
interface ArcScope {
  query(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  execute(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
}

/**
 * The persistence methods Arc actually uses. A strict subset of
 * `DomainTaskStore`; everything else is domain logic that belongs in
 * `task-store.ts` / `queue.ts`.
 */
export interface ArcStorePort {
  query(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  execute(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  batch(stmts: DbStatement[], mode?: 'write' | 'read' | 'deferred'): Promise<DbResultSet[]>
  atomic<T>(fn: (scope: ArcScope) => Promise<T>): Promise<T>
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const toStmt = (stmt: DbStatement | string, params?: DbInValue[]): DbStatement => {
  if (typeof stmt === 'string') return params === undefined ? stmt : { sql: stmt, args: params }
  return stmt
}

const buildStore = (): ArcStorePort => {
  return {
    async query(stmt, params) {
      return resolveQueueClient().execute(toStmt(stmt, params))
    },
    async execute(stmt, params) {
      return resolveQueueClient().execute(toStmt(stmt, params))
    },
    async batch(stmts, _mode) {
      return resolveQueueClient().batch(stmts, 'write')
    },
    async atomic<T>(fn: (scope: ArcScope) => Promise<T>): Promise<T> {
      return withTransaction(resolveQueueClient(), async (tx) => {
        const scope: ArcScope = {
          query: (s, p) => tx.execute(toStmt(s, p)),
          execute: (s, p) => tx.execute(toStmt(s, p)),
        }
        return fn(scope)
      })
    },
  }
}

// ── Exported factories ────────────────────────────────────────────────────────

/**
 * Synchronous composition-root accessor. The schema is expected to already
 * exist when this is called — the daemon (and every init flow) runs
 * `ensureQueueSchema` at startup.
 *
 * Note: unlike `getDefaultTaskStore`, this factory does NOT carry the
 * worktree cross-boundary guard. Arc's static methods (`Arc.load`,
 * `Arc.createOrigin`, …) are never invoked from inside a dispatched worker
 * without an explicit store being passed in — the dispatch path always injects
 * the store via DI. The guard in `getDefaultTaskStore` is left in place
 * for all other callers of that function.
 */
export const getDefaultArcStoreSync = (): ArcStorePort => buildStore()

/**
 * Async composition-root accessor. Ensures the schema exists before returning
 * the store.
 */
export const getDefaultArcStore = async (): Promise<ArcStorePort> => {
  await ensureQueueSchema()
  return buildStore()
}
