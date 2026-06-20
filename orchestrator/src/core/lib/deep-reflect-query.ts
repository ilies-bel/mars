import { getDefaultTaskStore } from '../store/task-store'
import type { ClaudeEvent } from './claude-stream'
import { listTaskSignals, type TaskSignalRow } from './reflect-signals'
import { loadScoresForTasks, type TaskScoreEntry } from './reflect-query'
import {
  readAllTranscriptsForTask,
  resolveTranscriptLocationsForTask,
  type TranscriptLocation,
} from './claude-transcript'

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

// ─────────────────────────────────────────────────────────────────────────
// Arc-level (originId) reflection
// ─────────────────────────────────────────────────────────────────────────

/**
 * One closed Step span from the arc's trace_events, ordered by started_at.
 *
 * Non-LLM steps (setup, verify, merge, recovery-dispatch) carry no
 * workerName / sessionId / transcript.
 * LLM-backed steps (Coder, Fixer, Planner, Slicer) populate all four.
 * Verify steps additionally surface verifyOutput.
 */
export interface ArcSpanEntry {
  /** Approximated start time: ended_at − durationMs (ISO-8601). */
  startedAt: string
  /** Step name, e.g. 'generate-plan', 'setup-worktree', 'run-claude-code', 'verify', 'merge'. */
  stepName: string
  /** Worker name when LLM-backed (e.g. 'Planner', 'Slicer', 'Coder', 'Fixer'), null otherwise. */
  workerName: string | null
  /** Phase tag ('setup' | 'code' | 'verify' | 'merge'), null when not set. */
  phase: string | null
  /** Outcome of the step. */
  outcome: 'completed' | 'failed' | 'killed'
  /** Duration in milliseconds (−1 for spans closed by the orphan sweep). */
  durationMs: number
  /** Claude session id (LLM-backed only). */
  sessionId: string | null
  /** Serialised conversation transcript (LLM-backed, when reflection is enabled). */
  transcript: string | null
  /** Captured verify-command output (verify steps only). */
  verifyOutput: string | null
}

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
  /** Notes about transcript coverage (missing JSONL files, no session ids, …). */
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
  /**
   * All closed Step spans for this arc, sorted by started_at (ascending).
   * Planner/Slicer spans appear first (they ran before implementation tasks),
   * followed by per-task setup → code → verify(s) → merge/recovery sequences.
   * Multiple verify entries appear when verify retried (one entry per attempt).
   */
  stepTimeline: ArcSpanEntry[]
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
  // After PRD 436f14c7 slice 5, verify output lives in trace_events as the
  // verifyOutput field inside the payload of step_ended events. We take the
  // most recent non-null value for this task.
  const r = await store.query({
    sql: `SELECT payload
            FROM trace_events
           WHERE kind = 'step_ended' AND task_id = ?
             AND json_extract(payload, '$.verifyOutput') IS NOT NULL
           ORDER BY timestamp DESC
           LIMIT 1`,
    args: [taskId],
  })
  let verifyOutput: string | null = null
  if (r.rows.length > 0) {
    const row = r.rows[0] as unknown as { payload: string }
    try {
      const p = JSON.parse(row.payload) as Record<string, unknown>
      verifyOutput = (p.verifyOutput as string | null | undefined) ?? null
    } catch {
      /* ignore malformed payload */
    }
  }

  // Durable transcript read path (PRD: deep-reflect transcript durability).
  // Prefer the trace_events payload.transcript persisted by the
  // transcript-append subscriber (or upsertTranscript / runWorkerWithSpan).
  // This frees deep-reflect from depending on the ephemeral
  // ~/.claude/projects/ tree; the on-disk stream stays as the fallback so
  // arcs that pre-date the durable subscriber still resolve via the JSONL.
  const durable = await loadDurableTranscript(store, taskId)
  if (durable !== null) {
    return {
      conversation: durable.conversation,
      verifyOutput,
      hasTranscript: durable.conversation.length > 0,
      toolCallCounts: durable.toolCallCounts,
      transcriptNotes: [],
    }
  }

  const stream = await loadTranscriptStream(taskId)
  return {
    conversation: stream.conversation,
    verifyOutput,
    hasTranscript: stream.conversation.length > 0,
    toolCallCounts: stream.toolCallCounts,
    transcriptNotes: stream.notes,
  }
}

interface DurableTranscript {
  conversation: ClaudeEvent[]
  toolCallCounts: Record<string, number>
}

/**
 * Read the durable Claude transcript for a task from `trace_events`.
 *
 * Returns the most recent `step_ended` event whose payload carries a
 * non-empty `transcript` string, parsed back into `ClaudeEvent[]`.
 * Returns `null` when no such row exists — the caller falls back to the
 * on-disk JSONL stream.
 */
const loadDurableTranscript = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  taskId: string,
): Promise<DurableTranscript | null> => {
  const r = await store.query({
    sql: `SELECT payload
            FROM trace_events
           WHERE kind = 'step_ended' AND task_id = ?
             AND json_extract(payload, '$.transcript') IS NOT NULL
           ORDER BY timestamp DESC
           LIMIT 1`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { payload: string }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    return null
  }
  const transcriptRaw = payload.transcript
  if (typeof transcriptRaw !== 'string' || transcriptRaw.length === 0) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(transcriptRaw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const conversation: ClaudeEvent[] = []
  const toolCallCounts: Record<string, number> = {}
  for (const raw of parsed) {
    const event = coerceClaudeEvent(raw)
    if (!event) continue
    conversation.push(event)
    countToolCalls(event, toolCallCounts)
  }
  return { conversation, toolCallCounts }
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

  // ── Step timeline ─────────────────────────────────────────────────────────
  // Query all closed Step spans for the arc's origin, ordered by end timestamp
  // ascending. Since workflow steps run sequentially, end-time order matches
  // started_at order. startedAt is approximated as (endedAt − durationMs).
  const timelineRows = await store.query({
    sql: `SELECT timestamp, phase, payload
            FROM trace_events
           WHERE origin_id = ? AND kind = 'step_ended'
           ORDER BY timestamp ASC`,
    args: [originId],
  })

  const stepTimeline: ArcSpanEntry[] = timelineRows.rows.map((row) => {
    const r0 = row as unknown as { timestamp: string; phase: string | null; payload: string }
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(r0.payload) as Record<string, unknown>
    } catch {
      /* ignore malformed payload */
    }

    const stepName = typeof payload.stepName === 'string' ? payload.stepName : 'unknown'
    const workerName = typeof payload.workerName === 'string' ? payload.workerName : null
    const outcomeRaw = payload.outcome
    const outcome: ArcSpanEntry['outcome'] =
      outcomeRaw === 'completed' ? 'completed'
      : outcomeRaw === 'killed' ? 'killed'
      : 'failed'
    const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 0
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
    const transcript = typeof payload.transcript === 'string' ? payload.transcript : null
    const verifyOutput = typeof payload.verifyOutput === 'string' ? payload.verifyOutput : null

    // Derive start time: span ended at `timestamp`, ran for `durationMs` ms.
    // When durationMs is ≤ 0 (orphan sweep fills −1), fall back to the end timestamp.
    const endedMs = new Date(r0.timestamp).getTime()
    const startedAt =
      durationMs > 0
        ? new Date(endedMs - durationMs).toISOString()
        : r0.timestamp

    return {
      startedAt,
      stepName,
      workerName,
      phase: r0.phase,
      outcome,
      durationMs,
      sessionId,
      transcript,
      verifyOutput,
    }
  })

  return {
    originId,
    tasks,
    statusMix,
    taskCount: tasks.length,
    totals,
    lastActivity,
    stepTimeline,
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
  // After PRD 436f14c7 slice 5, usage signals and transcript markers live in
  // trace_events. json_extract reads the usageSignals sub-object from step_ended
  // payloads; SUM over NULLs resolves to NULL which COALESCE converts to 0.
  // has_transcript is 1 when any step_ended event for the task carries a
  // 'transcript' key in its payload (written by runWorkerWithSpan or upsertTranscript).
  const r = await store.query(`
    SELECT t.id AS task_id,
           COALESCE(t.origin_id, t.id) AS origin_id,
           t.status AS status,
           t.created_at AS created_at,
           t.updated_at AS updated_at,
           COALESCE(CAST(SUM(json_extract(te.payload, '$.usageSignals.inputTokens')) AS INTEGER), 0) AS total_input,
           COALESCE(CAST(SUM(json_extract(te.payload, '$.usageSignals.outputTokens')) AS INTEGER), 0) AS total_output,
           MAX(CASE WHEN json_extract(te.payload, '$.transcript') IS NOT NULL THEN 1 ELSE 0 END) AS has_transcript
      FROM tasks t
      LEFT JOIN trace_events te ON te.task_id = t.id AND te.kind = 'step_ended'
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
