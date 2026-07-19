/**
 * Loop ledger — per-run score history joined with promotion-gate decisions
 * (PRD 41aa2fb2, Watchtower slice 6).
 *
 * `listLoopLedger` is the read surface for the Watchtower KPI section in the
 * Mars UI. It fuses two independent tables:
 *
 *   scorer_results   — one row per (scorer, task/run) with a 0..1 score and
 *                      the workflow-config version that was active at scoring
 *                      time.
 *
 *   promotion_ledger — one row per beat-yesterday gate evaluation; the
 *                      `candidate_version_id` column names the config version
 *                      under trial.
 *
 * The join key is `scorer_results.workflow_config_version_id =
 * promotion_ledger.candidate_version_id` — i.e. "did this run's config
 * version ever become a promotion candidate, and if so, what happened?"
 *
 * Result shape per entry:
 *   runId        — the task id (workflow run identifier)
 *   scoredAt     — Unix ms timestamp from scorer_results.created_at
 *   score        — normalized 0..1; null on `error` rows
 *   recorded     — true when status = 'scored', false on error rows
 *   suggestion   — non-null when a promotion gate was opened for this version;
 *                  carries { version, decisionKind } from the newest ledger row
 *   review       — non-null when the gate was decided (decidedAt IS NOT NULL);
 *                  carries { decision, decidedAt }
 *
 * Tables are assumed to exist; callers are expected to have run the relevant
 * init functions (initScorerResults / initPromotionLedger) before this is
 * called — the daemon and tests both guarantee this.
 */

import { resolveStateClient } from '../store/state-client'

export interface LoopLedgerEntry {
  /** The task id that was scored (the workflow run identifier). */
  runId: string
  /** Unix ms timestamp when the scorer result was recorded. */
  scoredAt: number
  /** Normalized 0..1 score; null on error rows. */
  score: number | null
  /** True when status = 'scored'; false on error rows. */
  recorded: boolean
  /**
   * Non-null when a promotion gate was opened for this run's config version.
   * `version` is the candidateVersionId; `decisionKind` is the gate's current
   * decision (promoted | retired | pending).
   */
  suggestion: { version: string; decisionKind: string } | null
  /**
   * Non-null when the promotion gate for this run's config version has been
   * decided (decidedAt IS NOT NULL on the ledger row).
   */
  review: { decision: string; decidedAt: number } | null
}

/**
 * Return the last `limit` scorer_results rows for `workflow`, newest first,
 * each enriched with the most-recent promotion_ledger decision for that row's
 * config version (if any).
 *
 * @param workflow - Workflow kind to filter by (e.g. 'task', 'fix').
 * @param limit    - Maximum number of entries to return; must be ≥ 1.
 */
export const listLoopLedger = async (
  workflow: string,
  limit: number,
): Promise<LoopLedgerEntry[]> => {
  const client = resolveStateClient()

  // 1. Fetch the last `limit` scorer_results for this workflow, newest first.
  const srResult = await client.execute({
    sql: `SELECT id, task_id, created_at, score, status, workflow_config_version_id
          FROM scorer_results
          WHERE workflow = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [workflow, limit],
  })

  if (srResult.rows.length === 0) return []

  // 2. Collect distinct, non-null config version ids so we can look up
  //    their promotion_ledger entries in a single batched query.
  const versionIds = [
    ...new Set(
      srResult.rows
        .map(
          (r) =>
            (r as unknown as { workflow_config_version_id: string | null })
              .workflow_config_version_id,
        )
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ]

  // 3. For each config version id, find the most-recent promotion_ledger row
  //    where that version was the candidate. ORDER BY created_at DESC means
  //    the first row we encounter per candidate_version_id is the newest;
  //    we stop at the first hit by using a Map.
  const plMap = new Map<string, { decision: string; decidedAt: number | null }>()

  if (versionIds.length > 0) {
    const placeholders = versionIds.map(() => '?').join(', ')
    const plResult = await client.execute({
      sql: `SELECT candidate_version_id, decision, decided_at
            FROM promotion_ledger
            WHERE candidate_version_id IN (${placeholders})
              AND workflow = ?
            ORDER BY created_at DESC`,
      args: [...versionIds, workflow],
    })

    for (const row of plResult.rows) {
      const r = row as unknown as {
        candidate_version_id: string
        decision: string
        decided_at: number | null
      }
      // First occurrence per id = newest (ORDER BY created_at DESC).
      if (!plMap.has(r.candidate_version_id)) {
        plMap.set(r.candidate_version_id, {
          decision: r.decision,
          decidedAt:
            r.decided_at !== null && r.decided_at !== undefined
              ? Number(r.decided_at)
              : null,
        })
      }
    }
  }

  // 4. Shape into LoopLedgerEntry[].
  return srResult.rows.map((row) => {
    const r = row as unknown as {
      id: string
      task_id: string
      created_at: number
      score: number | null
      status: string
      workflow_config_version_id: string | null
    }

    const versionId =
      typeof r.workflow_config_version_id === 'string' &&
      r.workflow_config_version_id.length > 0
        ? r.workflow_config_version_id
        : null

    const pl = versionId !== null ? plMap.get(versionId) : undefined

    const suggestion =
      pl !== undefined
        ? { version: versionId!, decisionKind: pl.decision }
        : null

    const review =
      pl !== undefined && pl.decidedAt !== null
        ? { decision: pl.decision, decidedAt: pl.decidedAt }
        : null

    return {
      runId: r.task_id,
      scoredAt: Number(r.created_at),
      score:
        r.score !== null && r.score !== undefined ? Number(r.score) : null,
      recorded: r.status === 'scored',
      suggestion,
      review,
    }
  })
}
