import { initQueue } from '../mastra/queue'
import { initProposals } from '../mastra/proposals'
import { initInbox } from '../mastra/lib/inbox'
import { mergeLegacyDatabases } from './merge-databases'

/**
 * Eagerly materialise the per-repo SQLite databases that `mars` writes into
 * at runtime — a single `.mars/mars.db` (tasks + proposals + inbox; see
 * ADR-0034) — so a freshly scaffolded repo is usable without first having
 * to wait for the daemon to lazily create them on the next write.
 *
 * Every init path uses `CREATE TABLE IF NOT EXISTS`, so calling this on a
 * repo that already has populated databases is a safe no-op.
 */
export const initDatabases = async (): Promise<void> => {
  // Lift any repo still on the historical queue.db + state.db layout up
  // to the merged `mars.db` BEFORE any client opens the new path —
  // otherwise the libsql client materialises an empty mars.db and the
  // merge sentinel never fires.
  await mergeLegacyDatabases()
  // Order matters: `initProposals` runs `initQueue` internally to align FK
  // expectations, but we call it explicitly first so the queue's own
  // migrations land before any proposals-side `ALTER TABLE` ordering kicks in.
  await initQueue()
  await initProposals()
  await initInbox()
}
