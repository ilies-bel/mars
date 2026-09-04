/**
 * Auto-archive eviction sweep for closed Subjects.
 *
 * Re-scores all closed non-archived Subjects and archives any whose
 * `relevance_score` has decayed below a configurable threshold. The sweep is
 * read-consistent: it uses a single `nowMs` snapshot so all scores in one
 * pass are comparable.
 *
 * Archiving (setting `archived_at`) hides a Subject from the transcript and
 * the rail without deleting any data — this is the same operation as
 * `archiveSubthread` in `chat-store.ts`, but performed directly against the
 * caller-supplied `DbClient` so the function is testable with an in-process
 * PGlite instance without touching the global `stateClient`.
 */

import type { DbClient } from '../lib/db.js'
import { scoreAndPersistAllClosed } from './relevance-store.js'

/** Options for {@link runEvictionSweep}. */
export interface EvictionSweepOpts {
  /**
   * Subjects whose `relevance_score` is strictly below this value are archived.
   * Defaults to `parseFloat(process.env.MARS_EVICTION_THRESHOLD ?? '0.1')`.
   */
  threshold?: number
  /**
   * Epoch-millisecond "now" used for scoring. Defaults to `Date.now()`.
   * Pass an explicit value in tests to keep scores deterministic.
   */
  nowMs?: number
}

/**
 * Re-score all closed non-archived Subjects and archive those whose relevance
 * has decayed below `threshold`.
 *
 * Steps:
 *   1. Call `scoreAndPersistAllClosed(client, nowMs)` to refresh every
 *      closed non-archived Subject's `relevance_score`.
 *   2. Query for Subjects with `relevance_score < threshold`.
 *   3. Archive each by stamping `archived_at` (equivalent to `archiveSubthread`).
 *
 * @returns `{ scored, evicted }` — counts for observability.
 */
export async function runEvictionSweep(
  client: DbClient,
  opts?: EvictionSweepOpts,
): Promise<{ scored: number; evicted: number }> {
  const threshold =
    opts?.threshold ?? parseFloat(process.env.MARS_EVICTION_THRESHOLD ?? '0.1')
  const nowMs = opts?.nowMs ?? Date.now()

  const scored = await scoreAndPersistAllClosed(client, nowMs)

  const result = await client.execute({
    sql: `SELECT id FROM chat_threads
           WHERE closed_at IS NOT NULL
             AND archived_at IS NULL
             AND relevance_score IS NOT NULL
             AND relevance_score < ?`,
    args: [threshold],
  })

  const ids = (result.rows as unknown as Array<{ id: string }>).map((r) => r.id)

  for (const id of ids) {
    // Stamp archived_at — same effect as archiveSubthread(id), but uses the
    // caller-supplied client rather than the module-level stateClient so
    // tests can use an in-process DB without global state.
    await client.execute({
      sql: `UPDATE chat_threads SET archived_at = ? WHERE id = ? AND archived_at IS NULL`,
      args: [nowMs, id],
    })
  }

  return { scored, evicted: ids.length }
}
