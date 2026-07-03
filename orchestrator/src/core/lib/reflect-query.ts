import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from '../store/task-store'
import type { TaskSignalRow } from './reflect-signals'
import { cacheWeightedTokens } from './kpi-compute.js'

export interface ReflectCorpusEntry {
  taskId: string
  status: string
  promptPrefix: string
  errorTail: string | null
  createdAt: string
  /** Classifier fields — populated from the tasks table; null when not yet set. */
  failureSignature: string | null
  failureReasonCode: string | null
  failedPhase: string | null
  kind: string | null
  fixForTaskId: string | null
  originId: string | null
  /**
   * Count of tool_invoked severity=error trace events for this task,
   * excluding probes where payload.expectsFailure is true.
   */
  toolErrorCount: number
  /**
   * The most frequently failing tool for this task, formatted as
   * "toolName argv[0]" (argv[0] omitted when absent). Null when no errors.
   */
  topErrorTool: string | null
  signals: ReadonlyArray<Omit<TaskSignalRow, 'taskId' | 'recordedAt'>>
  totals: {
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
    cacheHitRatio: number
  }
}

export interface ReflectCostSummary {
  totalWeightedTokens: number
  taskCount: number
  successCount: number
  failureCount: number
  blockedCount: number
  droppedCount: number
  cacheHitRatio: number
  /**
   * Window-level count of rate_limit_event rejections observed in trace_events
   * over the same time window as the task corpus. Zero when none are found.
   */
  rateLimitRejections: number
  topTokenHeavyTasks: ReadonlyArray<{
    taskId: string
    status: string
    weightedTokens: number
    timesMedian: number
  }>
  topExpensiveSteps: ReadonlyArray<{
    taskId: string
    stepId: string
    weightedTokens: number
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
  }>
  tokensByStep: ReadonlyArray<{
    stepId: string
    totalWeightedTokens: number
    invocations: number
    avgWeightedTokens: number
  }>
}

export interface ReflectCorpus {
  entries: ReflectCorpusEntry[]
  costSummary: ReflectCostSummary
}

export interface LoadCorpusOptions {
  sinceIso?: string
  limit?: number
  /**
   * Injected TaskStore over `.mars/queue.db`. Defaults to the composition-root
   * singleton (`getDefaultTaskStore()`) when omitted so existing CLI callers
   * keep working; tests inject an in-memory store.
   */
  store?: TaskStore
}

const PROMPT_PREFIX_BYTES = 200
const ERROR_TAIL_BYTES = 600

const truncate = (value: string | null, bytes: number): string | null => {
  if (value === null) return null
  if (value.length <= bytes) return value
  return `${value.slice(0, bytes)}…`
}

const tail = (value: string | null, bytes: number): string | null => {
  if (value === null) return null
  if (value.length <= bytes) return value
  return `…${value.slice(value.length - bytes)}`
}

export const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const buildCostSummary = (
  entries: readonly ReflectCorpusEntry[],
  rateLimitRejections: number,
): ReflectCostSummary => {
  const taskCount = entries.length
  if (taskCount === 0) {
    return {
      totalWeightedTokens: 0,
      taskCount: 0,
      successCount: 0,
      failureCount: 0,
      blockedCount: 0,
      droppedCount: 0,
      cacheHitRatio: 0,
      rateLimitRejections,
      topTokenHeavyTasks: [],
      topExpensiveSteps: [],
      tokensByStep: [],
    }
  }

  const entryWeights = entries.map((e) => cacheWeightedTokens(e.totals))
  const totalWeightedTokens = entryWeights.reduce((a, b) => a + b, 0)
  const med = median(entryWeights)
  const successCount = entries.filter((e) => e.status === 'done').length
  const failureCount = entries.filter((e) => e.status === 'failed').length
  const blockedCount = entries.filter((e) => e.status === 'blocked').length
  const droppedCount = entries.filter((e) => e.status === 'dropped').length
  const totalCacheCreate = entries.reduce((a, e) => a + e.totals.cacheCreateTokens, 0)
  const totalCacheRead = entries.reduce((a, e) => a + e.totals.cacheReadTokens, 0)
  const cacheDenom = totalCacheCreate + totalCacheRead
  const cacheHitRatio = cacheDenom === 0 ? 0 : totalCacheRead / cacheDenom

  const topTokenHeavyTasks = entries
    .map((e, i) => ({
      taskId: e.taskId,
      status: e.status,
      weightedTokens: entryWeights[i] ?? 0,
      timesMedian: med === 0 ? 0 : (entryWeights[i] ?? 0) / med,
    }))
    .sort((a, b) => b.weightedTokens - a.weightedTokens)
    .slice(0, 5)

  const stepBuckets = new Map<string, { totalWeightedTokens: number; invocations: number }>()
  const allSteps: Array<{
    taskId: string
    stepId: string
    weightedTokens: number
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
  }> = []
  for (const entry of entries) {
    for (const s of entry.signals) {
      const sw = cacheWeightedTokens(s)
      const bucket = stepBuckets.get(s.stepId) ?? { totalWeightedTokens: 0, invocations: 0 }
      bucket.totalWeightedTokens += sw
      bucket.invocations += 1
      stepBuckets.set(s.stepId, bucket)
      allSteps.push({
        taskId: entry.taskId,
        stepId: s.stepId,
        weightedTokens: sw,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheCreateTokens: s.cacheCreateTokens,
        cacheReadTokens: s.cacheReadTokens,
      })
    }
  }
  const tokensByStep = Array.from(stepBuckets.entries())
    .map(([stepId, b]) => ({
      stepId,
      totalWeightedTokens: b.totalWeightedTokens,
      invocations: b.invocations,
      avgWeightedTokens:
        b.invocations === 0 ? 0 : b.totalWeightedTokens / b.invocations,
    }))
    .sort((a, b) => b.totalWeightedTokens - a.totalWeightedTokens)

  const topExpensiveSteps = allSteps
    .sort((a, b) => b.weightedTokens - a.weightedTokens)
    .slice(0, 5)

  return {
    totalWeightedTokens,
    taskCount,
    successCount,
    failureCount,
    blockedCount,
    droppedCount,
    cacheHitRatio,
    rateLimitRejections,
    topTokenHeavyTasks,
    topExpensiveSteps,
    tokensByStep,
  }
}

/**
 * Re-order entries so that tasks sharing the same arc (origin_id) are adjacent
 * in the output. Arc groups are ordered by the most recent task in each group
 * (preserving the original newest-first sense). Within each arc group, tasks
 * are sorted chronologically (origin task first, recovery tasks after) so the
 * model reads the arc in causal order.
 */
const groupByArc = (entries: ReflectCorpusEntry[]): ReflectCorpusEntry[] => {
  // Map from arc key → entries[], preserving insertion order of first encounter.
  const arcs = new Map<string, ReflectCorpusEntry[]>()
  for (const entry of entries) {
    const key = entry.originId ?? entry.taskId
    const group = arcs.get(key) ?? []
    group.push(entry)
    arcs.set(key, group)
  }
  // Within each arc sort chronologically (origin before recovery).
  for (const group of arcs.values()) {
    group.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  }
  // Flatten; arc groups are already in newest-first order because `entries`
  // came from `ORDER BY created_at DESC` and Map preserves insertion order.
  return Array.from(arcs.values()).flat()
}

export const loadRecentTaskCorpus = async (
  options: LoadCorpusOptions = {},
): Promise<ReflectCorpus> => {
  const limit = options.limit ?? 10
  const sinceIso = options.sinceIso ?? null

  const queue = options.store ?? (await getDefaultTaskStore())

  // Include blocked and dropped in addition to done/failed so the reflector
  // can see stalled-task patterns (verify:completeness loops, dropped scope).
  const taskRows = sinceIso
    ? await queue.query({
        sql: `SELECT id, status, prompt, error, created_at,
                     failure_signature, failure_reason_code, failed_phase,
                     kind, fix_for_task_id, origin_id
                FROM tasks
               WHERE created_at >= ?
                 AND status IN ('done', 'failed', 'blocked', 'dropped')
               ORDER BY created_at DESC
               LIMIT ?`,
        args: [sinceIso, limit],
      })
    : await queue.query({
        sql: `SELECT id, status, prompt, error, created_at,
                     failure_signature, failure_reason_code, failed_phase,
                     kind, fix_for_task_id, origin_id
                FROM tasks
               WHERE status IN ('done', 'failed', 'blocked', 'dropped')
               ORDER BY created_at DESC
               LIMIT ?`,
        args: [limit],
      })

  if (taskRows.rows.length === 0) {
    return { entries: [], costSummary: buildCostSummary([], 0) }
  }

  const taskIds = taskRows.rows.map((r) => (r as unknown as { id: string }).id)
  const placeholders = taskIds.map(() => '?').join(',')

  // After PRD 436f14c7 slice 5, usage signals live in trace_events as step_ended
  // events. json_extract reads the usageSignals sub-object; rows without it
  // (e.g. verify-output-only events) are excluded by the IS NOT NULL filter.
  const signalRows = await queue.query({
    sql: `SELECT task_id,
                 json_extract(payload, '$.stepName') AS step_id,
                 CAST(json_extract(payload, '$.usageSignals.inputTokens') AS INTEGER) AS input_tokens,
                 CAST(json_extract(payload, '$.usageSignals.outputTokens') AS INTEGER) AS output_tokens,
                 CAST(json_extract(payload, '$.usageSignals.cacheCreateTokens') AS INTEGER) AS cache_create_tokens,
                 CAST(json_extract(payload, '$.usageSignals.cacheReadTokens') AS INTEGER) AS cache_read_tokens,
                 CAST(json_extract(payload, '$.usageSignals.messageCount') AS INTEGER) AS message_count
            FROM trace_events
           WHERE kind = 'step_ended'
             AND json_extract(payload, '$.usageSignals') IS NOT NULL
             AND task_id IN (${placeholders})`,
    args: taskIds,
  })

  // Tool error counts per task, excluding expectsFailure=true probes.
  // Grouped by (task_id, tool, argv[0]) ordered by count desc so the first
  // row per task_id is the top offender.
  const toolErrorRows = await queue.query({
    sql: `SELECT task_id,
                 json_extract(payload, '$.tool') AS tool,
                 COALESCE(json_extract(payload, '$.argv[0]'), '') AS argv0,
                 COUNT(*) AS cnt
            FROM trace_events
           WHERE kind = 'tool_invoked'
             AND severity = 'error'
             AND (json_extract(payload, '$.expectsFailure') IS NULL
                  OR json_extract(payload, '$.expectsFailure') = 0)
             AND task_id IN (${placeholders})
           GROUP BY task_id, tool, argv0
           ORDER BY task_id, cnt DESC`,
    args: taskIds,
  })

  // Build per-task tool error summary: total count + top offending tool.
  const toolErrorByTask = new Map<string, { count: number; topTool: string | null }>()
  for (const row of toolErrorRows.rows) {
    const r = row as unknown as Record<string, unknown>
    const taskId = r.task_id as string
    const cnt = Number(r.cnt ?? 0)
    const tool = (r.tool as string | null) ?? ''
    const argv0 = (r.argv0 as string | null) ?? ''
    if (!toolErrorByTask.has(taskId)) {
      // First row for this task = highest count = top offender.
      const label = argv0 ? `${tool} ${argv0}` : tool
      toolErrorByTask.set(taskId, { count: cnt, topTool: label || null })
    } else {
      // Subsequent rows: accumulate count only.
      const existing = toolErrorByTask.get(taskId)!
      existing.count += cnt
    }
  }

  // Window-level rate-limit rejection count. These log_line events carry the
  // structured payload as fields.payload; they have no task_id so we query
  // by time window instead.
  const windowStart = sinceIso
    ? sinceIso
    : (taskRows.rows[taskRows.rows.length - 1] as unknown as Record<string, unknown>)
        .created_at as string
  const rateLimitRow = await queue.query({
    sql: `SELECT COUNT(*) AS count
            FROM trace_events
           WHERE kind = 'log_line'
             AND json_extract(payload, '$.fields.payload.type') = 'rate_limit_event'
             AND json_extract(payload, '$.fields.payload.rate_limit_info.status') = 'rejected'
             AND timestamp >= ?`,
    args: [windowStart],
  })
  const rateLimitRejections = Number(
    ((rateLimitRow.rows[0] as unknown as Record<string, unknown>)?.count as number | null) ?? 0,
  )

  const signalsByTask = new Map<string, ReflectCorpusEntry['signals'][number][]>()
  for (const row of signalRows.rows) {
    const r = row as unknown as Record<string, unknown>
    const taskId = r.task_id as string
    const list = signalsByTask.get(taskId) ?? []
    list.push({
      stepId: (r.step_id as string | null) ?? 'code',
      inputTokens: Number(r.input_tokens ?? 0),
      outputTokens: Number(r.output_tokens ?? 0),
      cacheCreateTokens: Number(r.cache_create_tokens ?? 0),
      cacheReadTokens: Number(r.cache_read_tokens ?? 0),
      messageCount: Number(r.message_count ?? 0),
    })
    signalsByTask.set(taskId, list)
  }

  const entries: ReflectCorpusEntry[] = taskRows.rows.map((row) => {
    const r = row as unknown as Record<string, unknown>
    const taskId = r.id as string
    const signals = signalsByTask.get(taskId) ?? []
    const sums = signals.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + s.inputTokens,
        outputTokens: acc.outputTokens + s.outputTokens,
        cacheCreateTokens: acc.cacheCreateTokens + s.cacheCreateTokens,
        cacheReadTokens: acc.cacheReadTokens + s.cacheReadTokens,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
      },
    )
    const cacheDenom = sums.cacheCreateTokens + sums.cacheReadTokens
    const totals = {
      ...sums,
      cacheHitRatio: cacheDenom === 0 ? 0 : sums.cacheReadTokens / cacheDenom,
    }
    const toolErr = toolErrorByTask.get(taskId) ?? { count: 0, topTool: null }
    const originId = (r.origin_id as string | null) ?? null
    return {
      taskId,
      status: r.status as string,
      promptPrefix: truncate(r.prompt as string, PROMPT_PREFIX_BYTES) ?? '',
      errorTail: tail((r.error as string | null) ?? null, ERROR_TAIL_BYTES),
      createdAt: r.created_at as string,
      failureSignature: (r.failure_signature as string | null) ?? null,
      failureReasonCode: (r.failure_reason_code as string | null) ?? null,
      failedPhase: (r.failed_phase as string | null) ?? null,
      kind: (r.kind as string | null) ?? null,
      fixForTaskId: (r.fix_for_task_id as string | null) ?? null,
      originId,
      toolErrorCount: toolErr.count,
      topErrorTool: toolErr.topTool,
      signals,
      totals,
    }
  })

  // Group arc siblings (origin + recovery tasks) adjacent in the output so the
  // model sees arcs, not isolated rows.
  const grouped = groupByArc(entries)

  return { entries: grouped, costSummary: buildCostSummary(grouped, rateLimitRejections) }
}
