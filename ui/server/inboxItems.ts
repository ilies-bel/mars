import type { DraftFeature, StateDb, Task, TaskDb, TaskStatus } from './db.ts'

/**
 * Source tag attached to every item in the unified inbox list.
 *
 * - `'draft'`   — proposal/idea row in state.db with `status='draft'`
 * - `'blocked'` — task row in queue.db with `status='blocked'`
 * - `'failed'`  — task row in queue.db with `status='dropped'` (post-retry
 *                 terminal failure that still needs operator review)
 *
 * Mapping note: a response item tagged `'failed'` corresponds to the DB
 * status `'dropped'`. The user-facing wording is "failed" — the PRD treats
 * post-retry-budget tasks as needing review even though the schema calls
 * them dropped. The `'failed'` task status (mid-flight, may still recover)
 * is NOT surfaced here.
 *
 * `task_suggestions` rows are NOT surfaced here under any source.
 */
export type InboxItemSource = 'draft' | 'blocked' | 'failed'

/**
 * Draft proposal as an inbox item. The proposal table also carries its own
 * `source` column (`human` | `reflection` | `planner`), but the inbox-item
 * `source` is the *origin tag* ('draft' | 'blocked' | 'failed') and takes
 * precedence here. The original proposal source is preserved under
 * `proposalSource` so callers can still distinguish human vs. agent-authored
 * drafts.
 */
export interface InboxDraftItem extends Omit<DraftFeature, 'source'> {
  source: 'draft'
  proposalSource: DraftFeature['source']
}

export interface InboxBlockedItem extends Task {
  source: 'blocked'
}

export interface InboxFailedItem extends Task {
  source: 'failed'
}

export type InboxItem = InboxDraftItem | InboxBlockedItem | InboxFailedItem

const isInboxItemSource = (raw: string): raw is InboxItemSource =>
  raw === 'draft' || raw === 'blocked' || raw === 'failed'

/**
 * Parse the `?source=` query argument.
 *
 * Returns the matching `InboxItemSource` when present and valid, `undefined`
 * when the param is omitted (caller wants everything), or `'invalid'` when
 * the caller passed an unrecognised value — endpoints translate that into
 * a 400.
 */
export const parseSourceParam = (
  raw: string | null,
): InboxItemSource | undefined | 'invalid' => {
  if (raw === null) return undefined
  if (!isInboxItemSource(raw)) return 'invalid'
  return raw
}

/**
 * Aggregate the unified inbox view as a flat list with each item tagged by
 * its origin source. When `source` is omitted, every source contributes;
 * when set, only that source is returned.
 *
 * Tolerates missing tables (fresh repo) by treating the absent source as
 * empty.
 */
export const listInboxItems = async (
  db: TaskDb,
  stateDb: StateDb,
  source?: InboxItemSource,
): Promise<InboxItem[]> => {
  const items: InboxItem[] = []

  if (source === undefined || source === 'draft') {
    const proposalsExist = await stateDb.proposalsTableExists()
    if (proposalsExist) {
      const drafts = await stateDb.listDraftFeatures()
      for (const d of drafts) {
        const { source: proposalSource, ...rest } = d
        items.push({ ...rest, source: 'draft', proposalSource })
      }
    }
  }

  const wantBlocked = source === undefined || source === 'blocked'
  const wantFailed = source === undefined || source === 'failed'
  if (wantBlocked || wantFailed) {
    const tasksExist = await db.tableExists()
    if (tasksExist) {
      const statuses: TaskStatus[] = []
      if (wantBlocked) statuses.push('blocked')
      if (wantFailed) statuses.push('dropped')
      const tasks = await db.listTasksByStatus(statuses)
      for (const t of tasks) {
        if (t.status === 'blocked' && wantBlocked) {
          items.push({ ...t, source: 'blocked' })
        } else if (t.status === 'dropped' && wantFailed) {
          items.push({ ...t, source: 'failed' })
        }
      }
    }
  }

  return items
}
