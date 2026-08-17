/**
 * Cost-per-merged-task KPI (Phase 4A, PRD 74d76a78).
 *
 * Aggregates cache-weighted token usage and provider cost per completed task
 * (status='done') using token data from trace_events step_ended payloads.
 *
 * Token weights follow the pricing convention for Anthropic's Claude API:
 *   - input / output: billed at face value (weight 1)
 *   - cache creation: 1.25× input price (extra cost to write cache)
 *   - cache read:     0.10× input price (discounted cache hit)
 *
 * PROVIDER_PRICING is keyed by workerName as stored in step_ended payloads.
 * Unknown worker names produce null per-step cost; tasks where every step
 * has null cost are excluded from avgCostPerMerge and counted separately.
 */

import type { DbClient } from '../db.js'

// ── Token weighting constants ─────────────────────────────────────────────────

export const TOKEN_WEIGHTS = {
  input: 1,
  output: 1,
  cacheRead: 0.1,
  cacheCreate: 1.25,
} as const

// ── Provider pricing ──────────────────────────────────────────────────────────
//
// Keyed by workerName (worker.config.name) as recorded in step_ended payloads.
// Pricing is in USD per 1 million tokens.
// Cache creation is priced at inputPer1M * TOKEN_WEIGHTS.cacheCreate.
// Cache read is priced at inputPer1M * TOKEN_WEIGHTS.cacheRead.

export const PROVIDER_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Claude-backed workers (balanced / sonnet tier as default)
  Coder: { inputPer1M: 3.0, outputPer1M: 15.0 },
  Fixer: { inputPer1M: 3.0, outputPer1M: 15.0 },
  Planner: { inputPer1M: 3.0, outputPer1M: 15.0 },
  Slicer: { inputPer1M: 3.0, outputPer1M: 15.0 },
  RescueOperator: { inputPer1M: 3.0, outputPer1M: 15.0 },
  BehaviourVerifier: { inputPer1M: 3.0, outputPer1M: 15.0 },
  // Fast / haiku-tier workers
  Triager: { inputPer1M: 0.8, outputPer1M: 4.0 },
  Scorer: { inputPer1M: 0.8, outputPer1M: 4.0 },
  // Steward runs on the balanced tier
  steward: { inputPer1M: 3.0, outputPer1M: 15.0 },
}

// ── Return types ──────────────────────────────────────────────────────────────

interface CostPerMergedTaskCurrent {
  /** Total USD cost across tasks whose pricing is known (null when none are known). */
  costUsd: number | null
  /** Total cache-weighted token count across all done tasks in the window. */
  tokens: number
  /** Number of done tasks (status='done') in the window. */
  mergedCount: number
  /**
   * Average USD cost per merged task (excludes tasks with unknown pricing).
   * Null when no tasks have computable pricing.
   */
  avgCostPerMerge: number | null
  /** Number of tasks excluded from avgCostPerMerge due to unknown pricing. */
  excludedNullCostCount: number
}

interface CostPerMergedTaskTrendEntry {
  /** ISO-8601 date string (YYYY-MM-DD) representing the day tasks completed. */
  day: string
  /** Average USD cost per merged task that day (null when no pricing data). */
  avgCostPerMerge: number | null
  /** Number of done tasks that day. */
  mergedCount: number
}

export interface CostPerMergedTaskKpi {
  current: CostPerMergedTaskCurrent
  trend: CostPerMergedTaskTrendEntry[]
}

// ── Internal types ────────────────────────────────────────────────────────────

interface StepRow {
  task_id: string
  done_at: string
  input_tokens: string | null
  output_tokens: string | null
  cache_create_tokens: string | null
  cache_read_tokens: string | null
  worker_name: string | null
}

// ── Cost computation helpers ──────────────────────────────────────────────────

/** Compute cache-weighted token count for a single step's usage. */
const weightedTokens = (
  input: number,
  output: number,
  cacheCreate: number,
  cacheRead: number,
): number =>
  input * TOKEN_WEIGHTS.input +
  output * TOKEN_WEIGHTS.output +
  cacheCreate * TOKEN_WEIGHTS.cacheCreate +
  cacheRead * TOKEN_WEIGHTS.cacheRead

/**
 * Compute USD cost for a step given pricing.
 * Cache creation is priced at inputPer1M × cacheCreate weight.
 * Cache read is priced at inputPer1M × cacheRead weight.
 */
const stepCostUsd = (
  input: number,
  output: number,
  cacheCreate: number,
  cacheRead: number,
  pricing: { inputPer1M: number; outputPer1M: number },
): number =>
  (input * pricing.inputPer1M +
    output * pricing.outputPer1M +
    cacheCreate * pricing.inputPer1M * TOKEN_WEIGHTS.cacheCreate +
    cacheRead * pricing.inputPer1M * TOKEN_WEIGHTS.cacheRead) /
  1_000_000

/** Extract the ISO-8601 date portion of a timestamp string. */
const toDay = (ts: string): string => ts.slice(0, 10)

// ── Main query ────────────────────────────────────────────────────────────────

/**
 * Return cost-per-merged-task KPI for the given rolling window.
 *
 * Reads from:
 *   tasks         — status='done' tasks whose updated_at is within the window
 *   trace_events  — step_ended rows carrying usageSignals for those tasks
 *
 * @param db         DbClient over the Mars PostgreSQL database.
 * @param opts       windowDays: number of trailing days to include (e.g. 30).
 */
export async function getCostPerMergedTask(
  db: DbClient,
  opts: { windowDays: number },
): Promise<CostPerMergedTaskKpi> {
  const windowEnd = new Date().toISOString()
  const windowStart = new Date(
    Date.now() - opts.windowDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  // Fetch per-step token data for all done tasks in the window.
  // LEFT JOIN so tasks without any matching step_ended rows still appear
  // (with null token fields) so they are included in mergedCount.
  const rs = await db.execute({
    sql: `SELECT t.id AS task_id,
                 t.updated_at AS done_at,
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
             AND t.updated_at >= $1
             AND t.updated_at <= $2
           ORDER BY t.id, te.id`,
    args: [windowStart, windowEnd],
  })

  // ── Aggregate in TypeScript ───────────────────────────────────────────────
  //
  // Group by task_id to accumulate per-task totals, then derive current + trend.

  // Per-task accumulator: { tokens, costUsd (null = no pricing), doneAt }
  const byTask = new Map<string, { tokens: number; costUsd: number | null; doneAt: string; hasSteps: boolean }>()

  for (const rawRow of rs.rows) {
    const row = rawRow as unknown as StepRow
    const { task_id, done_at } = row

    // Initialise the task entry on first encounter.
    if (!byTask.has(task_id)) {
      byTask.set(task_id, { tokens: 0, costUsd: null, doneAt: String(done_at), hasSteps: false })
    }
    const entry = byTask.get(task_id)!

    // Row with all-null token fields means the task had no matching step_ended
    // events (LEFT JOIN returned a null padding row). Skip accumulation.
    if (row.input_tokens === null && row.output_tokens === null) {
      continue
    }

    entry.hasSteps = true

    const input = Number(row.input_tokens ?? 0)
    const output = Number(row.output_tokens ?? 0)
    const cacheCreate = Number(row.cache_create_tokens ?? 0)
    const cacheRead = Number(row.cache_read_tokens ?? 0)

    entry.tokens += weightedTokens(input, output, cacheCreate, cacheRead)

    const pricing = row.worker_name !== null ? PROVIDER_PRICING[row.worker_name] : undefined
    if (pricing !== undefined) {
      entry.costUsd = (entry.costUsd ?? 0) + stepCostUsd(input, output, cacheCreate, cacheRead, pricing)
    }
  }

  // ── Build current aggregate ───────────────────────────────────────────────

  let totalTokens = 0
  let totalCostUsd = 0
  let hasCostUsd = false
  let pricedCount = 0
  let excludedNullCostCount = 0

  // For trend: group by day.
  // Each day entry accumulates: pricedCostUsd, pricedTaskCount, totalMerged
  const byDay = new Map<string, { pricedCostUsd: number; pricedCount: number; mergedCount: number }>()

  for (const [, entry] of byTask) {
    totalTokens += entry.tokens

    const day = toDay(entry.doneAt)
    if (!byDay.has(day)) {
      byDay.set(day, { pricedCostUsd: 0, pricedCount: 0, mergedCount: 0 })
    }
    const dayEntry = byDay.get(day)!
    dayEntry.mergedCount += 1

    if (entry.costUsd !== null) {
      totalCostUsd += entry.costUsd
      hasCostUsd = true
      pricedCount += 1
      dayEntry.pricedCostUsd += entry.costUsd
      dayEntry.pricedCount += 1
    } else {
      excludedNullCostCount += 1
    }
  }

  const mergedCount = byTask.size
  const costUsd = hasCostUsd ? totalCostUsd : null
  const avgCostPerMerge = pricedCount > 0 ? totalCostUsd / pricedCount : null

  const current: CostPerMergedTaskCurrent = {
    costUsd,
    tokens: totalTokens,
    mergedCount,
    avgCostPerMerge,
    excludedNullCostCount,
  }

  // ── Build trend (oldest-first) ────────────────────────────────────────────

  const trend: CostPerMergedTaskTrendEntry[] = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, d]) => ({
      day,
      avgCostPerMerge: d.pricedCount > 0 ? d.pricedCostUsd / d.pricedCount : null,
      mergedCount: d.mergedCount,
    }))

  return { current, trend }
}
