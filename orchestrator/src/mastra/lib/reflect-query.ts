import { createClient } from '@libsql/client'
import { resolveContext } from '../context'
import { getClient, initQueue } from '../queue'
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
    totalCostUsd: number
  }
}

export interface LoadCorpusOptions {
  sinceIso?: string
  limit?: number
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

export const loadRecentTaskCorpus = async (
  options: LoadCorpusOptions = {},
): Promise<ReflectCorpusEntry[]> => {
  const limit = options.limit ?? 10
  const sinceIso = options.sinceIso ?? null

  await initQueue()
  const queue = getClient()

  const taskRows = sinceIso
    ? await queue.execute({
        sql: `SELECT id, status, prompt, error, created_at
                FROM tasks
               WHERE created_at >= ?
                 AND status IN ('done', 'failed')
               ORDER BY created_at DESC
               LIMIT ?`,
        args: [sinceIso, limit],
      })
    : await queue.execute({
        sql: `SELECT id, status, prompt, error, created_at
                FROM tasks
               WHERE status IN ('done', 'failed')
               ORDER BY created_at DESC
               LIMIT ?`,
        args: [limit],
      })

  if (taskRows.rows.length === 0) return []

  const taskIds = taskRows.rows.map((r) => (r as unknown as { id: string }).id)
  const placeholders = taskIds.map(() => '?').join(',')

  const signalRows = await queue.execute({
    sql: `SELECT task_id, step_id, input_tokens, output_tokens,
                 cache_create_tokens, cache_read_tokens, total_cost_usd,
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
      totalCostUsd: Number(r.total_cost_usd ?? 0),
      messageCount: Number(r.message_count ?? 0),
    })
    signalsByTask.set(taskId, list)
  }

  const { mastraDbPath } = resolveContext()
  const mastraClient = createClient({ url: `file:${mastraDbPath}` })
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
    // mastra_scorers table may not exist on a brand-new install
    scorerRows = []
  }

  const scoresByTask = new Map<
    string,
    Record<string, { score: number; reason: string | null }>
  >()
  for (const row of scorerRows) {
    const taskId = tryParseTaskIdFromInput(row.input)
    if (!taskId) continue
    if (!taskIds.includes(taskId)) continue
    const score = row.score ?? 0
    const existing = scoresByTask.get(taskId) ?? {}
    existing[row.scorerId] = { score, reason: row.reason }
    scoresByTask.set(taskId, existing)
  }

  return taskRows.rows.map((row) => {
    const r = row as unknown as Record<string, unknown>
    const taskId = r.id as string
    const signals = signalsByTask.get(taskId) ?? []
    const totals = signals.reduce(
      (acc, s) => ({
        inputTokens: acc.inputTokens + s.inputTokens,
        outputTokens: acc.outputTokens + s.outputTokens,
        cacheCreateTokens: acc.cacheCreateTokens + s.cacheCreateTokens,
        cacheReadTokens: acc.cacheReadTokens + s.cacheReadTokens,
        totalCostUsd: acc.totalCostUsd + s.totalCostUsd,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: 0,
      },
    )
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
}
