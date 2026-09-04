/**
 * Daemon-side counts view: unified count of all task lifecycle buckets plus
 * proposals in one query, so every UI surface that renders these numbers
 * fetches from one authoritative source.
 *
 * Running breakdown: verifying and merging are surfaced separately so the
 * board header can display granular pipeline stages without a second query.
 * The top-level `running` total still follows the same predicate as
 * viewStatusCounts — tasks in {running, verifying, merging, vega-reconciling}.
 *
 * needsYou is deliberately NOT sourced from a SQL COUNT over
 * action_queue_items: condition kinds (failed, stale-queued, gate-broken, …)
 * are derived on read (ADR-0057) and have no stored row. The caller
 * (viewCounts in app-services.ts) sources needsYou from viewActionQueue('open')
 * via countNeedsYou — the single canonical definition shared by the triage
 * badge, sidebar badge, and situation card.
 *
 * proposals.draft / proposals.total are skipped gracefully when the proposals
 * table does not yet exist (fresh repo before first `mars init`).
 *
 * Semantics:
 * - running:         tasks in {running, verifying, merging, vega-reconciling}
 * - verifying:       tasks with status = 'verifying'
 * - merging:         tasks with status = 'merging'
 * - queued:          tasks with status = 'queued'
 * - blocked:         tasks with status = 'blocked'
 * - failed:          failed tasks that are not recovery tasks (fix_for_task_id IS NULL)
 * - doneToday:       tasks completed in the last 24 hours (rolling window)
 * - proposals.draft: proposals with status = 'draft'
 * - proposals.total: all proposals regardless of status
 */

import type { DbClient } from '../../lib/db.js'

export interface Counts {
  needsYou: number
  running: number
  verifying: number
  merging: number
  queued: number
  blocked: number
  failed: number
  doneToday: number
  proposals: {
    draft: number
    total: number
  }
}

export interface CountsStore {
  readCounts(): Promise<Omit<Counts, 'needsYou'>>
}

export const createCountsStore = (client: DbClient): CountsStore => ({
  async readCounts() {
    const r = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM tasks
           WHERE status IN ('running', 'verifying', 'merging', 'vega-reconciling')) AS running,
        (SELECT COUNT(*) FROM tasks WHERE status = 'verifying')                       AS verifying,
        (SELECT COUNT(*) FROM tasks WHERE status = 'merging')                         AS merging,
        (SELECT COUNT(*) FROM tasks WHERE status = 'queued')                          AS queued,
        (SELECT COUNT(*) FROM tasks WHERE status = 'blocked')                         AS blocked,
        (SELECT COUNT(*) FROM tasks
           WHERE status = 'failed' AND fix_for_task_id IS NULL)                       AS failed,
        (SELECT COUNT(*) FROM tasks
           WHERE status = 'done' AND updated_at >= now() - interval '1 day')          AS done_today,
        (SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'proposals'
        ))                                                                            AS proposals_exist,
        (SELECT CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'proposals'
         ) THEN (SELECT COUNT(*) FROM proposals WHERE status = 'draft') ELSE 0 END)  AS proposals_draft,
        (SELECT CASE WHEN EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'proposals'
         ) THEN (SELECT COUNT(*) FROM proposals) ELSE 0 END)                          AS proposals_total
    `)
    const row = r.rows[0] as unknown as Record<string, unknown>
    return {
      running: Number(row?.running ?? 0),
      verifying: Number(row?.verifying ?? 0),
      merging: Number(row?.merging ?? 0),
      queued: Number(row?.queued ?? 0),
      blocked: Number(row?.blocked ?? 0),
      failed: Number(row?.failed ?? 0),
      doneToday: Number(row?.done_today ?? 0),
      proposals: {
        draft: Number(row?.proposals_draft ?? 0),
        total: Number(row?.proposals_total ?? 0),
      },
    }
  },
})

export const buildCountsView = (
  store: CountsStore,
  needsYou: number,
): Promise<Counts> =>
  store.readCounts().then((counts) => ({ ...counts, needsYou }))
