import { resolveContext } from '../context'
import { openLibsql } from './libsql'
import { getDefaultTaskStore, type TaskStore } from './task-store'
import type { TaskSignalRow } from './reflect-signals'

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

interface MastraScorerRow {
  scorerId: string
  score: number | null
  reason: string | null
  input: string | null
}

const tryParseTaskIdFromInput = (input: string | null): string | null => {
  if (!input) return null
  try {
    const parsed = JSON.parse(input) as { taskId?: unknown }
    if (typeof parsed.taskId === 'string') return parsed.taskId
  } catch {
    // ignore
  }
  return null
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

export const loadScoresForTasks = async (
  taskIds: readonly string[],
): Promise<Map<string, Record<string, TaskScoreEntry>>> => {
  const scoresByTask = new Map<string, Record<string, TaskScoreEntry>>()
  if (taskIds.length === 0) return scoresByTask
  const { mastraDbPath } = resolveContext()
  // openLibsql issues PRAGMA foreign_keys = ON as a fire-and-forget. This is
  // behaviourally inert here: this connection only runs SELECTs against
  // mastra.db and exercises no FK constraints. Routed through the helper to
  // satisfy AC#3 (no raw createClient in Mars-owned source outside the helper).
  const mastraClient = openLibsql({ url: `file:${mastraDbPath}` })
  let scorerRows: MastraScorerRow[] = []
  try {
    const r = await mastraClient.execute({
      sql: `SELECT scorerId, score, reason, input
              FROM mastra_scorers
             WHERE scorerId IN ('verify-passed', 'merge-clean')`,
      args: [],
    })
    scorerRows = r.rows.map((row) => {
      const r0 = row as unknown as Record<string, unknown>
      return {
        scorerId: (r0.scorerId as string) ?? '',
        score: r0.score === null || r0.score === undefined ? null : Number(r0.score),
        reason: (r0.reason as string | null) ?? null,
        input: (r0.input as string | null) ?? null,
      }
    })
  } catch {
    return scoresByTask
  }
  const idSet = new Set(taskIds)
  for (const row of scorerRows) {
    const taskId = tryParseTaskIdFromInput(row.input)
    if (!taskId || !idSet.has(taskId)) continue
    const score = row.score ?? 0
    const existing = scoresByTask.get(taskId) ?? {}
    existing[row.scorerId] = { score, reason: row.reason }
    scoresByTask.set(taskId, existing)
  }
  return scoresByTask
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

  const entryWeights = entries.map(
    (e) =>
      e.totals.inputTokens +
      e.totals.outputTokens +
      e.totals.cacheCreateTokens +
      e.totals.cacheReadTokens * 0.1,
  )
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
      const sw =
        s.inputTokens + s.outputTokens + s.cacheCreateTokens + s.cacheReadTokens * 0.1
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

  const signalRows = await queue.query({
    sql: `SELECT task_id, step_id, input_tokens, output_tokens,
                 cache_create_tokens, cache_read_tokens,
                 message_count
            FROM task_signals
           WHERE task_id IN (${placeholders})`,
    args: taskIds,
  })

  const signalsByTask = new Map<string, ReflectCorpusEntry['signals'][number][]>()
  for (const row of signalRows.rows) {
    const r = row as unknown as Record<string, unknown>
    const taskId = r.task_id as string
    const list = signalsByTask.get(taskId) ?? []
    list.push({
      stepId: r.step_id as string,
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
