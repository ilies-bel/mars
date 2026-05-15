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
  const inboxTasks = tasksExist
    ? await db.listTasksByStatus(['blocked', 'failed'])
    : []
  const blocked = inboxTasks.filter((t) => t.status === 'blocked')
  const failed = inboxTasks.filter((t) => t.status === 'failed')
  return { drafts, blocked, failed }
}
