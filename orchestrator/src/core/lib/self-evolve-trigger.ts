/**
 * KPI-drift self-evolve trigger and reflect-recommended detector.
 *
 * `runSelfEvolveTrigger`: Loads the two most recently taken KPI snapshots,
 * runs the drift detector, and raises one draft proposal (source='reflection')
 * per confirmed regression that does not already have an open draft.
 * Never queues tasks — only raises proposals (ADR-0038).
 *
 * `runReflectRecommendedDetector`: Evaluates reflect-worthiness using three
 * cheap SQL detectors (no LLM). When any signal fires, ensures exactly one
 * open 'reflect-recommended' action-queue row exists. When no signal fires,
 * closes any open row. Three detectors:
 *   1. KPI drift (reuses detectKpiDrift)
 *   2. ≥3 recent tasks share a failure signature FAMILY (`<gate>/<errorClass>`,
 *      see failureSignatureFamilySql) — rewordings of the same gate error at
 *      different step granularities collapse into one cluster
 *   3. Any recent task's token spend ≥2× the window median
 *
 * No tasks are ever queued from either path.
 */

import { detectKpiDrift, type KpiSnapshot as DriftSnapshot, type KpiEntry } from './kpi-drift.js'
import { failureSignatureFamilySql } from './failure-signature.js'
import { findOpenReflectionDraftForKpi, createProposal, appendProposalNotes } from '../proposals.js'
import { loadDaemonConfig } from '../daemon/config.js'
import type { KpiSnapshot as PersistedSnapshot } from './kpi-snapshots.js'
import { type DomainTaskStore as TaskStore, getDefaultTaskStore } from '../store/task-store-default.js'

type SkipReason = 'disabled' | 'low-confidence' | 'duplicate' | 'below-threshold' | 'acknowledged'

export interface SelfEvolveTriggerResult {
  raised: string[]
  skipped: Array<{ kpi: string; reason: SkipReason }>
}

/**
 * Typed structure carried in the `notes` field of a KPI-drift draft proposal.
 *
 * The phase-enriched consumer extends this with an optional `phaseBreakdown`
 * field; the acknowledgment consumer reads `kpi` and `acknowledgedValue` to
 * decide whether a baseline ack already covers this finding.
 */
export interface KpiDriftProposalNotes {
  /** The primary regressing KPI key. */
  kpi: string
  /** Signed percentage change: (current − prior) / |prior| × 100. */
  deltaPct: number
  /** Prior measured value. */
  priorValue: number
  /** Current measured value. */
  currentValue: number
  /**
   * Cross-KPI context: all KPIs present in both snapshots.
   * Keys are KPI names; values are per-snapshot readings.
   */
  vector: Record<string, { prior: number; current: number }>
  /**
   * Optional phase-level breakdown populated by the enrichment consumer.
   * Keys are phase names (e.g. 'code', 'verify', 'setup'); values are
   * per-phase metric deltas for the primary regressing KPI.
   */
  phaseBreakdown?: Record<string, { prior: number; current: number }>
  /**
   * Median weighted tokens per phase across arcs in the current window.
   * Keys are step/phase names (e.g. 'code', 'verify', 'setup'); values are
   * the median cache-weighted token cost for that phase across all arcs.
   * Only populated for cost_per_arc_p50 regressions.
   */
  phaseMedians?: Record<string, number>
}

/**
 * A record that the operator has acknowledged the current KPI snapshot as the
 * new measurement baseline, suppressing future re-raises for the same finding.
 */
export interface KpiDriftBaselineAck {
  /** The KPI key being acknowledged (e.g. 'cost_per_arc_p50'). */
  kpi: string
  /** ID of the proposal that was reviewed and acknowledged. */
  proposalId: string
  /** ISO-8601 timestamp when the acknowledgment was recorded. */
  acknowledgedAt: string
  /** The KPI value at time of acknowledgment (the 'current' reading). */
  acknowledgedValue: number
}

/** Result returned by {@link acknowledgeKpiDriftBaseline}. */
export interface AcknowledgeKpiDriftBaselineResult {
  /** True when an open draft was found and acknowledged. */
  acknowledged: boolean
  /** The proposal id that was dismissed, or null when no open draft exists. */
  proposalId: string | null
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
 * Checks KPI drift and raises one draft proposal per confirmed regression
 * that does not already have an open draft. Never queues tasks.
 * The `store` option is for test injection; production callers omit it.
 */
export const runSelfEvolveTrigger = async (opts?: {
  store?: TaskStore
}): Promise<SelfEvolveTriggerResult> => {
  const cfg = loadDaemonConfig()
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

  // Load acknowledged baselines once before iterating over findings so we can
  // suppress re-raises for KPIs the operator has already acknowledged.
  const { listKpiBaselines } = await import('./kpi-baseline.js')
  const acknowledgedBaselines = await listKpiBaselines(store)
  const ackMap = new Map(acknowledgedBaselines.map(b => [b.kpi_key, b]))

  for (const finding of findings) {
    // Check acknowledged baseline before the duplicate check: if the current
    // value is within thresholdPct of the acknowledged value, the finding is
    // suppressed without raising a proposal or touching the proposals table.
    const ack = ackMap.get(finding.kpi)
    if (ack !== undefined && ack.value !== 0) {
      const deltaPct =
        Math.abs((finding.currentValue - ack.value) / ack.value) * 100
      if (deltaPct < cfg.selfEvolve.driftThresholdPct) {
        skipped.push({ kpi: finding.kpi, reason: 'acknowledged' })
        continue
      }
    }

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
    const notesPayload: KpiDriftProposalNotes = {
      kpi: finding.kpi,
      deltaPct: finding.deltaPct,
      priorValue: finding.priorValue,
      currentValue: finding.currentValue,
      vector: finding.vector,
    }

    // Enrich cost_per_arc_p50 findings with per-phase median token breakdown.
    // This lets the operator see which phase drove the regression without running
    // a separate drill command.
    if (finding.kpi === 'cost_per_arc_p50') {
      const { listCostPerArcArcs } = await import('./kpi-compute.js')
      const currentWindow = {
        windowStart: persistedCurrent.window_start,
        windowEnd: persistedCurrent.window_end,
      }
      const arcs = await listCostPerArcArcs(store, currentWindow)
      // Group per-arc phase costs by phase name
      const phaseGroups: Record<string, number[]> = {}
      for (const arc of arcs) {
        if (arc.phaseBreakdown) {
          for (const [phase, cost] of Object.entries(arc.phaseBreakdown)) {
            if (!phaseGroups[phase]) phaseGroups[phase] = []
            phaseGroups[phase]!.push(cost)
          }
        }
      }
      // Compute median for each phase (linear-interpolation on sorted array)
      const phaseMedians: Record<string, number> = {}
      for (const [phase, costs] of Object.entries(phaseGroups)) {
        const sorted = [...costs].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        phaseMedians[phase] =
          sorted.length % 2 === 0
            ? (sorted[mid - 1]! + sorted[mid]!) / 2
            : sorted[mid]!
      }
      notesPayload.phaseMedians = phaseMedians
    }

    const notes = JSON.stringify(notesPayload, null, 2)

    // A stable fingerprint per metric makes the proposal raise idempotent
    // regardless of which snapshot pair is being compared.  The `ON CONFLICT
    // (source, fingerprint)` clause in createProposal's INSERT is the atomic
    // backstop: two concurrent sweeps with different snapshot pairs but the
    // same regressing metric collapse to one row even when both pass the
    // findOpenReflectionDraftForKpi read-then-write gap.
    //
    // Judgment on worsening drift: same finding, update in place.  If the
    // metric drifts further (+13% → +25%) between sweeps, the ON CONFLICT
    // appends the updated notes to the existing draft — the operator sees one
    // proposal with the latest reading, not two.  When the operator dismisses
    // the proposal (or acknowledges the baseline), dismissProposal /
    // setProposalField clears the fingerprint so a genuinely new regression
    // files a fresh proposal rather than folding into the dismissed row.
    const fingerprint = `kpi-drift:${finding.kpi}`

    const proposal = await createProposal(title, {
      source: 'reflection',
      author: { kind: 'agent', name: 'self-evolve' },
      problem,
      solution,
      notes,
      kpiTag: finding.kpi,
      fingerprint,
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
interface ReflectWorthinessEvidence {
  kpiDrift: Array<{ kpi: string; deltaPct: number }>
  failureClusters: Array<{ family: string; count: number }>
  tokenSpike: { taskId: string; weightedTokens: number; multipleOfMedian: number } | null
}

/**
 * Why the reflect-recommended detector did not raise a row.
 *
 * - `'no-evidence'`: all three detectors (KPI drift, failure clusters, token
 *   spike) evaluated the rolling window and found nothing above threshold.
 * - `'cooldown'`: an operator resolved a reflect-recommended row within the
 *   configured cooldown window (selfEvolve.reflectCooldownDays). Re-raising
 *   immediately would undo the explicit operator dismissal.
 * - `'dismissed'`: the operator permanently dismissed this notice via the
 *   "stop asking me that" verb; a record in `notice_dismissals` suppresses
 *   all future raises until manually cleared.
 */
type ReflectDetectorSkipReason = 'no-evidence' | 'cooldown' | 'dismissed'

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
             AND task_id IS NOT NULL
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
  return r.rows.flatMap((row) => {
    const r0 = row as unknown as { task_id: string | null; weighted_tokens: number }
    if (r0.task_id === null) return []
    return [{ taskId: r0.task_id, weightedTokens: r0.weighted_tokens }]
  })
}

/**
 * Find failure-signature-FAMILY clusters: task groups sharing the same
 * `<gate>/<errorClass>` family (see {@link failureSignatureFamilySql}) with
 * ≥ FAILURE_CLUSTER_MIN occurrences in the rolling window. Grouping on the
 * family rather than the raw `failure_signature` column means three
 * rewordings of the same gate error at different step granularities
 * (`code:commit-contract/uncommitted-changes` vs `code/uncommitted-changes`)
 * collapse into one cluster instead of three clusters of one.
 */
const detectFailureClusters = async (
  store: TaskStore,
  windowStart: string,
): Promise<Array<{ family: string; count: number }>> => {
  const familyExpr = failureSignatureFamilySql('failure_signature')
  const r = await store.query({
    sql: `SELECT ${familyExpr} AS family, COUNT(*) AS cnt
            FROM tasks
           WHERE failure_signature IS NOT NULL
             AND status = 'failed'
             AND created_at > ?
           GROUP BY ${familyExpr}
          HAVING COUNT(*) >= ?
           ORDER BY cnt DESC
           LIMIT 10`,
    args: [windowStart, FAILURE_CLUSTER_MIN],
  })
  return r.rows.map((row) => {
    const r0 = row as unknown as { family: string; cnt: number }
    return { family: r0.family, count: r0.cnt }
  })
}

/**
 * Evaluate all reflect-worthiness signals over the rolling window.
 * Returns the evidence structure; the caller decides what to do with the result.
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
 * Count tasks created in the last `days` days.
 * Used to build the reflect-recommended title so operators know the corpus size.
 */
const countRecentTasks = async (store: TaskStore, days: number): Promise<number> => {
  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const r = await store.query({
    sql: `SELECT COUNT(*) AS n FROM tasks WHERE created_at > ? AND status NOT IN ('queued','blocked')`,
    args: [windowStart],
  })
  const row = r.rows[0] as unknown as { n: number | bigint }
  return typeof row?.n === 'bigint' ? Number(row.n) : (row?.n ?? 0)
}

/**
 * Level-triggered reflect-recommended detector (ADR-0048).
 *
 * Evaluates reflect-worthiness over a rolling window using three cheap SQL
 * detectors (no LLM). When any signal fires, ensures exactly one open
 * 'reflect-recommended' action-queue row exists with the evidence in its
 * payload (re-raises are idempotent — the existing row is bumped, not
 * duplicated). When no signal fires, closes any open row.
 *
 * A cooldown prevents re-raising within `selfEvolve.reflectCooldownDays` of an
 * operator resolution — the explicit dismissal is honoured for that window.
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

  if (!worthy) {
    // Close any stale open row (level-trigger off).
    await supersedeActionQueueItemsBySignature(
      'reflect-recommended',
      REFLECT_RECOMMENDED_SIG,
      'status-changed',
      'self-evolve:reflect-detector',
    )
    return { raised: false, rowId: null, evidence: null, skipReason: 'no-evidence' }
  }

  // Permanent dismissal: if the operator chose "stop asking me that", a record
  // in notice_dismissals suppresses all future raises for this notice key.
  // This check runs BEFORE the cooldown so a permanent dismissal short-circuits
  // without querying the action_queue_items history at all.
  const { isNoticeDismissed } = await import('./action-queue.js')
  if (await isNoticeDismissed(REFLECT_RECOMMENDED_SIG)) {
    return { raised: false, rowId: null, evidence: null, skipReason: 'dismissed' }
  }

  // Cooldown: when the operator resolved a reflect-recommended row within the
  // configured window, skip re-raising so the explicit dismissal is not undone
  // by the next detector sweep. A zero cooldown disables the guard.
  if (cfg.selfEvolve.reflectCooldownDays > 0) {
    const cooldownCutoff =
      Date.now() - cfg.selfEvolve.reflectCooldownDays * 24 * 60 * 60 * 1000
    const recentResolution = await store.query({
      sql: `SELECT resolved_at FROM action_queue_items
             WHERE kind = 'reflect-recommended'
               AND signature = ?
               AND status = 'resolved'
               AND resolved_at IS NOT NULL
               AND resolved_at > ?
             ORDER BY resolved_at DESC
             LIMIT 1`,
      args: [REFLECT_RECOMMENDED_SIG, cooldownCutoff],
    })
    if (recentResolution.rows.length > 0) {
      return { raised: false, rowId: null, evidence: null, skipReason: 'cooldown' }
    }
  }

  // Count recent tasks to include corpus size in the title.
  const corpusSize = await countRecentTasks(store, DETECTOR_WINDOW_DAYS)

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
      `Failure families: ${evidence.failureClusters
        .map((c) => `${c.family} ×${c.count}`)
        .join(', ')}`,
    )
  }
  if (evidence.tokenSpike !== null) {
    evidenceParts.push(
      `Token spike: task ${evidence.tokenSpike.taskId} at ${evidence.tokenSpike.multipleOfMedian.toFixed(1)}× median`,
    )
  }

  const title = `Reflection recommended — ${corpusSize} task${corpusSize !== 1 ? 's' : ''} over last ${DETECTOR_WINDOW_DAYS} days`

  const rowId = await raiseActionQueueItem({
    kind: 'reflect-recommended',
    category: 'reflector',
    priority: 'high',
    title,
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
 * operator runs reflect so the level-trigger is immediately cleared without
 * waiting for the next detector sweep.
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

// ---------------------------------------------------------------------------
// KPI drift baseline acknowledgment
// ---------------------------------------------------------------------------

/**
 * Acknowledge the current KPI drift finding for `ack.kpi` as the accepted
 * baseline.
 *
 * Finds the open reflection draft for the KPI, appends a human-readable
 * acknowledgment note to its `notes` field, then marks the proposal
 * 'dismissed' so the trigger does not re-raise a duplicate. Returns whether
 * an open draft was found.
 *
 * The `_opts` parameter is reserved for test injection and is currently
 * unused — acknowledgment routes through the proposals layer, not the task
 * store, so no store override is needed here.
 */
export const acknowledgeKpiDriftBaseline = async (
  ack: KpiDriftBaselineAck,
  _opts?: { store?: TaskStore },
): Promise<AcknowledgeKpiDriftBaselineResult> => {
  const existing = await findOpenReflectionDraftForKpi(ack.kpi)
  if (!existing) {
    return { acknowledged: false, proposalId: null }
  }

  const ackNote =
    `Baseline acknowledged at ${ack.acknowledgedAt}: ` +
    `${ack.kpi} = ${ack.acknowledgedValue} accepted as new baseline.`
  await appendProposalNotes(existing.id, ackNote)

  const { setProposalField } = await import('../proposals.js')
  await setProposalField(existing.id, 'status', 'dismissed')

  return { acknowledged: true, proposalId: existing.id }
}
