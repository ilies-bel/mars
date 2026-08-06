/**
 * KPI-drift self-evolve trigger and reflect-recommended detector.
 *
 * `runSelfEvolveTrigger`: When selfEvolve.autoTrigger is true: loads the two
 * most recently taken KPI snapshots, runs the drift detector, and raises one
 * draft proposal (source='reflection') per confirmed regression that does not
 * already have an open draft. When the switch is off this function is a no-op.
 *
 * `runReflectRecommendedDetector`: Evaluates reflect-worthiness regardless of
 * autoTrigger. When any signal fires AND autoTrigger is off, raises one
 * level-triggered 'reflect-recommended' action-queue row with evidence. When
 * no signal fires, or autoTrigger is on, the row is closed. Three detectors:
 *   1. KPI drift (reuses detectKpiDrift)
 *   2. ≥3 recent tasks share a failure signature
 *   3. Any recent task's token spend ≥2× the window median
 *
 * No tasks are ever queued from either path.
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

// ---------------------------------------------------------------------------
// Reflect-recommended detector
// ---------------------------------------------------------------------------

/** The fixed dedup signature for the single open reflect-recommended row. */
const REFLECT_RECOMMENDED_SIG = 'reflect-recommended'

/** Rolling window used by the worthiness detectors. */
const DETECTOR_WINDOW_DAYS = 30

/** Minimum failure-signature cluster size to fire the cluster detector. */
const FAILURE_CLUSTER_MIN = 3

/**
 * Evidence gathered by the worthiness detectors. Each field is an empty array
 * (or null for tokenSpike) when the corresponding detector did not fire.
 */
export interface ReflectWorthinessEvidence {
  kpiDrift: Array<{ kpi: string; deltaPct: number }>
  failureClusters: Array<{ signature: string; count: number }>
  tokenSpike: { taskId: string; weightedTokens: number; multipleOfMedian: number } | null
}

/**
 * Why the reflect-recommended detector did not raise a row.
 *
 * - `'auto-trigger-on'`: selfEvolve.autoTrigger=true, so the KPI-drift trigger
 *   handles proposals directly and the action-queue chip is not needed.
 * - `'no-evidence'`: all three detectors (KPI drift, failure clusters, token
 *   spike) evaluated the rolling window and found nothing above threshold.
 */
export type ReflectDetectorSkipReason = 'auto-trigger-on' | 'no-evidence'

export interface ReflectRecommendedResult {
  /** True when the row was raised (or the existing open row was bumped). */
  raised: boolean
  /** The action-queue row id, or null when not raised. */
  rowId: string | null
  /** Evidence that caused the raise, null when not raised. */
  evidence: ReflectWorthinessEvidence | null
  /**
   * Why the detector did not raise a row. Non-null only when raised=false.
   * Null when raised=true.
   */
  skipReason: ReflectDetectorSkipReason | null
}

/**
 * Compute per-task weighted token spend over the rolling window, return as a
 * sorted array (heaviest first). Uses the trace_events table's step_ended rows.
 */
const computeTaskTokenSpend = async (
  store: TaskStore,
  windowStart: number,
): Promise<Array<{ taskId: string; weightedTokens: number }>> => {
  // HAVING may not reference a SELECT alias on PostgreSQL — the aggregate
  // expression is repeated verbatim.
  const r = await store.query({
    sql: `SELECT task_id,
                 SUM(
                   CAST(payload::jsonb #>> '{usageSignals,inputTokens}' AS double precision) +
                   CAST(payload::jsonb #>> '{usageSignals,outputTokens}' AS double precision) +
                   CAST(payload::jsonb #>> '{usageSignals,cacheCreateTokens}' AS double precision) +
                   CAST(payload::jsonb #>> '{usageSignals,cacheReadTokens}' AS double precision) * 0.1
                 ) AS weighted_tokens
            FROM trace_events
           WHERE kind = 'step_ended'
             AND payload::jsonb ->> 'usageSignals' IS NOT NULL
             AND timestamp > ?
           GROUP BY task_id
          HAVING SUM(
                   CAST(payload::jsonb #>> '{usageSignals,inputTokens}' AS double precision) +
                   CAST(payload::jsonb #>> '{usageSignals,outputTokens}' AS double precision) +
                   CAST(payload::jsonb #>> '{usageSignals,cacheCreateTokens}' AS double precision) +
                   CAST(payload::jsonb #>> '{usageSignals,cacheReadTokens}' AS double precision) * 0.1
                 ) > 0
           ORDER BY weighted_tokens DESC`,
    args: [windowStart],
  })
  return r.rows.map((row) => {
    const r0 = row as unknown as { task_id: string; weighted_tokens: number }
    return { taskId: r0.task_id, weightedTokens: r0.weighted_tokens }
  })
}

/**
 * Find failure-signature clusters: task groups sharing the same failure_signature
 * with ≥ FAILURE_CLUSTER_MIN occurrences in the rolling window.
 */
const detectFailureClusters = async (
  store: TaskStore,
  windowStart: string,
): Promise<Array<{ signature: string; count: number }>> => {
  const r = await store.query({
    sql: `SELECT failure_signature, COUNT(*) AS cnt
            FROM tasks
           WHERE failure_signature IS NOT NULL
             AND status = 'failed'
             AND created_at > ?
           GROUP BY failure_signature
          HAVING COUNT(*) >= ?
           ORDER BY cnt DESC
           LIMIT 10`,
    args: [windowStart, FAILURE_CLUSTER_MIN],
  })
  return r.rows.map((row) => {
    const r0 = row as unknown as { failure_signature: string; cnt: number }
    return { signature: r0.failure_signature, count: r0.cnt }
  })
}

/**
 * Evaluate all reflect-worthiness signals over the rolling window.
 * Returns the evidence structure regardless of autoTrigger status — the
 * caller decides what to do with the result.
 */
const evaluateWorthiness = async (
  store: TaskStore,
  cfg: ReturnType<typeof loadDaemonConfig>,
): Promise<ReflectWorthinessEvidence> => {
  const windowStartMs = Date.now() - DETECTOR_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const windowStartIso = new Date(windowStartMs).toISOString()

  // Detector 1: KPI drift (same logic as runSelfEvolveTrigger, but always runs)
  let kpiDrift: Array<{ kpi: string; deltaPct: number }> = []
  const snapshots = await readLatestTwoSnapshots(store)
  if (snapshots !== null) {
    const [persistedCurrent, persistedPrior] = snapshots
    const { current, prior } = toDetectorSnapshots(persistedCurrent, persistedPrior)
    const findings = detectKpiDrift(current, prior, {
      thresholdPct: cfg.selfEvolve.driftThresholdPct,
    })
    kpiDrift = findings.map((f) => ({ kpi: f.kpi, deltaPct: f.deltaPct }))
  }

  // Detector 2: failure signature clusters
  const failureClusters = await detectFailureClusters(store, windowStartIso)

  // Detector 3: token spend spike (any task ≥ 2× window median)
  let tokenSpike: ReflectWorthinessEvidence['tokenSpike'] = null
  const taskSpend = await computeTaskTokenSpend(store, windowStartMs)
  if (taskSpend.length >= 2) {
    const sorted = [...taskSpend].sort((a, b) => a.weightedTokens - b.weightedTokens)
    const mid = Math.floor(sorted.length / 2)
    const median =
      sorted.length % 2 === 0
        ? (sorted[mid - 1]!.weightedTokens + sorted[mid]!.weightedTokens) / 2
        : sorted[mid]!.weightedTokens
    if (median > 0) {
      // The heaviest task is first in taskSpend (sorted DESC by the query).
      const heaviest = taskSpend[0]!
      const multiple = heaviest.weightedTokens / median
      if (multiple >= 2) {
        tokenSpike = {
          taskId: heaviest.taskId,
          weightedTokens: heaviest.weightedTokens,
          multipleOfMedian: multiple,
        }
      }
    }
  }

  return { kpiDrift, failureClusters, tokenSpike }
}

/**
 * Level-triggered reflect-recommended detector (ADR-0048).
 *
 * Evaluates reflect-worthiness over a rolling window using three cheap SQL
 * detectors (no LLM). When any signal fires and autoTrigger is off, ensures
 * exactly one open 'reflect-recommended' action-queue row exists with the
 * evidence in its payload (re-raises are idempotent — the existing row is
 * bumped, not duplicated). When no signal fires, or autoTrigger is on (the
 * trigger already handles KPI drift directly), closes any open row.
 *
 * The `store` option is for test injection; production callers omit it.
 */
export const runReflectRecommendedDetector = async (opts?: {
  store?: TaskStore
}): Promise<ReflectRecommendedResult> => {
  const cfg = loadDaemonConfig()
  const store = opts?.store ?? (await getDefaultTaskStore())
  const evidence = await evaluateWorthiness(store, cfg)

  const worthy =
    evidence.kpiDrift.length > 0 ||
    evidence.failureClusters.length > 0 ||
    evidence.tokenSpike !== null

  const { raiseActionQueueItem, supersedeActionQueueItemsBySignature } = await import(
    './action-queue.js'
  )

  if (!worthy || cfg.selfEvolve.autoTrigger) {
    // Close any stale open row (level-trigger off).
    await supersedeActionQueueItemsBySignature(
      'reflect-recommended',
      REFLECT_RECOMMENDED_SIG,
      'status-changed',
      'self-evolve:reflect-detector',
    )
    const skipReason: ReflectDetectorSkipReason = cfg.selfEvolve.autoTrigger
      ? 'auto-trigger-on'
      : 'no-evidence'
    return { raised: false, rowId: null, evidence: null, skipReason }
  }

  // Build human-readable evidence summary.
  const evidenceParts: string[] = []
  if (evidence.kpiDrift.length > 0) {
    evidenceParts.push(
      `KPI drift: ${evidence.kpiDrift
        .map((d) => `${d.kpi} ${d.deltaPct >= 0 ? '+' : ''}${d.deltaPct.toFixed(1)}%`)
        .join(', ')}`,
    )
  }
  if (evidence.failureClusters.length > 0) {
    evidenceParts.push(
      `Failure clusters: ${evidence.failureClusters
        .map((c) => `${c.signature} ×${c.count}`)
        .join(', ')}`,
    )
  }
  if (evidence.tokenSpike !== null) {
    evidenceParts.push(
      `Token spike: task ${evidence.tokenSpike.taskId} at ${evidence.tokenSpike.multipleOfMedian.toFixed(1)}× median`,
    )
  }

  const rowId = await raiseActionQueueItem({
    kind: 'reflect-recommended',
    category: 'reflector',
    priority: 'normal',
    title: 'Reflection recommended',
    body: evidenceParts.join('\n'),
    payload: { evidence },
    context: {},
    raisedBy: 'self-evolve:reflect-detector',
    signature: REFLECT_RECOMMENDED_SIG,
  })

  return { raised: true, rowId, evidence, skipReason: null }
}

/**
 * Close any open 'reflect-recommended' action-queue row. Called when the
 * operator runs reflect or enables auto-trigger so the level-trigger is
 * immediately cleared without waiting for the next detector sweep.
 */
export const closeReflectRecommendedRow = async (): Promise<void> => {
  const { supersedeActionQueueItemsBySignature } = await import('./action-queue.js')
  await supersedeActionQueueItemsBySignature(
    'reflect-recommended',
    REFLECT_RECOMMENDED_SIG,
    'status-changed',
    'self-evolve:reflect-closed',
  )
}
