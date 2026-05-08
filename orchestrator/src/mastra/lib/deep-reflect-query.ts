import { getClient, initQueue } from '../queue'
import type { ClaudeEvent } from './claude-stream'
import { listTaskSignals, type TaskSignalRow } from './reflect-signals'
import { loadScoresForTasks, median, type TaskScoreEntry } from './reflect-query'

export interface DeepReflectSession {
  taskId: string
  status: string
  prompt: string
  error: string | null
  createdAt: string
  signals: ReadonlyArray<Omit<TaskSignalRow, 'taskId' | 'recordedAt'>>
  totals: {
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
    totalCostUsd: number
    cacheHitRatio: number
  }
  scores: Record<string, TaskScoreEntry>
  conversation: ClaudeEvent[]
  verifyOutput: string | null
}

interface PickReason {
  taskId: string
  status: string
  costUsd: number
  reason: string
}

export interface PickResult {
  taskId: string
  reason: PickReason
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

interface TranscriptCostRow {
  task_id: string
  status: string
  created_at: string
  total_cost_usd: number | null
}

const fetchTranscriptCostRows = async (): Promise<TranscriptCostRow[]> => {
  const c = getClient()
  const r = await c.execute(`
    SELECT t.id AS task_id, t.status AS status, t.created_at AS created_at,
           COALESCE(SUM(s.total_cost_usd), 0) AS total_cost_usd
      FROM tasks t
      JOIN task_transcripts tt ON tt.task_id = t.id
      LEFT JOIN task_signals s ON s.task_id = t.id
     WHERE t.status IN ('done', 'failed')
     GROUP BY t.id
     ORDER BY t.created_at DESC
  `)
  return r.rows.map((row) => {
    const r0 = row as unknown as Record<string, unknown>
    return {
      task_id: r0.task_id as string,
      status: r0.status as string,
      created_at: r0.created_at as string,
      total_cost_usd:
        r0.total_cost_usd === null || r0.total_cost_usd === undefined
          ? 0
          : Number(r0.total_cost_usd),
    }
  })
}

export const pickDeepReflectCandidate = async (): Promise<PickResult | null> => {
  await initQueue()
  const rows = await fetchTranscriptCostRows()
  if (rows.length === 0) return null

  // Rule 1: most recent failed task with a transcript.
  const failed = rows.find((r) => r.status === 'failed')
  if (failed) {
    return {
      taskId: failed.task_id,
      reason: {
        taskId: failed.task_id,
        status: failed.status,
        costUsd: failed.total_cost_usd ?? 0,
        reason: 'most recent failure',
      },
    }
  }

  // Rule 2: highest-cost done task in the last 7 days, cost ≥ 2× median.
  const cutoff = Date.now() - SEVEN_DAYS_MS
  const recentDone = rows.filter(
    (r) => r.status === 'done' && new Date(r.created_at).getTime() >= cutoff,
  )
  if (recentDone.length > 0) {
    const med = median(recentDone.map((r) => r.total_cost_usd ?? 0))
    const expensive = recentDone
      .filter((r) => med > 0 && (r.total_cost_usd ?? 0) >= 2 * med)
      .sort((a, b) => (b.total_cost_usd ?? 0) - (a.total_cost_usd ?? 0))
    const top = expensive[0]
    if (top) {
      return {
        taskId: top.task_id,
        reason: {
          taskId: top.task_id,
          status: top.status,
          costUsd: top.total_cost_usd ?? 0,
          reason: `highest-cost done task in last 7d (≥ 2× median $${med.toFixed(4)})`,
        },
      }
    }
  }

  // Rule 3: most recent done with a transcript.
  const done = rows.find((r) => r.status === 'done')
  if (done) {
    return {
      taskId: done.task_id,
      reason: {
        taskId: done.task_id,
        status: done.status,
        costUsd: done.total_cost_usd ?? 0,
        reason: 'most recent done task',
      },
    }
  }

  return null
}

export const loadDeepReflectSession = async (
  taskId: string,
): Promise<DeepReflectSession | null> => {
  await initQueue()
  const c = getClient()

  const taskRes = await c.execute({
    sql: `SELECT id, status, prompt, error, created_at FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (taskRes.rows.length === 0) return null
  const task = taskRes.rows[0] as unknown as Record<string, unknown>

  const transcriptRes = await c.execute({
    sql: `SELECT conversation_json, verify_output FROM task_transcripts WHERE task_id = ?`,
    args: [taskId],
  })
  if (transcriptRes.rows.length === 0) return null
  const transcript = transcriptRes.rows[0] as unknown as Record<string, unknown>
  const conversationJson = transcript.conversation_json as string
  let conversation: ClaudeEvent[] = []
  try {
    const parsed = JSON.parse(conversationJson) as unknown
    if (Array.isArray(parsed)) conversation = parsed as ClaudeEvent[]
  } catch {
    conversation = []
  }
  const verifyOutput = (transcript.verify_output as string | null) ?? null

  const signalRows = await listTaskSignals(taskId)
  const signals = signalRows.map((s) => ({
    stepId: s.stepId,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheCreateTokens: s.cacheCreateTokens,
    cacheReadTokens: s.cacheReadTokens,
    totalCostUsd: s.totalCostUsd,
    messageCount: s.messageCount,
  }))
  const sums = signals.reduce(
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
  const cacheDenom = sums.cacheCreateTokens + sums.cacheReadTokens
  const totals = {
    ...sums,
    cacheHitRatio: cacheDenom === 0 ? 0 : sums.cacheReadTokens / cacheDenom,
  }

  const scoresMap = await loadScoresForTasks([taskId])
  const scores = scoresMap.get(taskId) ?? {}

  return {
    taskId,
    status: task.status as string,
    prompt: task.prompt as string,
    error: (task.error as string | null) ?? null,
    createdAt: task.created_at as string,
    signals,
    totals,
    scores,
    conversation,
    verifyOutput,
  }
}
