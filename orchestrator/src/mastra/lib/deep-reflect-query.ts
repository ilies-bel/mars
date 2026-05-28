import { getDefaultTaskStore } from './task-store'
import type { ClaudeEvent } from './claude-stream'
import { listTaskSignals, type TaskSignalRow } from './reflect-signals'
import { loadScoresForTasks, median, type TaskScoreEntry } from './reflect-query'
import {
  readAllTranscriptsForTask,
  resolveTranscriptLocationsForTask,
  type TranscriptLocation,
} from './claude-transcript'

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
  /**
   * Human-readable notes about transcript coverage. Populated when the
   * task has no recorded session ids ("no transcripts recorded for this
   * task") or when one of the recorded session ids has no JSONL file on
   * disk ("transcript <id> not found on disk: <path>"). Empty when every
   * session resolved cleanly.
   */
  transcriptNotes: string[]
  /** Per-tool counts derived from the JSONL stream (`{ Edit: 12, Bash: 7 }`). */
  toolCallCounts: Record<string, number>
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

/**
 * Coerce a raw JSONL payload into a {@link ClaudeEvent} if it satisfies
 * the loose `{ type: string, ... }` shape. Returns null otherwise so
 * downstream stats reflect "events Mars can reason about" rather than
 * every line in the file (some Claude versions also emit summary or
 * metadata lines without a `type`).
 */
const coerceClaudeEvent = (raw: unknown): ClaudeEvent | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.type !== 'string') return null
  return o as unknown as ClaudeEvent
}

/**
 * Count tool calls in a parsed Claude event. Mirrors the shape Claude
 * uses both in stream-json and on-disk JSONL: tool calls live as
 * `tool_use` blocks inside `message.content` on assistant turns, or as
 * top-level `{ type: 'tool_use', name }` events on some versions.
 */
const countToolCalls = (event: ClaudeEvent, counts: Record<string, number>): void => {
  if (event.type === 'tool_use' && typeof event.name === 'string') {
    counts[event.name] = (counts[event.name] ?? 0) + 1
    return
  }
  if (event.type === 'assistant' || event.type === 'user') {
    const message = event.message
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object' || Array.isArray(block)) continue
          const b = block as Record<string, unknown>
          if (b.type === 'tool_use' && typeof b.name === 'string') {
            counts[b.name] = (counts[b.name] ?? 0) + 1
          }
        }
      }
    }
  }
}

interface TranscriptStreamResult {
  conversation: ClaudeEvent[]
  toolCallCounts: Record<string, number>
  notes: string[]
}

/**
 * Stream every JSONL event for a task, coerce to ClaudeEvent[], and
 * tally per-tool counts. Also reports any missing-on-disk transcripts
 * so the caller can surface them in the report without a stack trace.
 */
const loadTranscriptStream = async (
  taskId: string,
): Promise<TranscriptStreamResult> => {
  const locations: TranscriptLocation[] =
    await resolveTranscriptLocationsForTask(taskId)
  const notes: string[] = []
  if (locations.length === 0) {
    notes.push(`no transcripts recorded for task ${taskId}`)
    return { conversation: [], toolCallCounts: {}, notes }
  }
  for (const loc of locations) {
    if (!loc.exists) {
      notes.push(`transcript ${loc.sessionId} not found on disk: ${loc.path}`)
    }
  }
  const conversation: ClaudeEvent[] = []
  const toolCallCounts: Record<string, number> = {}
  for await (const evt of readAllTranscriptsForTask(taskId)) {
    const claudeEvent = coerceClaudeEvent(evt.raw)
    if (!claudeEvent) continue
    conversation.push(claudeEvent)
    countToolCalls(claudeEvent, toolCallCounts)
  }
  return { conversation, toolCallCounts, notes }
}

const fetchTranscriptCostRows = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
): Promise<TranscriptCostRow[]> => {
  const r = await store.query(`
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
  const store = await getDefaultTaskStore()
  const rows = await fetchTranscriptCostRows(store)
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
  const store = await getDefaultTaskStore()

  const taskRes = await store.query({
    sql: `SELECT id, status, prompt, error, created_at FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (taskRes.rows.length === 0) return null
  const task = taskRes.rows[0] as unknown as Record<string, unknown>

  // Verify output is still surfaced via the task_transcripts row when the
  // verify span writer recorded one. The legacy conversation_json column
  // on the same table is no longer written or read — slice J reads
  // conversations directly from Claude Code's on-disk JSONL transcripts.
  const verifyRes = await store.query({
    sql: `SELECT verify_output FROM task_transcripts WHERE task_id = ?`,
    args: [taskId],
  })
  const verifyOutput =
    verifyRes.rows.length === 0
      ? null
      : ((verifyRes.rows[0] as unknown as Record<string, unknown>).verify_output as
          | string
          | null) ?? null

  const transcript = await loadTranscriptStream(taskId)
  const { conversation, toolCallCounts, notes: transcriptNotes } = transcript

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
    transcriptNotes,
    toolCallCounts,
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
  /** True when at least one JSONL transcript file resolved to disk. */
  hasTranscript: boolean
  /** Per-tool counts derived from this task's JSONL transcripts. */
  toolCallCounts: Record<string, number>
  /** Notes about transcript coverage; see DeepReflectSession.transcriptNotes. */
  transcriptNotes: string[]
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

const fetchArcTaskRows = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  originId: string,
): Promise<ArcTaskRow[]> => {
  const r = await store.query({
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

interface LoadedTaskTranscript {
  conversation: ClaudeEvent[]
  verifyOutput: string | null
  hasTranscript: boolean
  toolCallCounts: Record<string, number>
  transcriptNotes: string[]
}

const loadTaskTranscript = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  taskId: string,
): Promise<LoadedTaskTranscript> => {
  // Verify output still lives on task_transcripts.verify_output (recorded
  // by the verify span writer). The conversation_json column is no longer
  // read — we stream the on-disk JSONL transcripts instead.
  const r = await store.query({
    sql: `SELECT verify_output FROM task_transcripts WHERE task_id = ?`,
    args: [taskId],
  })
  const verifyOutput =
    r.rows.length === 0
      ? null
      : ((r.rows[0] as unknown as Record<string, unknown>).verify_output as
          | string
          | null) ?? null

  const stream = await loadTranscriptStream(taskId)
  return {
    conversation: stream.conversation,
    verifyOutput,
    hasTranscript: stream.conversation.length > 0,
    toolCallCounts: stream.toolCallCounts,
    transcriptNotes: stream.notes,
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
  const store = await getDefaultTaskStore()
  const rows = await fetchArcTaskRows(store, originId)
  if (rows.length === 0) return null

  const taskIds = rows.map((r) => r.id)
  const scoresMap = await loadScoresForTasks(taskIds)

  const tasks: ArcTaskEntry[] = []
  for (const row of rows) {
    const [signalRows, transcript] = await Promise.all([
      listTaskSignals(row.id),
      loadTaskTranscript(store, row.id),
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
      toolCallCounts: transcript.toolCallCounts,
      transcriptNotes: transcript.transcriptNotes,
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

const fetchArcAggregateRows = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
): Promise<ArcAggregateRow[]> => {
  const r = await store.query(`
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

  const store = await getDefaultTaskStore()
  const rows = await fetchArcAggregateRows(store)
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
  const store = await getDefaultTaskStore()
  const r = await store.query({
    sql: `SELECT COALESCE(origin_id, id) AS origin_id FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return taskId
  const row = r.rows[0] as unknown as { origin_id: string | null }
  return row.origin_id ?? taskId
}
