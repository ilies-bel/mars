/**
 * `kpi` command group: KPI metric visibility and comparison (Phase 4B).
 *
 * `kpi compare --before <ref> --after <ref>` — compare the four Phase 4A KPI
 * metrics between two time windows and print a 4-row table with
 * before/after/delta/verdict columns. Read-only — no writes, no side effects.
 *
 * <ref> is either an ISO-8601 timestamp (e.g. 2026-01-01T00:00:00.000Z) or a
 * task id (the window starts at that task's created_at).
 *
 * Windows:
 *   before window: [before_ts, after_ts]  (updated_at filter)
 *   after  window: [after_ts,  now]
 *
 * Metric definitions (Phase 4A KPI doc):
 *   cost-per-merged-task       = total provider $ / count of done tasks in window
 *   failure-rate               = failed_arcs / (done_arcs + failed_arcs)
 *   autonomous-completion-rate = done_without_recovery / total_done_arcs
 *   recovery-success-rate      = (recovery.done AND origin.done) / all_recovery_samples
 *
 * Verdict:
 *   cost-per-merged-task       pass when delta ≤ 0 (same or cheaper)
 *   failure-rate               pass when delta ≤ 0 (same or fewer failures)
 *   autonomous-completion-rate pass when delta ≥ 0 (same or more autonomous)
 *   recovery-success-rate      pass when delta ≥ 0 (same or better recovery)
 *   Any metric with null values: n/a
 */

import type { Command } from '../command'
import type { DomainTaskStore } from '../../core/store/task-store'

// ── Window resolution ─────────────────────────────────────────────────────────

type RefResult = { ts: string } | { error: string }

/** Resolve a --before/--after ref to an ISO-8601 timestamp string. */
async function resolveRef(ref: string, store: DomainTaskStore): Promise<RefResult> {
  // If the value looks like a date (starts with four digits + hyphen), treat it
  // as an ISO timestamp directly.
  if (/^\d{4}-/.test(ref)) return { ts: ref }

  // Otherwise look up the task's created_at.
  const result = await store.query({
    sql: `SELECT created_at FROM tasks WHERE id = ?`,
    args: [ref],
  })
  if (result.rows.length === 0) {
    return { error: `task not found: ${ref}` }
  }
  const row = result.rows[0] as Record<string, unknown>
  const ts = row['created_at']
  if (typeof ts !== 'string') {
    return { error: `unexpected created_at value for task '${ref}'` }
  }
  return { ts }
}

// ── Cost computation ──────────────────────────────────────────────────────────

interface CostResult {
  /** Average USD cost per done task in the window, or null when no pricing. */
  avgCostPerMerge: number | null
}

/**
 * Compute average provider USD cost per done task in [windowStart, windowEnd].
 *
 * Reads trace_events step_ended rows for done tasks and applies PROVIDER_PRICING
 * from the Phase 4A cost-per-merged-task module. Tasks with no matching step_ended
 * rows (or unknown worker names) are excluded from the average.
 */
async function computeCostPerMergedTask(
  store: DomainTaskStore,
  windowStart: string,
  windowEnd: string,
): Promise<CostResult> {
  const { PROVIDER_PRICING, TOKEN_WEIGHTS } = await import(
    '../../core/lib/kpi/cost-per-merged-task.js'
  )

  const result = await store.query({
    sql: `SELECT
            t.id AS task_id,
            te.payload::jsonb #>> '{usageSignals,inputTokens}'       AS input_tokens,
            te.payload::jsonb #>> '{usageSignals,outputTokens}'      AS output_tokens,
            te.payload::jsonb #>> '{usageSignals,cacheCreateTokens}' AS cache_create_tokens,
            te.payload::jsonb #>> '{usageSignals,cacheReadTokens}'   AS cache_read_tokens,
            te.payload::jsonb ->> 'workerName'                       AS worker_name
          FROM tasks t
          LEFT JOIN trace_events te
            ON te.task_id = t.id
            AND te.kind = 'step_ended'
            AND te.payload::jsonb ->> 'usageSignals' IS NOT NULL
          WHERE t.status = 'done'
            AND t.updated_at >= ?
            AND t.updated_at <= ?`,
    args: [windowStart, windowEnd],
  })

  // Per-task accumulator: null costUsd means no pricing data found.
  const byTask = new Map<string, { costUsd: number | null }>()

  for (const rawRow of result.rows) {
    const row = rawRow as Record<string, unknown>
    const taskId = row['task_id'] as string

    if (!byTask.has(taskId)) {
      byTask.set(taskId, { costUsd: null })
    }
    const entry = byTask.get(taskId)!

    // LEFT JOIN padding row — task exists but has no matching step_ended event.
    if (row['input_tokens'] === null && row['output_tokens'] === null) continue

    const input = Number(row['input_tokens'] ?? 0)
    const output = Number(row['output_tokens'] ?? 0)
    const cacheCreate = Number(row['cache_create_tokens'] ?? 0)
    const cacheRead = Number(row['cache_read_tokens'] ?? 0)
    const workerName = row['worker_name'] as string | null
    const pricing = workerName !== null ? PROVIDER_PRICING[workerName] : undefined

    if (pricing !== undefined) {
      const stepCost =
        (input * pricing.inputPer1M +
          output * pricing.outputPer1M +
          cacheCreate * pricing.inputPer1M * TOKEN_WEIGHTS.cacheCreate +
          cacheRead * pricing.inputPer1M * TOKEN_WEIGHTS.cacheRead) /
        1_000_000
      entry.costUsd = (entry.costUsd ?? 0) + stepCost
    }
  }

  let totalCostUsd = 0
  let pricedCount = 0
  for (const entry of byTask.values()) {
    if (entry.costUsd !== null) {
      totalCostUsd += entry.costUsd
      pricedCount++
    }
  }

  return {
    avgCostPerMerge: pricedCount > 0 ? totalCostUsd / pricedCount : null,
  }
}

// ── Table rendering ────────────────────────────────────────────────────────────

type Verdict = 'pass' | 'fail' | 'n/a'

interface MetricRow {
  name: string
  before: number | null
  after: number | null
  /** Whether a higher value is better (true) or lower (false). */
  higherIsBetter: boolean
  kind: 'cost' | 'rate'
}

function formatCost(v: number | null): string {
  if (v === null) return 'n/a'
  return `$${v.toFixed(2)}`
}

function formatRate(v: number | null): string {
  if (v === null) return 'n/a'
  return `${(v * 100).toFixed(2)}%`
}

function formatDelta(row: MetricRow): string {
  if (row.before === null || row.after === null) return 'n/a'
  if (row.kind === 'cost') {
    const delta = row.after - row.before
    if (delta > 0) return `+$${delta.toFixed(2)}`
    if (delta < 0) return `-$${Math.abs(delta).toFixed(2)}`
    return `$${delta.toFixed(2)}`
  }
  // rate: express delta in percentage points
  const delta = (row.after - row.before) * 100
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toFixed(2)} pp`
}

function computeVerdict(row: MetricRow): Verdict {
  if (row.before === null || row.after === null) return 'n/a'
  const delta = row.after - row.before
  if (row.higherIsBetter) {
    return delta >= 0 ? 'pass' : 'fail'
  } else {
    return delta <= 0 ? 'pass' : 'fail'
  }
}

function renderTable(rows: MetricRow[], out: (s: string) => void): void {
  const COL_METRIC = 30
  const COL_VALUE = 12
  const COL_DELTA = 16
  const COL_VERDICT = 8

  const header =
    'metric'.padEnd(COL_METRIC) +
    'before'.padEnd(COL_VALUE) +
    'after'.padEnd(COL_VALUE) +
    'delta'.padEnd(COL_DELTA) +
    'verdict'.padEnd(COL_VERDICT)

  const sep = '─'.repeat(COL_METRIC + COL_VALUE + COL_VALUE + COL_DELTA + COL_VERDICT)

  out(header)
  out(sep)

  for (const row of rows) {
    const beforeStr = row.kind === 'cost' ? formatCost(row.before) : formatRate(row.before)
    const afterStr = row.kind === 'cost' ? formatCost(row.after) : formatRate(row.after)
    const deltaStr = formatDelta(row)
    const verdict = computeVerdict(row)
    const verdictStr = verdict === 'pass' ? '✓ pass' : verdict === 'fail' ? '✗ fail' : 'n/a'

    out(
      row.name.padEnd(COL_METRIC) +
        beforeStr.padEnd(COL_VALUE) +
        afterStr.padEnd(COL_VALUE) +
        deltaStr.padEnd(COL_DELTA) +
        verdictStr.padEnd(COL_VERDICT),
    )
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/** `mars kpi compare --before <ref> --after <ref>` */
const kpiCompare: Command = {
  path: 'kpi compare',
  summary: 'compare KPI metrics between two time windows',
  usage: 'mars kpi compare --before <ISO-timestamp|task-id> --after <ISO-timestamp|task-id>',
  helpBody: [
    'mars kpi compare --before <ref> --after <ref>',
    '',
    'Compare the four Phase 4A KPI metrics between two time windows and print a',
    '4-row table with before/after/delta/verdict columns.',
    '',
    '<ref> is either an ISO-8601 timestamp (e.g. 2026-01-01T00:00:00.000Z) or a',
    'task id (the window starts at that task\'s created_at).',
    '',
    'Windows:',
    '  before window: tasks that reached terminal status in [before_ts, after_ts]',
    '  after  window: tasks that reached terminal status in [after_ts, now]',
    '',
    'Metrics:',
    '  cost-per-merged-task       total provider $ / done task count',
    '  failure-rate               failed arcs / (done + failed) arcs',
    '  autonomous-completion-rate done without recovery / done arcs',
    '  recovery-success-rate      successful recoveries / all recoveries',
    '',
    'Verdict: ✓ pass when the metric improved or held steady, ✗ fail otherwise.',
    'n/a when either window has no data for that metric.',
    '',
    'Examples:',
    '  mars kpi compare --before 2026-01-01T00:00:00.000Z --after 2026-07-01T00:00:00.000Z',
    '  mars kpi compare --before mars-abc123 --after mars-def456',
  ].join('\n'),
  flags: [
    {
      syntax: '--before <ISO-timestamp|task-id>',
      description: 'Start of the "before" window; ISO timestamp or task id',
    },
    {
      syntax: '--after <ISO-timestamp|task-id>',
      description: 'Start of the "after" window (and end of the "before" window)',
    },
  ],
  run: async (args, deps) => {
    const beforeRaw = args.flags['--before']
    const afterRaw = args.flags['--after']

    if (!beforeRaw || !afterRaw) {
      deps.err(
        'error: --before and --after are required\n' +
          'usage: mars kpi compare --before <ref> --after <ref>',
      )
      return { code: 1 }
    }

    // Resolve refs to ISO timestamps.
    const { computeFailureRate, computeAutonomousCompletionRate, computeRecoverySuccessRate } =
      await import('../../core/lib/kpi-compute.js')

    const [beforeRef, afterRef] = await Promise.all([
      resolveRef(beforeRaw, deps.store),
      resolveRef(afterRaw, deps.store),
    ])

    if ('error' in beforeRef) {
      deps.err(`error: --before: ${beforeRef.error}`)
      return { code: 1 }
    }
    if ('error' in afterRef) {
      deps.err(`error: --after: ${afterRef.error}`)
      return { code: 1 }
    }

    const beforeTs = beforeRef.ts
    const afterTs = afterRef.ts
    const nowTs = new Date().toISOString()

    const beforeWindow = { windowStart: beforeTs, windowEnd: afterTs }
    const afterWindow = { windowStart: afterTs, windowEnd: nowTs }

    // Compute all metrics for both windows in parallel.
    const [
      costBefore,
      costAfter,
      failBefore,
      failAfter,
      autoBefore,
      autoAfter,
      recBefore,
      recAfter,
    ] = await Promise.all([
      computeCostPerMergedTask(deps.store, beforeTs, afterTs),
      computeCostPerMergedTask(deps.store, afterTs, nowTs),
      computeFailureRate(deps.store, beforeWindow),
      computeFailureRate(deps.store, afterWindow),
      computeAutonomousCompletionRate(deps.store, beforeWindow),
      computeAutonomousCompletionRate(deps.store, afterWindow),
      computeRecoverySuccessRate(deps.store, beforeWindow),
      computeRecoverySuccessRate(deps.store, afterWindow),
    ])

    const rows: MetricRow[] = [
      {
        name: 'cost-per-merged-task',
        before: costBefore.avgCostPerMerge,
        after: costAfter.avgCostPerMerge,
        higherIsBetter: false,
        kind: 'cost',
      },
      {
        name: 'failure-rate',
        before: failBefore.value,
        after: failAfter.value,
        higherIsBetter: false,
        kind: 'rate',
      },
      {
        name: 'autonomous-completion-rate',
        before: autoBefore.value,
        after: autoAfter.value,
        higherIsBetter: true,
        kind: 'rate',
      },
      {
        name: 'recovery-success-rate',
        before: recBefore.value,
        after: recAfter.value,
        higherIsBetter: true,
        kind: 'rate',
      },
    ]

    renderTable(rows, deps.out)
    return { code: 0 }
  },
}

export const kpiCommands: readonly Command[] = [kpiCompare]
