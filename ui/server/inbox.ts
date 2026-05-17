import type { DraftFeature, StateDb, Task, TaskDb } from './db.ts'

export interface InboxData {
  drafts: DraftFeature[]
  blocked: Task[]
  failed: Task[]
}

/**
 * Aggregate the inbox view: draft ideas plus blocked and failed tasks.
 *
 * Pure read-only aggregation — issues no writes and tolerates missing
 * tables (a fresh repo whose schema has not been created yet) by
 * returning empty groups instead of throwing.
 */
export const aggregateInbox = async (
  db: TaskDb,
  stateDb: StateDb,
): Promise<InboxData> => {
  const ideasExist = await stateDb.ideasTableExists()
  const drafts = ideasExist ? await stateDb.listDraftFeatures() : []
  const tasksExist = await db.tableExists()
  // Bucket query: deliberately restricted to status='blocked' OR
  // status='failed'. These are the only two task states that require
  // operator attention.
  //
  // status='dropped' is intentionally excluded. A dropped task is
  // superseded or cancelled work — a decision already made, not a
  // human-review item. Surfacing dropped rows here would re-open closed
  // questions and bloat the inbox with noise. If a future reader is
  // tempted to add 'dropped' to this list to "show everything", DON'T:
  // the inbox is the human-review queue, not a task archive.
  //
  // Source filtering is also intentionally NOT performed server-side —
  // callers receive every draft/blocked/failed row and slice client-side.
  const inboxTasks = tasksExist
    ? await db.listTasksByStatus(['blocked', 'failed'])
    : []
  const blocked = inboxTasks.filter((t) => t.status === 'blocked')
  const failed = inboxTasks.filter((t) => t.status === 'failed')
  return { drafts, blocked, failed }
}
