import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { getDefaultTaskStore } from '../store/task-store'
import { getRepoRoot, getStateDir } from '../context'
import type { ClaudeEvent } from './claude-stream'
import { isReflectDisabled, listTaskSignals, type TaskSignalRow } from './reflect-signals'
import {
  readAllTranscriptsForTask,
  readTranscript,
  resolveTranscriptForSession,
  resolveTranscriptLocationsForTask,
  type TranscriptLocation,
} from './claude-transcript'

const gunzipAsync = promisify(gunzip)

// ── Foreground-session slice constants ────────────────────────────────────────
/** How far before the cli-invocation anchor to include operator messages. */
const FOREGROUND_WINDOW_BEFORE_MS = 30 * 60 * 1000 // 30 min
/** How far after the cli-invocation anchor to include operator messages. */
const FOREGROUND_WINDOW_AFTER_MS = 5 * 60 * 1000 // 5 min
/** Hard cap on the number of messages in a foreground slice. */
const FOREGROUND_MAX_MESSAGES = 100
/** How many tail messages to return when events have no timestamp fields. */
const FOREGROUND_FALLBACK_MESSAGES = 50

/**
 * A bounded slice of the operator's foreground Claude Code session,
 * extracted around the time the task was enqueued.
 */
export interface OperatorContext {
  /** The foreground Claude Code session UUID (`CLAUDE_CODE_SESSION_ID`). */
  sessionId: string
  /**
   * Conversation events from the operator session, trimmed to the time
   * window or message-count cap. Empty when the transcript file is absent.
   */
  messages: ClaudeEvent[]
  /**
   * How the time anchor was derived:
   * - `'cli-invocation'` — anchored on the matching `cli-invocation`
   *   trace event (preferred; captures the exact moment of enqueue).
   * - `'created-at-fallback'` — no `cli-invocation` event found; anchored
   *   on `tasks.created_at` instead, or events had no timestamp fields.
   * - `'none'` — transcript file not present on disk.
   */
  windowKind: 'cli-invocation' | 'created-at-fallback' | 'none'
  /** Human-readable note about coverage gaps or fallback conditions. */
  note: string | null
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
/**
 * One tool_invoked error event recorded by runTool during the arc.
 *
 * Only events where `exitCode !== 0` AND `expectsFailure !== true` are
 * included (i.e. severity === 'error' rows). Events with `expectsFailure:
 * true` are omitted — they represent expected probe failures, not incidents.
 */
export interface ArcToolError {
  /** ISO-8601 timestamp of the event. */
  timestamp: string
  /** Task that was running when this tool was invoked (may be null for daemon-global). */
  taskId: string | null
  /** Orchestrator phase (setup | code | verify | merge | null). */
  phase: string | null
  /** Logical tool name (e.g. 'pnpm', 'git', 'npm'). */
  tool: string
  /** Argv array passed to the tool. */
  argv: unknown[]
  /** Exit code (always non-zero). */
  exitCode: number
  /** Truncated stderr from the run (at most 8 KB as stored by runTool). */
  stderr: string
}

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
  /**
   * Recorded Scorer results for this instance (PRD 6cf85bc9): post-merge
   * per-Workflow quality scores from accepted Scorers. Empty for unscored
   * tasks; feeds the arc-reflection prompt as a quality signal.
   */
  scorerResults: ReadonlyArray<{
    scorerId: string
    workflow: string
    score: number | null
    rationale: string
    status: string
  }>
  totals: {
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
    cacheHitRatio: number
  }
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
  /**
   * tool_invoked error events (non-zero exit, expectsFailure=false) for this arc,
   * sorted by timestamp ascending. Represents orchestrator-level failures such as
   * pnpm install exit-254 bursts, git failures, or other setup/verify shell-outs.
   * NOT the Claude agent's own tool calls — those live in the conversation transcript.
   */
  toolInvokedErrors: ArcToolError[]
  /**
   * Bounded slice of the operator's foreground Claude Code session captured
   * around the time this arc's origin task was enqueued. Null when the task
   * has no `origin_session_id` (created outside a Claude Code session) or
   * when reflection is disabled (`MARS_REFLECT_DISABLED=1`).
   */
  operatorContext: OperatorContext | null
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
  origin_session_id: string | null
}

const fetchArcTaskRows = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  originId: string,
): Promise<ArcTaskRow[]> => {
  // Try the full query including origin_session_id (added in a later migration).
  // If that column is absent (e.g. an injected legacy/test store), fall back to
  // the column-free form so a missing column never surfaces as a raw database
  // error — which would bypass the arc-existence check and expose an
  // unformatted error to the user.
  let hasSessionIdColumn = true
  let r: Awaited<ReturnType<typeof store.query>>
  try {
    r = await store.query({
      sql: `SELECT id, status, prompt, error, created_at, updated_at, kind, fix_for_task_id, origin_session_id
              FROM tasks
             WHERE COALESCE(origin_id, id) = ?
             ORDER BY created_at ASC`,
      args: [originId],
    })
  } catch {
    // Column missing on pre-migration DB — retry without origin_session_id.
    hasSessionIdColumn = false
    try {
      r = await store.query({
        sql: `SELECT id, status, prompt, error, created_at, updated_at, kind, fix_for_task_id
                FROM tasks
               WHERE COALESCE(origin_id, id) = ?
               ORDER BY created_at ASC`,
        args: [originId],
      })
    } catch {
      // tasks table doesn't exist yet (brand-new DB) — treat as no rows so
      // the caller can return the friendly not-found error.
      return []
    }
  }
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
      origin_session_id: hasSessionIdColumn ? ((r0.origin_session_id as string | null) ?? null) : null,
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
             AND payload::jsonb ->> 'verifyOutput' IS NOT NULL
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

  // Primary transcript read path: streaming chunks from task_transcripts,
  // written incrementally during the coder run. Available even for sessions
  // that were watchdog-killed before step_ended was written.
  const chunks = await loadTranscriptChunks(store, taskId)
  if (chunks !== null) {
    return {
      conversation: chunks.conversation,
      verifyOutput,
      hasTranscript: chunks.conversation.length > 0,
      toolCallCounts: chunks.toolCallCounts,
      transcriptNotes: [],
    }
  }

  // Fallback 1: the trace_events payload.transcript persisted by the
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
 * Read the streaming transcript chunks for a task from `task_transcripts`.
 *
 * Rows are inserted incrementally as events stream from the coder run, so
 * this path is available even for sessions that were watchdog-killed before
 * `step_ended` was written. Returns `null` when no chunk rows exist —
 * the caller falls back to the `step_ended` payload path.
 */
const loadTranscriptChunks = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  taskId: string,
): Promise<DurableTranscript | null> => {
  let r: Awaited<ReturnType<typeof store.query>>
  try {
    r = await store.query({
      sql: `SELECT chunk FROM task_transcripts
             WHERE task_id = ?
             ORDER BY session_id ASC, seq ASC`,
      args: [taskId],
    })
  } catch {
    // task_transcripts may not exist on very old DBs — treat as no data.
    return null
  }
  if (r.rows.length === 0) return null
  const conversation: ClaudeEvent[] = []
  const toolCallCounts: Record<string, number> = {}
  for (const row of r.rows) {
    const rawRow = row as unknown as { chunk: string }
    try {
      const parsed = JSON.parse(rawRow.chunk) as unknown
      if (!Array.isArray(parsed)) continue
      for (const raw of parsed) {
        const event = coerceClaudeEvent(raw)
        if (!event) continue
        conversation.push(event)
        countToolCalls(event, toolCallCounts)
      }
    } catch {
      /* skip malformed chunk rows */
    }
  }
  return conversation.length > 0 ? { conversation, toolCallCounts } : null
}

/**
 * Read the durable Claude transcript for a task from `task_durable_transcripts`.
 *
 * Rows are stored as gzip-compressed JSON blobs (written by runWorkerWithSpan
 * or upsertTranscript). Returns null when no row exists — the caller falls
 * back to the on-disk JSONL stream.
 *
 * Hard cut: this path no longer reads inline transcripts from step_ended
 * payloads (those were removed in the durable-transcript migration).
 */
const loadDurableTranscript = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  taskId: string,
): Promise<DurableTranscript | null> => {
  let r: Awaited<ReturnType<typeof store.query>>
  try {
    r = await store.query({
      sql: `SELECT transcript FROM task_durable_transcripts WHERE task_id = ?`,
      args: [taskId],
    })
  } catch {
    // task_durable_transcripts may not exist on very old DBs — treat as no data.
    return null
  }
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { transcript: Uint8Array | null }
  if (!row.transcript) return null
  let transcriptJson: string
  try {
    const decompressed = await gunzipAsync(Buffer.from(row.transcript))
    transcriptJson = decompressed.toString('utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(transcriptJson)
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

/**
 * Extract a bounded slice of an operator's foreground Claude Code session
 * transcript, anchored on the `cli-invocation` trace event that fired when
 * the origin task was enqueued.
 *
 * **Primary path** — anchor on the `cli-invocation` trace event whose
 * `payload.originSessionId` matches the task's `origin_session_id`. The
 * window is [anchor − 30 min, anchor + 5 min], capped at
 * {@link FOREGROUND_MAX_MESSAGES} events.
 *
 * **Fallback** — when no `cli-invocation` event exists, or events have no
 * `timestamp` field, fall back to the last {@link FOREGROUND_FALLBACK_MESSAGES}
 * events in the file (a simple tail, not time-gated).
 *
 * Gated: only called when `isReflectDisabled()` is false and
 * `origin_session_id` is non-null — the caller enforces both.
 */
const loadForegroundSlice = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  originSessionId: string,
  taskCreatedAt: string,
  opts: { homeDir?: string; repoRoot?: string },
): Promise<OperatorContext> => {
  // Resolve the repo root for the foreground session's transcript path.
  let repoRoot: string
  try {
    repoRoot = opts.repoRoot ?? getRepoRoot()
  } catch {
    return {
      sessionId: originSessionId,
      messages: [],
      windowKind: 'none',
      note: 'repo root unavailable — cannot locate foreground transcript',
    }
  }

  // Resolve the on-disk path for this foreground session.
  const loc = await resolveTranscriptForSession(originSessionId, repoRoot, {
    homeDir: opts.homeDir,
  })
  if (!loc.exists) {
    return {
      sessionId: originSessionId,
      messages: [],
      windowKind: 'none',
      note: `foreground transcript not found on disk: ${loc.path}`,
    }
  }

  // Find the cli-invocation trace event closest to the task's created_at —
  // this is the most precise anchor for when the enqueue happened.
  let anchorMs: number = new Date(taskCreatedAt).getTime()
  let windowKind: 'cli-invocation' | 'created-at-fallback' = 'created-at-fallback'
  try {
    const r = await store.query({
      sql: `SELECT timestamp
              FROM trace_events
             WHERE kind = 'cli-invocation'
               AND payload::jsonb ->> 'originSessionId' = ?
             ORDER BY timestamp DESC
             LIMIT 10`,
      args: [originSessionId],
    })
    if (r.rows.length > 0) {
      const taskCreatedMs = new Date(taskCreatedAt).getTime()
      let bestDelta = Infinity
      for (const row of r.rows) {
        const r0 = row as unknown as { timestamp: number }
        const ts = r0.timestamp
        const delta = Math.abs(ts - taskCreatedMs)
        if (delta < bestDelta) {
          bestDelta = delta
          anchorMs = ts
          windowKind = 'cli-invocation'
        }
      }
    }
  } catch {
    // trace_events query failed — use the created_at anchor
  }

  // Stream transcript and collect the bounded window.
  const windowStart = anchorMs - FOREGROUND_WINDOW_BEFORE_MS
  const windowEnd = anchorMs + FOREGROUND_WINDOW_AFTER_MS

  const windowedMessages: ClaudeEvent[] = []
  const allMessages: ClaudeEvent[] = []
  let hasTimestamps = false

  for await (const evt of readTranscript(loc.path)) {
    const event = coerceClaudeEvent(evt.raw)
    if (!event) continue
    allMessages.push(event)
    if (typeof event.timestamp === 'string') {
      hasTimestamps = true
      const evMs = new Date(event.timestamp as string).getTime()
      if (evMs >= windowStart && evMs <= windowEnd) {
        windowedMessages.push(event)
      }
    }
  }

  if (hasTimestamps) {
    return {
      sessionId: originSessionId,
      messages: windowedMessages.slice(0, FOREGROUND_MAX_MESSAGES),
      windowKind,
      note: windowedMessages.length === 0 ? 'no events found in time window' : null,
    }
  }

  // Events have no timestamp fields — take the tail of the file as a proxy
  // for "the most recent operator context before the task was created".
  return {
    sessionId: originSessionId,
    messages: allMessages.slice(-FOREGROUND_FALLBACK_MESSAGES),
    windowKind: 'created-at-fallback',
    note: 'transcript events have no timestamps; using last-N fallback',
  }
}

/**
 * Load recorded scorer_results rows for one task (PRD 6cf85bc9). Resilient:
 * a store predating the table yields an empty list.
 */
const loadTaskScorerResults = async (
  store: Awaited<ReturnType<typeof getDefaultTaskStore>>,
  taskId: string,
): Promise<ArcTaskEntry['scorerResults']> => {
  try {
    const r = await store.query({
      sql: `SELECT scorer_id, workflow, score, rationale, status
              FROM scorer_results
             WHERE task_id = ?
             ORDER BY created_at DESC`,
      args: [taskId],
    })
    return r.rows.map((row) => {
      const r0 = row as unknown as Record<string, unknown>
      return {
        scorerId: r0.scorer_id as string,
        workflow: r0.workflow as string,
        score: r0.score === null || r0.score === undefined ? null : Number(r0.score),
        rationale: (r0.rationale as string | null) ?? '',
        status: (r0.status as string | null) ?? 'scored',
      }
    })
  } catch {
    return []
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
  opts: { homeDir?: string; repoRoot?: string } = {},
): Promise<DeepReflectArc | null> => {
  const store = await getDefaultTaskStore()
  const rows = await fetchArcTaskRows(store, originId)
  if (rows.length === 0) return null

  const tasks: ArcTaskEntry[] = []
  for (const row of rows) {
    const [signalRows, transcript, scorerResults] = await Promise.all([
      listTaskSignals(row.id),
      loadTaskTranscript(store, row.id),
      loadTaskScorerResults(store, row.id),
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
      scorerResults,
      totals,
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
    const r0 = row as unknown as { timestamp: number; phase: string | null; payload: string }
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
    // transcripts are no longer embedded in step_ended payloads — they live
    // in task_durable_transcripts as compressed BLOBs (per-task, not per-step).
    // ArcTaskEntry.conversation holds the per-task transcript loaded via
    // loadTaskTranscript; this per-span field is always null after migration.
    const transcript = null
    const verifyOutput = typeof payload.verifyOutput === 'string' ? payload.verifyOutput : null

    // Derive start time: span ended at `timestamp`, ran for `durationMs` ms.
    // When durationMs is ≤ 0 (orphan sweep fills −1), fall back to the end timestamp.
    const endedMs = r0.timestamp
    const startedAt =
      durationMs > 0
        ? new Date(endedMs - durationMs).toISOString()
        : new Date(r0.timestamp).toISOString()

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

  // ── Tool-invoked error events ─────────────────────────────────────────────
  // Fetch all tool_invoked events for the arc where the tool exited non-zero
  // and expectsFailure is false (severity='error'). These represent orchestrator
  // failures such as pnpm install bursts that block setup — they are distinct
  // from the agent's own tool calls which live in the conversation transcript.
  const toolErrorRows = await store.query({
    sql: `SELECT timestamp, task_id, phase, payload
            FROM trace_events
           WHERE origin_id = ? AND kind = 'tool_invoked' AND severity = 'error'
           ORDER BY timestamp ASC`,
    args: [originId],
  })

  const toolInvokedErrors: ArcToolError[] = toolErrorRows.rows.map((row) => {
    const r0 = row as unknown as {
      timestamp: number
      task_id: string | null
      phase: string | null
      payload: string
    }
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(r0.payload) as Record<string, unknown>
    } catch {
      /* ignore malformed payload */
    }
    return {
      timestamp: new Date(r0.timestamp).toISOString(),
      taskId: r0.task_id ?? null,
      phase: r0.phase ?? null,
      tool: typeof payload.tool === 'string' ? payload.tool : 'unknown',
      argv: Array.isArray(payload.argv) ? payload.argv : [],
      exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : -1,
      stderr: typeof payload.stderr === 'string' ? payload.stderr : '',
    }
  })

  // ── Foreground operator context ───────────────────────────────────────────
  // When the origin task carries an origin_session_id (set by the CLI when the
  // operator's Claude Code session enqueued it), load a bounded slice of their
  // foreground conversation transcript. This enriches the reflection corpus
  // with the operator's intent and the discussion that preceded the enqueue.
  // Gated by isReflectDisabled() so MARS_REFLECT_DISABLED=1 suppresses it.
  let operatorContext: OperatorContext | null = null
  if (!isReflectDisabled()) {
    const originRow = rows.find((r) => r.id === originId) ?? rows[0]
    const originSessionId = originRow?.origin_session_id ?? null
    if (originSessionId) {
      operatorContext = await loadForegroundSlice(
        store,
        originSessionId,
        originRow!.created_at,
        opts,
      )
    }
  }

  return {
    originId,
    tasks,
    statusMix,
    taskCount: tasks.length,
    totals,
    lastActivity,
    stepTimeline,
    toolInvokedErrors,
    operatorContext,
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
  // Usage signals live in trace_events step_ended payloads (small after the
  // transcript migration). The jsonb extraction is fast because payloads no
  // longer embed multi-megabyte transcript strings.
  // has_transcript uses EXISTS against the dedicated transcript tables — never
  // scans step_ended payloads — so the join over multi-MB blobs is eliminated.
  const r = await store.query(`
    SELECT t.id AS task_id,
           COALESCE(t.origin_id, t.id) AS origin_id,
           t.status AS status,
           t.created_at AS created_at,
           t.updated_at AS updated_at,
           COALESCE(CAST(SUM(CAST(te.payload::jsonb #>> '{usageSignals,inputTokens}' AS numeric)) AS bigint), 0) AS total_input,
           COALESCE(CAST(SUM(CAST(te.payload::jsonb #>> '{usageSignals,outputTokens}' AS numeric)) AS bigint), 0) AS total_output,
           CASE WHEN EXISTS(SELECT 1 FROM task_durable_transcripts dt WHERE dt.task_id = t.id)
                  OR EXISTS(SELECT 1 FROM task_transcripts tt WHERE tt.task_id = t.id LIMIT 1)
                THEN 1 ELSE 0 END AS has_transcript
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

// ─────────────────────────────────────────────────────────────────────────────
// Session-scoped arc loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One workflow_step_runs record for a task in the session.
 * Provides per-step retry counts, durations, and error summaries for
 * harness step-fitness analysis.
 */
export interface SessionStepRun {
  taskId: string
  stepName: string
  status: string
  /** Number of attempts (>1 indicates retried steps). */
  attempt: number
  startedAtMs: number
  finishedAtMs: number | null
  /** Wall-clock duration in ms; null when step is still running. */
  durationMs: number | null
  /** Orchestrator-level error message when the step failed. */
  errorSummary: string | null
  /** Human-readable outcome summary. */
  summary: string | null
}

/**
 * All arcs that originated from a single Foreground operator session,
 * together with workflow step records for harness step-fitness analysis.
 */
export interface SessionArcsResult {
  sessionId: string
  originIds: string[]
  arcs: DeepReflectArc[]
  /** workflow_step_runs rows for every task in the session. May be empty on
   * pre-migration DBs where the table does not yet exist. */
  stepRuns: SessionStepRun[]
}

/** UUID v4 pattern — session IDs are RFC-4122 UUIDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve a Foreground session UUID from an input that may be:
 * - A UUID  → returned as-is.
 * - A task or origin ID → look up `origin_session_id` from the tasks table.
 *
 * Returns null when no session ID can be resolved (unknown task, missing
 * column, or task enqueued outside a Claude Code session).
 */
export const resolveSessionId = async (input: string): Promise<string | null> => {
  if (UUID_RE.test(input)) return input
  const store = await getDefaultTaskStore()
  try {
    const r = await store.query({
      sql: `SELECT origin_session_id
              FROM tasks
             WHERE COALESCE(origin_id, id) = ? OR id = ?
             ORDER BY created_at ASC
             LIMIT 1`,
      args: [input, input],
    })
    if (r.rows.length === 0) return null
    const row = r.rows[0] as unknown as { origin_session_id: string | null }
    return row.origin_session_id ?? null
  } catch {
    return null
  }
}

/**
 * Load all arcs that originated from a Foreground session, together with
 * workflow_step_runs data for harness step-fitness analysis.
 *
 * Returns null when no tasks are found (genuinely empty result).
 * Throws when the underlying store query fails — a failed query and an empty
 * result are distinct outcomes and must not produce the same message.
 */
export const loadSessionArcs = async (
  sessionId: string,
  opts: { homeDir?: string; repoRoot?: string } = {},
): Promise<SessionArcsResult | null> => {
  const store = await getDefaultTaskStore()

  // Find all distinct arc origin IDs for this session, ordered by creation
  // time of the first task in each arc.
  //
  // NOTE: SELECT DISTINCT … ORDER BY <non-selected-col> is rejected by
  // PostgreSQL. Use GROUP BY + MIN aggregation instead — semantically
  // equivalent and Postgres-portable. No try/catch: a SQL failure must
  // propagate so the caller can surface it distinctly from "no tasks found".
  const r = await store.query({
    sql: `SELECT COALESCE(origin_id, id) AS origin_id, MIN(created_at) AS first_created
            FROM tasks
           WHERE origin_session_id = ?
           GROUP BY COALESCE(origin_id, id)
           ORDER BY first_created ASC`,
    args: [sessionId],
  })
  const originIds = r.rows.map((row) => (row as unknown as { origin_id: string }).origin_id)

  if (originIds.length === 0) return null

  // Load each arc (reuses the full arc loader including step timeline, transcripts, etc.)
  const arcs: DeepReflectArc[] = []
  for (const originId of originIds) {
    const arc = await loadDeepReflectArc(originId, opts)
    if (arc) arcs.push(arc)
  }

  if (arcs.length === 0) return null

  // Collect all task IDs across arcs for the workflow_step_runs query.
  const allTaskIds = arcs.flatMap((arc) => arc.tasks.map((t) => t.taskId))

  // Fetch workflow_step_runs for step-fitness analysis.
  const stepRuns: SessionStepRun[] = []
  if (allTaskIds.length > 0) {
    try {
      const placeholders = allTaskIds.map(() => '?').join(', ')
      const r = await store.query({
        sql: `SELECT run_id, step_name, status, attempt, started_at, finished_at, error_summary, summary
                FROM workflow_step_runs
               WHERE run_id IN (${placeholders})
               ORDER BY started_at ASC`,
        args: allTaskIds,
      })
      for (const row of r.rows) {
        const r0 = row as unknown as {
          run_id: string
          step_name: string
          status: string
          attempt: number
          started_at: number
          finished_at: number | null
          error_summary: string | null
          summary: string | null
        }
        const startedAtMs = Number(r0.started_at)
        const finishedAtMs = r0.finished_at !== null ? Number(r0.finished_at) : null
        stepRuns.push({
          taskId: r0.run_id,
          stepName: r0.step_name,
          status: r0.status,
          attempt: Number(r0.attempt ?? 1),
          startedAtMs,
          finishedAtMs,
          durationMs: finishedAtMs !== null ? finishedAtMs - startedAtMs : null,
          errorSummary: r0.error_summary ?? null,
          summary: r0.summary ?? null,
        })
      }
    } catch {
      // workflow_step_runs table may not exist on pre-migration DBs — proceed without it.
    }
  }

  return { sessionId, originIds, arcs, stepRuns }
}

// ── Skill-forge feed ──────────────────────────────────────────────────────────

/**
 * A single saved verdict row from a completed arc deep-reflection report.
 * Mirrors {@link import('./skill-forge-detector').DeepReflectRow} so callers
 * can pass the result directly to `detectCrossArcLessons`.
 */
export interface DeepReflectRow {
  originId: string
  title: string
  rootCauseKey: string
  summary: string
}

/**
 * Scan the on-disk arc reflection reports and return every saved suggestion
 * as a flat {@link DeepReflectRow} list.
 *
 * Reports live at `<stateDir>/deep-reflections/arc-*.json`.  Only files whose
 * `status === 'complete'` are read; partial/failed reports are skipped.  Only
 * suggestions whose `verdict === 'save'` contribute rows — absorbed and dropped
 * verdicts carry no persistent lesson value for the skill-forge pipeline.
 *
 * @param opts.limit - Maximum number of report files to read (most-recent first,
 *   by ISO-stamp filename sort). Defaults to 100.
 */
export async function loadRecentDeepReflectRows(opts?: {
  limit?: number
}): Promise<DeepReflectRow[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const { resolve: resolvePath } = await import('node:path')

  const dir = resolvePath(getStateDir(), 'deep-reflections')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // Directory absent → no reports yet.
    return []
  }

  const arcFiles = entries
    .filter((f) => f.startsWith('arc-') && f.endsWith('.json'))
    .sort()
    .reverse() // most-recent first (ISO stamp in filename)

  const limit = opts?.limit ?? 100
  const toRead = arcFiles.slice(0, limit)

  const rows: DeepReflectRow[] = []
  for (const file of toRead) {
    try {
      const raw = await readFile(resolvePath(dir, file), 'utf8')
      const data = JSON.parse(raw) as {
        originId?: string
        status?: string
        report?: {
          suggestions?: Array<{
            title?: string
            rootCauseKey?: string
            rationale?: string
            verdict?: string
          }>
        }
      }
      if (data.status !== 'complete' || !data.originId || !data.report?.suggestions) continue
      for (const s of data.report.suggestions) {
        if (
          s.verdict === 'save' &&
          typeof s.title === 'string' &&
          typeof s.rootCauseKey === 'string' &&
          typeof s.rationale === 'string'
        ) {
          rows.push({
            originId: data.originId,
            title: s.title,
            rootCauseKey: s.rootCauseKey,
            summary: s.rationale,
          })
        }
      }
    } catch {
      // Malformed or truncated file — skip silently.
    }
  }
  return rows
}
