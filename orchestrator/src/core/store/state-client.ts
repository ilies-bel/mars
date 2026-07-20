/**
 * Seam-internal DB client resolver for the state domain (ADR-0034: tasks and
 * proposals share one database — now the embedded PostgreSQL instance the
 * daemon provisions per repo, migration 0002).
 *
 * This is the single handle the state-domain modules (proposals.ts,
 * ideas/idea-store.ts) and the {@link DomainStateStore} front. It collapses
 * the previously-duplicated private `getClient()` singletons into one. NOT a
 * public/domain escape hatch (ADR-0021): only the state seam and the
 * state-domain modules import it.
 *
 * `openDb` keeps one shared client per (backend, target) per process, so this
 * resolver and `resolveQueueClient` hand back handles onto the same pool
 * (wire) or PGlite instance (tests) — the two facades keep the *domain
 * vocabularies* separate, not the connections.
 *
 * Lives in its own module (no domain imports) so the domain modules can import
 * the resolver without forming an import cycle with `state-store.ts`.
 */

import { openDb, type DbClient } from '../lib/db.js'
import { resolveDbTarget } from '../context'

let stateClientSingleton: DbClient | null = null

export const resolveStateClient = (): DbClient => {
  if (stateClientSingleton) return stateClientSingleton
  stateClientSingleton = openDb(resolveDbTarget())
  return stateClientSingleton
}

/**
 * Test-only: drop the cached state client so a subsequent `resolveStateClient`
 * reopens against whatever `MARS_REPO` is current.
 */
export const __resetStateClientForTests = (): void => {
  stateClientSingleton = null
}
