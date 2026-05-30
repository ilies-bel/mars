import { getDefaultTaskStore, type TaskStore } from './task-store'
import type { TaskSignalRow } from './reflect-signals'
import { cacheWeightedTokens } from './kpi-compute.js'

export interface ReflectCorpusEntry {
  taskId: string
  status: string
  promptPrefix: string
  errorTail: string | null
  createdAt: string
  scores: Record<string, { score: number; reason: string | null }>
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
  cacheHitRatio: number
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

export interface TaskScoreEntry {
  score: number
  reason: string | null
}

/**
 * Per-task scorer scores keyed by scorerId.
 *
 * The implement pipeline used to emit two Mastra scorers (`verify-passed`,
 * `merge-clean`) into a `mastra_scorers` table that this function read back.
 * Both scorers were removed with the @mars/workflow port (they were unused),
 * so the table is never written again and the read path is dead. This now
 * returns an empty map unconditionally — every corpus entry's `scores` is
 * `{}`. The function (and {@link TaskScoreEntry}) survive as a stable seam so
 * `loadRecentTaskCorpus` and deep-reflect-query keep compiling and working;
 * the rest of the reflect corpus (signals, token totals, cost summary) is
 * unaffected. Reintroduce a real read path here if a future durable scorer
 * lands.
 */
export const loadScoresForTasks = async (
  _taskIds: readonly string[],
): Promise<Map<string, Record<string, TaskScoreEntry>>> => {
  return new Map<string, Record<string, TaskScoreEntry>>()
}

const buildCostSummary = (entries: readonly ReflectCorpusEntry[]): ReflectCostSummary => {
  const taskCount = entries.length
  if (taskCount === 0) {
    return {
      totalWeightedTokens: 0,
      taskCount: 0,
      successCount: 0,
      failureCount: 0,
      cacheHitRatio: 0,
      topTokenHeavyTasks: [],
      topExpensiveSteps: [],
      tokensByStep: [],
    }
  }

  const entryWeights = entries.map((e) => cacheWeightedTokens(e.totals))
  const totalWeightedTokens = entryWeights.reduce((a, b) => a + b, 0)
  const med = median(entryWeights)
  const successes = entries.filter((e) => e.status === 'done')
  const failures = entries.filter((e) => e.status === 'failed')
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
    successCount: successes.length,
    failureCount: failures.length,
    cacheHitRatio,
    topTokenHeavyTasks,
    topExpensiveSteps,
    tokensByStep,
  }
}

export const loadRecentTaskCorpus = async (
  options: LoadCorpusOptions = {},
): Promise<ReflectCorpus> => {
  const limit = options.limit ?? 10
  const sinceIso = options.sinceIso ?? null

  const queue = options.store ?? (await getDefaultTaskStore())

  const taskRows = sinceIso
    ? await queue.query({
        sql: `SELECT id, status, prompt, error, created_at
                FROM tasks
               WHERE created_at >= ?
                 AND status IN ('done', 'failed')
               ORDER BY created_at DESC
               LIMIT ?`,
        args: [sinceIso, limit],
      })
    : await queue.query({
        sql: `SELECT id, status, prompt, error, created_at
                FROM tasks
               WHERE status IN ('done', 'failed')
               ORDER BY created_at DESC
               LIMIT ?`,
        args: [limit],
      })

  if (taskRows.rows.length === 0) {
    return { entries: [], costSummary: buildCostSummary([]) }
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

  const scoresByTask = await loadScoresForTasks(taskIds)

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
    return {
      taskId,
      status: r.status as string,
      promptPrefix: truncate(r.prompt as string, PROMPT_PREFIX_BYTES) ?? '',
      errorTail: tail((r.error as string | null) ?? null, ERROR_TAIL_BYTES),
      createdAt: r.created_at as string,
      scores: scoresByTask.get(taskId) ?? {},
      signals,
      totals,
    }
  })
  return { entries, costSummary: buildCostSummary(entries) }
}
