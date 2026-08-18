/**
 * Daemon-side status-counts view: running/recovering/failed/doneToday in one
 * SQL query, so every UI surface that renders these numbers fetches from one
 * authoritative source rather than deriving them per-page.
 *
 * needYou is deliberately NOT computed here: it is NOT a literal row count
 * over `action_queue_items`, because condition kinds (failed, stale-queued,
 * gate-broken, …) are derived on read (ADR-0057) and have no stored row. A
 * SQL COUNT over the table undercounts. The caller (`viewStatusCounts` in
 * app-services.ts) sources needYou from the same `viewActionQueue('open')`
 * feed the triage badge, sidebar badge, and situation card all read from —
 * see `countNeedsYou` in `lib/situation-report.ts` for the shared definition.
 *
 * Semantics:
 * - running:    tasks whose status ∈ {running, verifying, merging, vega-reconciling}
 * - recovering: tasks whose status = 'under_investigation'
 * - failed:     failed tasks that are not recovery tasks (fix_for_task_id IS NULL)
 * - doneToday:  tasks completed in the last 24 hours (rolling window; same
 *               window as ProgressAggregates.doneToday)
 */

import type { DbClient } from '../../lib/db.js'

export interface StatusCounts {
  running: number
  recovering: number
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
        (SELECT COUNT(*) FROM tasks
           WHERE status = 'failed' AND fix_for_task_id IS NULL) AS failed,
        (SELECT COUNT(*) FROM tasks
           WHERE status = 'done' AND updated_at >= now() - interval '1 day') AS done_today
    `)
    const row = r.rows[0] as unknown as Record<string, unknown>
    return {
      running: Number(row?.running ?? 0),
      recovering: Number(row?.recovering ?? 0),
      failed: Number(row?.failed ?? 0),
      doneToday: Number(row?.done_today ?? 0),
    }
  },
})

export const buildStatusCountsView = (store: StatusCountsStore): Promise<StatusCounts> =>
  store.readStatusCounts()
