import { initQueue } from '../mastra/queue'
import { initIdeas } from '../mastra/ideas'
import { initInbox } from '../mastra/lib/inbox'

/**
 * Eagerly materialise the per-repo SQLite databases that `mars` writes into
 * at runtime — `.mars/queue.db` (tasks) and `.mars/state.db` (ideas + inbox)
 * — so a freshly scaffolded repo is usable without first having to wait for
 * the daemon to lazily create them on the next write.
 *
 * Every init path uses `CREATE TABLE IF NOT EXISTS`, so calling this on a
 * repo that already has populated databases is a safe no-op.
 */
export const initDatabases = async (): Promise<void> => {
  // Order matters: `initIdeas` runs `initQueue` internally to align FK
  // expectations, but we call it explicitly first so the queue's own
  // migrations land before any ideas-side `ALTER TABLE` ordering kicks in.
  await initQueue()
  await initIdeas()
  await initInbox()
}
