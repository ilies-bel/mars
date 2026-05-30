/**
 * KPI-drift self-evolve trigger.
 *
 * When selfEvolve.autoTrigger is true: loads the two most recently taken KPI
 * snapshots, runs the drift detector, and raises one draft proposal
 * (source='reflection') per confirmed regression that does not already have an
 * open draft. When the switch is off this function is a no-op.
 *
 * No tasks are ever queued from this path.
 */

import { detectKpiDrift, type KpiSnapshot as DriftSnapshot, type KpiEntry } from './kpi-drift.js'
import { findOpenReflectionDraftForKpi, createProposal } from '../proposals.js'
import { loadDaemonConfig } from '../daemon/config.js'
import type { KpiSnapshot as PersistedSnapshot } from './kpi-snapshots.js'
import { type TaskStore, getDefaultTaskStore } from './task-store.js'

export type SkipReason = 'disabled' | 'low-confidence' | 'duplicate' | 'below-threshold'

export interface SelfEvolveTriggerResult {
  raised: string[]
  skipped: Array<{ kpi: string; reason: SkipReason }>
}

/** Convert a persisted kpi_snapshots row to the KPI drift detector's snapshot format. */
const toDetectorSnapshot = (row: PersistedSnapshot): DriftSnapshot => {
  const metrics: Record<string, KpiEntry> = {}
  if (row.failure_rate !== null) {
    metrics.failure_rate = { value: row.failure_rate, polarity: 'lower-is-better' }
  }
  if (row.cost_per_arc_p50 !== null) {
    metrics.cost_per_arc_p50 = { value: row.cost_per_arc_p50, polarity: 'lower-is-better' }
  }
  if (row.cost_per_arc_p90 !== null) {
    metrics.cost_per_arc_p90 = { value: row.cost_per_arc_p90, polarity: 'lower-is-better' }
  }
  if (row.autonomous_completion_rate !== null) {
    metrics.autonomous_completion_rate = {
      value: row.autonomous_completion_rate,
      polarity: 'higher-is-better',
    }
  }
  if (row.recovery_success_rate !== null) {
    metrics.recovery_success_rate = {
      value: row.recovery_success_rate,
      polarity: 'higher-is-better',
    }
  }
  return { isConfident: row.low_confidence === 0, metrics }
}

/** Read the two most recently taken kpi_snapshots rows as [current, prior]. */
const readLatestTwoSnapshots = async (
  store: TaskStore,
): Promise<[PersistedSnapshot, PersistedSnapshot] | null> => {
  const result = await store.query({
    sql: `SELECT id, taken_at, window_start, window_end,
                 sample_count, low_confidence,
                 cost_per_arc_p50, cost_per_arc_p90,
                 failure_rate, autonomous_completion_rate, recovery_success_rate
          FROM kpi_snapshots
          ORDER BY taken_at DESC
          LIMIT 2`,
    args: [],
  })
  if (result.rows.length < 2) return null
  const rows = result.rows as unknown as PersistedSnapshot[]
  return [rows[0], rows[1]] // [current (newest), prior (older)]
}

/**
 * Entry point for the KPI-drift self-evolve trigger.
 *
 * When autoTrigger is false: returns immediately with no proposals raised.
 * When autoTrigger is true: checks drift and raises one draft proposal per
 * confirmed regression that does not already have an open draft.
 *
 * Never queues tasks. The `store` option is for test injection; production
 * callers omit it and the default store is used.
 */
export const runSelfEvolveTrigger = async (opts?: {
  store?: TaskStore
}): Promise<SelfEvolveTriggerResult> => {
  const cfg = loadDaemonConfig()
  if (!cfg.selfEvolve.autoTrigger) {
    return { raised: [], skipped: [] }
  }

  const store = opts?.store ?? (await getDefaultTaskStore())
  const snapshots = await readLatestTwoSnapshots(store)
  if (snapshots === null) {
    return { raised: [], skipped: [] }
  }

  const [persistedCurrent, persistedPrior] = snapshots
  const current = toDetectorSnapshot(persistedCurrent)
  const prior = toDetectorSnapshot(persistedPrior)

  const findings = detectKpiDrift(current, prior, {
    thresholdPct: cfg.selfEvolve.driftThresholdPct,
  })

  const raised: string[] = []
  const skipped: Array<{ kpi: string; reason: SkipReason }> = []

  for (const finding of findings) {
    const existing = await findOpenReflectionDraftForKpi(finding.kpi)
    if (existing) {
      skipped.push({ kpi: finding.kpi, reason: 'duplicate' })
      continue
    }

    const deltaSign = finding.deltaPct >= 0 ? '+' : ''
    const title = `KPI regression: ${finding.kpi} drifted ${deltaSign}${finding.deltaPct.toFixed(1)}%`
    const problem =
      `KPI \`${finding.kpi}\` regressed by ${Math.abs(finding.deltaPct).toFixed(1)}% ` +
      `(prior: ${finding.priorValue}, current: ${finding.currentValue}).`
    const solution = `Investigate root causes and address the regression in \`${finding.kpi}\`.`
    const notes = JSON.stringify(finding.vector, null, 2)

    const proposal = await createProposal(title, {
      source: 'reflection',
      author: { kind: 'agent', name: 'self-evolve' },
      problem,
      solution,
      notes,
      kpiTag: finding.kpi,
    })
    raised.push(proposal.id)
  }

  return { raised, skipped }
}
