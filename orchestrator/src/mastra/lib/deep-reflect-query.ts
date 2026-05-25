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
    cacheHitRatio: number
  }
  scores: Record<string, TaskScoreEntry>
  conversation: ClaudeEvent[]
  verifyOutput: string | null
}

interface PickReason {
  taskId: string
  status: string
  weightedTokens: number
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
  weighted_tokens: number
}

const fetchTranscriptCostRows = async (): Promise<TranscriptCostRow[]> => {
  const c = getClient()
  const r = await c.execute(`
    SELECT t.id AS task_id, t.status AS status, t.created_at AS created_at,
           COALESCE(SUM(s.input_tokens + s.output_tokens + s.cache_create_tokens + CAST(s.cache_read_tokens AS REAL) * 0.1), 0) AS weighted_tokens
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
      weighted_tokens:
        r0.weighted_tokens === null || r0.weighted_tokens === undefined
          ? 0
          : Number(r0.weighted_tokens),
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
        weightedTokens: failed.weighted_tokens,
        reason: 'most recent failure',
      },
    }
  }

  // Rule 2: highest weighted-token done task in the last 7 days, tokens ≥ 2× median.
  const cutoff = Date.now() - SEVEN_DAYS_MS
  const recentDone = rows.filter(
    (r) => r.status === 'done' && new Date(r.created_at).getTime() >= cutoff,
  )
  if (recentDone.length > 0) {
    const med = median(recentDone.map((r) => r.weighted_tokens))
    const expensive = recentDone
      .filter((r) => med > 0 && r.weighted_tokens >= 2 * med)
      .sort((a, b) => b.weighted_tokens - a.weighted_tokens)
    const top = expensive[0]
    if (top) {
      return {
        taskId: top.task_id,
        reason: {
          taskId: top.task_id,
          status: top.status,
          weightedTokens: top.weighted_tokens,
          reason: `highest weighted-token done task in last 7d (≥ 2× median ${med.toFixed(0)} tokens)`,
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
        weightedTokens: done.weighted_tokens,
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
    messageCount: s.messageCount,
  }))
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

// ─────────────────────────────────────────────────────────────────────────
// Arc-level (originId) reflection
// ─────────────────────────────────────────────────────────────────────────

export interface ArcTaskEntry {
  taskId: string
  status: string
  prompt: string
  error: string | null
  createdAt: string
  updatedAt: string
  kind: string
  fixForTaskId: string | null
  signals: ReadonlyArray<Omit<TaskSignalRow, 'taskId' | 'recordedAt'>>
  totals: {
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
    cacheHitRatio: number
  }
  scores: Record<string, TaskScoreEntry>
  conversation: ClaudeEvent[]
  verifyOutput: string | null
  hasTranscript: boolean
}

export interface DeepReflectArc {
  originId: string
  tasks: ArcTaskEntry[]
  statusMix: Record<string, number>
  taskCount: number
  totals: {
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
    totalWeightedTokens: number
    cacheHitRatio: number
    eventCount: number
  }
  lastActivity: string
}

interface ArcTaskRow {
  id: string
  status: string
  prompt: string
  error: string | null
  created_at: string
  updated_at: string
  kind: string | null
  fix_for_task_id: string | null
}

const fetchArcTaskRows = async (originId: string): Promise<ArcTaskRow[]> => {
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT id, status, prompt, error, created_at, updated_at, kind, fix_for_task_id
            FROM tasks
           WHERE COALESCE(origin_id, id) = ?
           ORDER BY created_at ASC`,
    args: [originId],
  })
  return r.rows.map((row) => {
    const r0 = row as unknown as Record<string, unknown>
    return {
      id: r0.id as string,
      status: r0.status as string,
      prompt: String(r0.prompt ?? ''),
      error: (r0.error as string | null) ?? null,
      created_at: r0.created_at as string,
      updated_at: r0.updated_at as string,
      kind: (r0.kind as string | null) ?? null,
      fix_for_task_id: (r0.fix_for_task_id as string | null) ?? null,
    }
  })
}

const loadTaskTranscript = async (
  taskId: string,
): Promise<{ conversation: ClaudeEvent[]; verifyOutput: string | null; hasTranscript: boolean }> => {
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT conversation_json, verify_output FROM task_transcripts WHERE task_id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) {
    return { conversation: [], verifyOutput: null, hasTranscript: false }
  }
  const row = r.rows[0] as unknown as Record<string, unknown>
  const conversationJson = (row.conversation_json as string | null) ?? '[]'
  let conversation: ClaudeEvent[] = []
  try {
    const parsed = JSON.parse(conversationJson) as unknown
    if (Array.isArray(parsed)) conversation = parsed as ClaudeEvent[]
  } catch {
    conversation = []
  }
  return {
    conversation,
    verifyOutput: (row.verify_output as string | null) ?? null,
    hasTranscript: true,
  }
}

const summariseSignals = (rows: ReadonlyArray<TaskSignalRow>) => {
  const signals = rows.map((s) => ({
    stepId: s.stepId,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheCreateTokens: s.cacheCreateTokens,
    cacheReadTokens: s.cacheReadTokens,
    messageCount: s.messageCount,
  }))
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
  return {
    signals,
    totals: {
      ...sums,
      cacheHitRatio: cacheDenom === 0 ? 0 : sums.cacheReadTokens / cacheDenom,
    },
  }
}

export const loadDeepReflectArc = async (
  originId: string,
): Promise<DeepReflectArc | null> => {
  await initQueue()
  const rows = await fetchArcTaskRows(originId)
  if (rows.length === 0) return null

  const taskIds = rows.map((r) => r.id)
  const scoresMap = await loadScoresForTasks(taskIds)

  const tasks: ArcTaskEntry[] = []
  for (const row of rows) {
    const [signalRows, transcript] = await Promise.all([
      listTaskSignals(row.id),
      loadTaskTranscript(row.id),
    ])
    const { signals, totals } = summariseSignals(signalRows)
    const derivedKind = row.kind ?? (row.fix_for_task_id ? 'fix' : 'task')
    tasks.push({
      taskId: row.id,
      status: row.status,
      prompt: row.prompt,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      kind: derivedKind,
      fixForTaskId: row.fix_for_task_id,
      signals,
      totals,
      scores: scoresMap.get(row.id) ?? {},
      conversation: transcript.conversation,
      verifyOutput: transcript.verifyOutput,
      hasTranscript: transcript.hasTranscript,
    })
  }

  const statusMix: Record<string, number> = {}
  for (const t of tasks) statusMix[t.status] = (statusMix[t.status] ?? 0) + 1

  const arcSums = tasks.reduce(
    (acc, t) => ({
      inputTokens: acc.inputTokens + t.totals.inputTokens,
      outputTokens: acc.outputTokens + t.totals.outputTokens,
      cacheCreateTokens: acc.cacheCreateTokens + t.totals.cacheCreateTokens,
      cacheReadTokens: acc.cacheReadTokens + t.totals.cacheReadTokens,
      eventCount: acc.eventCount + t.conversation.length,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      eventCount: 0,
    },
  )
  const cacheDenom = arcSums.cacheCreateTokens + arcSums.cacheReadTokens
  const totals = {
    ...arcSums,
    cacheHitRatio: cacheDenom === 0 ? 0 : arcSums.cacheReadTokens / cacheDenom,
    totalWeightedTokens:
      arcSums.inputTokens +
      arcSums.outputTokens +
      arcSums.cacheCreateTokens +
      arcSums.cacheReadTokens * 0.1,
  }

  const lastActivity = tasks.reduce((latest, t) => {
    const candidate = t.updatedAt || t.createdAt
    return candidate > latest ? candidate : latest
  }, tasks[0]?.updatedAt ?? tasks[0]?.createdAt ?? '')

  return {
    originId,
    tasks,
    statusMix,
    taskCount: tasks.length,
    totals,
    lastActivity,
  }
}

export interface ArcCandidate {
  originId: string
  taskCount: number
  statusMix: Record<string, number>
  failureCount: number
  doneCount: number
  totalTokens: number
  lastActivity: string
  rankScore: number
}

interface ArcAggregateRow {
  task_id: string
  origin_id: string
  status: string
  created_at: string
  updated_at: string
  total_input: number
  total_output: number
  has_transcript: number
}

const fetchArcAggregateRows = async (): Promise<ArcAggregateRow[]> => {
  const c = getClient()
  const r = await c.execute(`
    SELECT t.id AS task_id,
           COALESCE(t.origin_id, t.id) AS origin_id,
           t.status AS status,
           t.created_at AS created_at,
           t.updated_at AS updated_at,
           COALESCE(SUM(s.input_tokens), 0) AS total_input,
           COALESCE(SUM(s.output_tokens), 0) AS total_output,
           CASE WHEN MAX(tt.task_id) IS NULL THEN 0 ELSE 1 END AS has_transcript
      FROM tasks t
      LEFT JOIN task_signals s ON s.task_id = t.id
      LEFT JOIN task_transcripts tt ON tt.task_id = t.id
     GROUP BY t.id
  `)
  return r.rows.map((row) => {
    const r0 = row as unknown as Record<string, unknown>
    return {
      task_id: r0.task_id as string,
      origin_id: r0.origin_id as string,
      status: r0.status as string,
      created_at: r0.created_at as string,
      updated_at: (r0.updated_at as string | null) ?? (r0.created_at as string),
      total_input: Number(r0.total_input ?? 0),
      total_output: Number(r0.total_output ?? 0),
      has_transcript: Number(r0.has_transcript ?? 0),
    }
  })
}

export const listDeepReflectArcCandidates = async (
  opts: { limit?: number; withTranscriptOnly?: boolean } = {},
): Promise<ArcCandidate[]> => {
  const limit = opts.limit ?? 5
  const withTranscriptOnly = opts.withTranscriptOnly ?? true

  await initQueue()
  const rows = await fetchArcAggregateRows()
  if (rows.length === 0) return []

  const byOrigin = new Map<string, ArcCandidate>()
  for (const row of rows) {
    const entry = byOrigin.get(row.origin_id) ?? {
      originId: row.origin_id,
      taskCount: 0,
      statusMix: {},
      failureCount: 0,
      doneCount: 0,
      totalTokens: 0,
      lastActivity: '',
      rankScore: 0,
    }
    entry.taskCount += 1
    entry.statusMix[row.status] = (entry.statusMix[row.status] ?? 0) + 1
    if (row.status === 'failed') entry.failureCount += 1
    if (row.status === 'done') entry.doneCount += 1
    entry.totalTokens += row.total_input + row.total_output
    if (row.has_transcript === 1) {
      // Track which arcs have at least one transcript via the rankScore
      // sentinel; finalised below.
      entry.rankScore = 1
    }
    const candidate = row.updated_at || row.created_at
    if (candidate > entry.lastActivity) entry.lastActivity = candidate
    byOrigin.set(row.origin_id, entry)
  }

  // Optionally restrict to arcs with at least one stored transcript.
  const eligible: ArcCandidate[] = []
  for (const arc of byOrigin.values()) {
    if (withTranscriptOnly && arc.rankScore !== 1) continue
    // Failures dominate; ties broken by token spend, then by recency.
    arc.rankScore = arc.failureCount * 1_000_000_000 + arc.totalTokens
    eligible.push(arc)
  }

  eligible.sort((a, b) => {
    if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore
    return b.lastActivity.localeCompare(a.lastActivity)
  })

  return eligible.slice(0, Math.max(0, limit))
}

export const resolveOriginIdForTaskOrSelf = async (
  taskId: string,
): Promise<string> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT COALESCE(origin_id, id) AS origin_id FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return taskId
  const row = r.rows[0] as unknown as { origin_id: string | null }
  return row.origin_id ?? taskId
}
