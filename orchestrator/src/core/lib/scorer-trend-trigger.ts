/**
 * Scorer low-trend trigger (PRD 6cf85bc9, "fold into optimization" v1).
 *
 * Measure → surface → OPERATOR-driven revision. When `scoring.autoTrigger`
 * is true (OFF by default — same explicit opt-in posture as ADR-0038's
 * KPI-regression trigger), a sustained low score trend on one workflow —
 * rolling median below `scoring.lowTrendThreshold` across the last
 * `scoring.lowTrendWindow` scored instances — raises exactly ONE draft
 * proposal (source='reflection') proposing a revision of that pipeline.
 *
 * The draft surfaces as an ordinary draft-proposal action-queue row: pure
 * projection (ADR-0048), no new operator verbs, nothing closes it but the
 * proposal's own state transition. Revision is the normal operator loop
 * (grill → promote → slice) — NO autonomous pipeline self-rewrite, ever.
 *
 * Dedup: the proposal's `kpi_tag` carries `scorer-trend:<workflow>`; while an
 * open draft with that tag exists, repeat evaluations are no-ops.
 */

import { loadDaemonConfig } from '../daemon/config.js'
import {
  computeScorerTrend,
  listScoredWorkflows,
  type ScorerTrend,
} from '../scorer-results.js'
import { findOpenDraftByKpiTag, createProposal } from '../proposals.js'

export type ScorerTrendSkipReason =
  | 'disabled'
  | 'insufficient-samples'
  | 'healthy'
  | 'duplicate'

export interface ScorerTrendTriggerResult {
  /** Proposal ids raised this evaluation. */
  raised: string[]
  skipped: Array<{ workflow: string; reason: ScorerTrendSkipReason }>
}

/** The dedup tag stamped on low-trend drafts for one workflow. */
export const scorerTrendKpiTag = (workflow: string): string =>
  `scorer-trend:${workflow}`

const buildProblem = (trend: ScorerTrend, threshold: number): string =>
  `The '${trend.workflow}' workflow's Scorer trend is sustained-low: rolling median ` +
  `${trend.median?.toFixed(2) ?? 'n/a'} (p90 ${trend.p90?.toFixed(2) ?? 'n/a'}) over the ` +
  `last ${trend.sampleCount} scored instance(s), below the configured threshold ` +
  `${threshold.toFixed(2)}. Every one of these instances PASSED verify — this is a ` +
  `quality drift the correctness gate cannot see (record-only Scorer signal, ` +
  `PRD 6cf85bc9).`

const buildSolution = (workflow: string): string =>
  `Revise the '${workflow}' pipeline via the normal operator loop: inspect recent ` +
  `scorer rationales (\`mars scorer trend --workflow ${workflow}\` and ` +
  `\`mars scorer list --workflow ${workflow}\`), then grill → promote → slice a ` +
  `revision. The framework never rewrites a pipeline itself.`

/**
 * Evaluate the low-trend condition for every workflow with recorded scorer
 * results. No-op (raised: []) while `scoring.autoTrigger` is off. Never
 * queues tasks; only draft proposals are raised.
 */
export const runScorerLowTrendTrigger = async (): Promise<ScorerTrendTriggerResult> => {
  const cfg = loadDaemonConfig()
  if (!cfg.scoring.autoTrigger) {
    return { raised: [], skipped: [] }
  }
  const { lowTrendThreshold, lowTrendWindow } = cfg.scoring
  const raised: string[] = []
  const skipped: Array<{ workflow: string; reason: ScorerTrendSkipReason }> = []

  for (const workflow of await listScoredWorkflows()) {
    const trend = await computeScorerTrend(workflow, lowTrendWindow)
    if (trend.sampleCount < lowTrendWindow || trend.median === null) {
      skipped.push({ workflow, reason: 'insufficient-samples' })
      continue
    }
    if (trend.median >= lowTrendThreshold) {
      skipped.push({ workflow, reason: 'healthy' })
      continue
    }
    const tag = scorerTrendKpiTag(workflow)
    const existing = await findOpenDraftByKpiTag(tag)
    if (existing) {
      skipped.push({ workflow, reason: 'duplicate' })
      continue
    }
    const proposal = await createProposal(
      `Scorer trend low on '${workflow}': rolling median ${trend.median.toFixed(2)} < ${lowTrendThreshold.toFixed(2)} — revise the pipeline`,
      {
        source: 'reflection',
        author: { kind: 'agent', name: 'scorer-trend' },
        problem: buildProblem(trend, lowTrendThreshold),
        solution: buildSolution(workflow),
        notes: JSON.stringify(trend, null, 2),
        kpiTag: tag,
      },
    )
    raised.push(proposal.id)
  }

  return { raised, skipped }
}
