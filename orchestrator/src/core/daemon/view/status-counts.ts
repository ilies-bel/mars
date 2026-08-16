/**
 * Daemon-side status-counts view: the four canonical operational counts.
 *
 * A single SQL query computes running, recovering, needYou, failed, and
 * doneToday so every UI surface that renders these numbers fetches from one
 * authoritative source rather than deriving them per-page.
 *
 * Semantics:
 * - running:    tasks whose status ∈ {running, verifying, merging, vega-reconciling}
 * - recovering: tasks whose status = 'under_investigation'
 * - needYou:    open action-queue items that are not draft-proposals
 * - failed:     failed tasks that are not recovery tasks (fix_for_task_id IS NULL)
 * - doneToday:  tasks completed in the last 24 hours (rolling window; same
 *               window as ProgressAggregates.doneToday)
 */

import type { DbClient } from '../../lib/db.js'

export interface StatusCounts {
  running: number
  recovering: number
  needYou: number
  failed: number
  doneToday: number
}

export interface StatusCountsStore {
  readStatusCounts(): Promise<StatusCounts>
}

export const createStatusCountsStore = (client: DbClient): StatusCountsStore => ({
  async readStatusCounts() {
    const r = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM tasks
           WHERE status IN ('running', 'verifying', 'merging', 'vega-reconciling')) AS running,
        (SELECT COUNT(*) FROM tasks
           WHERE status = 'under_investigation') AS recovering,
        (SELECT COUNT(*) FROM action_queue_items
           WHERE status = 'open' AND kind != 'draft-proposal') AS need_you,
        (SELECT COUNT(*) FROM tasks
           WHERE status = 'failed' AND fix_for_task_id IS NULL) AS failed,
        (SELECT COUNT(*) FROM tasks
           WHERE status = 'done' AND updated_at >= now() - interval '1 day') AS done_today
    `)
    const row = r.rows[0] as unknown as Record<string, unknown>
    return {
      running: Number(row?.running ?? 0),
      recovering: Number(row?.recovering ?? 0),
      needYou: Number(row?.need_you ?? 0),
      failed: Number(row?.failed ?? 0),
      doneToday: Number(row?.done_today ?? 0),
    }
  },
})

export const buildStatusCountsView = (store: StatusCountsStore): Promise<StatusCounts> =>
  store.readStatusCounts()
