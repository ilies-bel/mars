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
import { type DomainTaskStore as TaskStore, getDefaultTaskStore } from '../store/task-store.js'

export type SkipReason = 'disabled' | 'low-confidence' | 'duplicate' | 'below-threshold'

export interface SelfEvolveTriggerResult {
  raised: string[]
  skipped: Array<{ kpi: string; reason: SkipReason }>
}

interface KpiConfig {
  key: string
  valueKey: string
  confidenceKey: string
  polarity: 'higher-is-better' | 'lower-is-better'
}

const KPI_CONFIGS: KpiConfig[] = [
  {
    key: 'failure_rate',
    valueKey: 'failure_rate',
    confidenceKey: 'failure_rate_low_confidence',
    polarity: 'lower-is-better',
  },
  {
    key: 'cost_per_arc_p50',
    valueKey: 'cost_per_arc_p50',
    confidenceKey: 'cost_per_arc_low_confidence',
    polarity: 'lower-is-better',
  },
  {
    key: 'cost_per_arc_p90',
    valueKey: 'cost_per_arc_p90',
    confidenceKey: 'cost_per_arc_low_confidence',
    polarity: 'lower-is-better',
  },
  {
    key: 'autonomous_completion_rate',
    valueKey: 'autonomous_completion_rate',
    confidenceKey: 'autonomous_completion_rate_low_confidence',
    polarity: 'higher-is-better',
  },
  {
    key: 'recovery_success_rate',
    valueKey: 'recovery_success_rate',
    confidenceKey: 'recovery_success_rate_low_confidence',
    polarity: 'higher-is-better',
  },
]

/**
 * Convert two persisted kpi_snapshots rows into the KPI drift detector's snapshot
 * format, filtering per-KPI based on individual confidence flags. A metric is admitted
 * only when BOTH the current and prior snapshot have the KPI-specific low_confidence
 * flag set to 0. Returns detector-ready snapshots plus the list of KPI keys excluded
 * due to low confidence.
 */
const toDetectorSnapshots = (
  current: PersistedSnapshot,
  prior: PersistedSnapshot,
): { current: DriftSnapshot; prior: DriftSnapshot; lowConfidenceKpis: string[] } => {
  const currentMetrics: Record<string, KpiEntry> = {}
  const priorMetrics: Record<string, KpiEntry> = {}
  const lowConfidenceKpis: string[] = []

  for (const kpi of KPI_CONFIGS) {
    const currentConf = (current as unknown as Record<string, number>)[kpi.confidenceKey]
    const priorConf = (prior as unknown as Record<string, number>)[kpi.confidenceKey]

    if (currentConf !== 0 || priorConf !== 0) {
      lowConfidenceKpis.push(kpi.key)
      continue
    }

    const currentValue = (current as unknown as Record<string, number | null>)[kpi.valueKey]
    const priorValue = (prior as unknown as Record<string, number | null>)[kpi.valueKey]

    if (currentValue !== null && priorValue !== null) {
      currentMetrics[kpi.key] = { value: currentValue, polarity: kpi.polarity }
      priorMetrics[kpi.key] = { value: priorValue, polarity: kpi.polarity }
    }
  }

  return {
    current: { isConfident: true, metrics: currentMetrics },
    prior: { isConfident: true, metrics: priorMetrics },
    lowConfidenceKpis,
  }
}

/** Read the two most recently taken kpi_snapshots rows as [current, prior]. */
const readLatestTwoSnapshots = async (
  store: TaskStore,
): Promise<[PersistedSnapshot, PersistedSnapshot] | null> => {
  const result = await store.query({
    sql: `SELECT id, taken_at, window_start, window_end,
                 cost_per_arc_sample_count, cost_per_arc_low_confidence,
                 failure_rate_sample_count, failure_rate_low_confidence,
                 autonomous_completion_rate_sample_count, autonomous_completion_rate_low_confidence,
                 recovery_success_rate_sample_count, recovery_success_rate_low_confidence,
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
  const { current, prior, lowConfidenceKpis } = toDetectorSnapshots(persistedCurrent, persistedPrior)

  const findings = detectKpiDrift(current, prior, {
    thresholdPct: cfg.selfEvolve.driftThresholdPct,
  })

  const raised: string[] = []
  const skipped: Array<{ kpi: string; reason: SkipReason }> =
    lowConfidenceKpis.map(kpi => ({ kpi, reason: 'low-confidence' }))

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
