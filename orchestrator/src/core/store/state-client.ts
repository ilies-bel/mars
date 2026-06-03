/**
 * Seam-internal libsql client resolver for state.db (`.mars/mars.db`, ADR-0034:
 * tasks and proposals share one file).
 *
 * This is the single connection the state-domain modules (proposals.ts,
 * action-queue-dismissals.ts, ideas/idea-store.ts) and the {@link DomainStateStore}
 * front. It collapses the three previously-duplicated private `getClient()`
 * singletons into one. NOT a public/domain escape hatch (ADR-0021): only the
 * state seam and the state-domain modules import it.
 *
 * Lives in its own module (no domain imports) so the domain modules can import
 * the resolver without forming an import cycle with `state-store.ts`.
 */

import { openLibsql } from '../lib/libsql'
import { resolveContext } from '../context'
import type { Client } from '@libsql/client'

let stateClientSingleton: Client | null = null

export const resolveStateClient = (): Client => {
  if (stateClientSingleton) return stateClientSingleton
  const { stateDbPath } = resolveContext()
  stateClientSingleton = openLibsql({ url: `file:${stateDbPath}` })
  return stateClientSingleton
}

/**
 * Test-only: drop the cached state client so a subsequent `resolveStateClient`
 * reopens against whatever `MARS_REPO` is current.
 */
export const __resetStateClientForTests = (): void => {
  stateClientSingleton = null
}
