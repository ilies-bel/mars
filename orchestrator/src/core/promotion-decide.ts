/**
 * Beat-yesterday promotion decision engine — slice 4 of PRD 5b73d277.
 *
 * `decidePromotion` is a pure function that compares arithmetic means of two
 * score arrays and returns a promotion outcome.  It has no I/O and is trivial
 * to unit-test.
 *
 * `runPromotionDecision` is the orchestrator-facing entry point: it loads the
 * trial and incumbent workflow-config versions from the DB, reads the most
 * recent scorer_results per version, calls `decidePromotion`, writes the
 * appropriate status updates, and persists a promotion_ledger row.
 */

import type { DbClient } from './lib/db'
import { getActiveWorkflowConfig, getTrialWorkflowConfig } from './workflow-configs'
import { recordPromotionLedgerEntry } from './promotion-ledger'
import { raiseActionQueueItem } from './lib/action-queue'

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

export interface DecidePromotionInput {
  trialScores: number[]
  incumbentScores: number[]
  minSamples: number
}

export type PromotionOutcome = 'promote' | 'retire' | 'insufficient-data'

/**
 * Compare arithmetic means of `trialScores` vs `incumbentScores`.
 *
 * Returns:
 * - `'insufficient-data'` when either array has fewer than `minSamples` items.
 * - `'promote'` when the trial mean strictly exceeds the incumbent mean.
 * - `'retire'` when the trial mean is equal to or below the incumbent mean.
 */
export const decidePromotion = (input: DecidePromotionInput): PromotionOutcome => {
  const { trialScores, incumbentScores, minSamples } = input

  if (trialScores.length < minSamples || incumbentScores.length < minSamples) {
    return 'insufficient-data'
  }

  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

  return mean(trialScores) > mean(incumbentScores) ? 'promote' : 'retire'
}

// ---------------------------------------------------------------------------
// Orchestrator-facing runner
// ---------------------------------------------------------------------------

export interface RunPromotionDecisionOptions {
  /** Minimum sample count required on each side before a decision is made. Default 5. */
  minSamples?: number
  /** Number of most-recent non-null scores to load per version. Default 20. */
  window?: number
}

/**
 * Load the trial and incumbent workflow-config versions, compare their recent
 * scorer_results, flip statuses, and write a promotion_ledger entry.
 *
 * Returns the outcome, or null when there is nothing to compare (no trial or
 * no incumbent exists).
 */
export const runPromotionDecision = async (
  client: DbClient,
  workflow: string,
  opts: RunPromotionDecisionOptions = {},
): Promise<PromotionOutcome | null> => {
  const minSamples = opts.minSamples ?? 5
  const window = opts.window ?? 20

  // Load both sides.
  const [trial, incumbent] = await Promise.all([
    getTrialWorkflowConfig(client, workflow),
    getActiveWorkflowConfig(client, workflow),
  ])

  if (!trial || !incumbent) {
    // Nothing to compare — no trial version or no baseline/promoted version.
    return null
  }

  // Fetch recent scored results for each version.
  const loadScores = async (versionId: string): Promise<number[]> => {
    const r = await client.execute({
      sql: `SELECT score FROM scorer_results
             WHERE workflow = ?
               AND workflow_config_version_id = ?
               AND status = 'scored'
               AND score IS NOT NULL
             ORDER BY created_at DESC
             LIMIT ?`,
      args: [workflow, versionId, window],
    })
    return r.rows.map((row) => {
      const { score } = row as unknown as { score: number }
      return Number(score)
    })
  }

  const [trialScores, incumbentScores] = await Promise.all([
    loadScores(trial.id),
    loadScores(incumbent.id),
  ])

  const outcome = decidePromotion({ trialScores, incumbentScores, minSamples })

  // 'insufficient-data' → no writes.
  if (outcome === 'insufficient-data') {
    return outcome
  }

  const trialMean =
    trialScores.length > 0
      ? trialScores.reduce((a, b) => a + b, 0) / trialScores.length
      : null
  const incumbentMean =
    incumbentScores.length > 0
      ? incumbentScores.reduce((a, b) => a + b, 0) / incumbentScores.length
      : null

  if (outcome === 'promote') {
    // Retire the incumbent, promote the trial.
    await client.execute({
      sql: `UPDATE workflow_configs SET status = 'retired', updated_at = ? WHERE id = ?`,
      args: [Date.now(), incumbent.id],
    })
    await client.execute({
      sql: `UPDATE workflow_configs SET status = 'promoted', updated_at = ? WHERE id = ?`,
      args: [Date.now(), trial.id],
    })
  } else {
    // outcome === 'retire': only the trial is retired; incumbent is unchanged.
    await client.execute({
      sql: `UPDATE workflow_configs SET status = 'retired', updated_at = ? WHERE id = ?`,
      args: [Date.now(), trial.id],
    })
  }

  // Persist ledger entry.
  const ledgerEntry = await recordPromotionLedgerEntry(client, {
    workflow,
    candidateVersionId: trial.id,
    incumbentVersionId: incumbent.id,
    candidateScore: trialMean,
    incumbentScore: incumbentMean,
    candidateN: trialScores.length,
    incumbentN: incumbentScores.length,
    decision: outcome === 'promote' ? 'promoted' : 'retired',
    decidedAt: Date.now(),
  })

  // Raise a 'never-silent' action-queue row so the operator sees the
  // before/after scores. Signature-keyed on the ledger entry id —
  // idempotent re-raises bump seen_count rather than inserting siblings.
  await raiseActionQueueItem({
    kind: 'promotion-decision',
    category: 'daemon',
    priority: 'normal',
    title: `Promotion decision: ${workflow}`,
    body: `Workflow ${workflow}: candidate v${trial.version} scored ${trialMean !== null ? trialMean.toFixed(3) : 'n/a'} vs incumbent v${incumbent.version} ${incumbentMean !== null ? incumbentMean.toFixed(3) : 'n/a'} — decision: ${outcome}`,
    payload: {
      workflow,
      ledgerId: ledgerEntry.id,
      candidateVersionId: trial.id,
      incumbentVersionId: incumbent.id,
      candidateScore: trialMean,
      incumbentScore: incumbentMean,
      decision: outcome,
    },
    context: {},
    raisedBy: 'promotion-engine',
    signature: `promotion-decision:${ledgerEntry.id}`,
  })

  return outcome
}
