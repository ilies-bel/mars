import { runCompositionRootMigrations } from '../core/store/task-store'
import { initProposals } from '../core/proposals'
import { initActionQueue } from '../core/lib/action-queue'
import { initSettings } from '../core/lib/settings'
import { initWorkflowConfigs } from '../core/workflow-configs'
import { mergeLegacyDatabases } from './merge-databases'

/**
 * Eagerly materialise the per-repo SQLite databases that `mars` writes into
 * at runtime — a single `.mars/mars.db` (tasks + proposals + actionQueue; see
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
  // Order matters: `initProposals` runs the queue migration internally to align
  // FK expectations, but we run the queue migration explicitly first (through
  // the TaskStore seam) so the queue's own migrations land before any
  // proposals-side `ALTER TABLE` ordering kicks in.
  await runCompositionRootMigrations()
  await initProposals()
  await initActionQueue()
  await initSettings()
  await initWorkflowConfigs()
}
