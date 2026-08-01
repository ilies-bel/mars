import { randomUUID } from 'node:crypto'
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { z } from 'zod'
import { openDb } from './db.js'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/**
 * The single Mars trace-event surface. All step telemetry lives in the
 * `trace_events` table as an append-only event log alongside the rest of
 * the Mars database. Schema ownership: `trace_events`, `task_transcripts`
 * and `task_durable_transcripts` (plus their indexes) are created by
 * `ensureSchema` in core/lib/pg-schema.ts (migration 0002) — this module
 * carries no DDL.
 *
 * Every row is one event, tagged by `kind` from a closed vocabulary. The
 * kind-specific shape lives in `payload` as JSON. Callers never pick
 * severity — `deriveSeverity` is the single source of truth so a given
 * (kind, payload) always maps to the same level.
 *
 * Adding a new kind: extend `TRACE_EVENT_KINDS`, then add the
 * derivation rule in `deriveSeverity` if it is not `info`.
 */

/** Closed enum. New kinds land here and nowhere else. */
export const TRACE_EVENT_KINDS = [
  'origin_created',
  'step_started',
  'step_ended',
  'task_blocked',
  'recovery_spawned',
  'task_failed',
  'tool_invoked',
  'log_line',
  'worker-model-mismatch',
  'post-coder-commit',
  'cli-invocation',
  'scorer_result',
] as const

export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number]

export type TraceEventSeverity = 'info' | 'warn' | 'error'

export type TraceEventPhase = 'setup' | 'code' | 'verify' | 'merge' | 'reflect'

const TRACE_EVENT_KIND_SET: ReadonlySet<string> = new Set(TRACE_EVENT_KINDS)
const TRACE_EVENT_PHASES: readonly TraceEventPhase[] = [
  'setup',
  'code',
  'verify',
  'merge',
] as const
const TRACE_EVENT_PHASE_SET: ReadonlySet<string> = new Set(TRACE_EVENT_PHASES)

/** Row shape returned by `query`. */
export interface TraceEvent {
  id: string
  /** Epoch-millisecond timestamp. */
  timestamp: number
  kind: TraceEventKind
  severity: TraceEventSeverity
  taskId: string | null
  originId: string | null
  phase: TraceEventPhase | null
  payload: Record<string, unknown>
}

/** Input shape for `record`. Severity is derived, not supplied. */
export interface TraceEventInput {
  kind: TraceEventKind
  taskId?: string | null
  originId?: string | null
  phase?: TraceEventPhase | null
  payload?: Record<string, unknown>
}

export interface TraceEventFilter {
  taskId?: string
  originId?: string
  kind?: readonly TraceEventKind[]
  severity?: readonly TraceEventSeverity[]
  phase?: readonly TraceEventPhase[]
  sinceMs?: number
  untilMs?: number
  /**
   * Substring match against the serialized payload JSON. `ILIKE` with
   * `%q%` wrappers — case-insensitive, preserving the old SQLite LIKE
   * (NOCASE-on-ASCII) behaviour. Empty/undefined → no filter.
   */
  q?: string
  /** Opaque cursor returned by a previous `query`. Newest-first ordering. */
  cursor?: string
  /** Max rows to return. Defaults to 100. */
  limit?: number
}

export interface TraceEventStore {
  record: (event: TraceEventInput) => Promise<void>
  query: (filter: TraceEventFilter) => Promise<TraceEvent[]>
  close: () => Promise<void>

  /**
   * Append a batch of streaming transcript events for durable incremental
   * storage. Called from `runWorkerWithSpan` as events stream — every
   * TRANSCRIPT_CHUNK_BATCH events flush a row so a watchdog-killed or crashed
   * session's partial transcript is readable before `step_ended` is written.
   *
   * `seq` is a monotonically increasing counter per `(taskId, sessionId)` pair;
   * callers increment it after each flush. Rows are keyed by `(taskId,
   * sessionId, seq)` so multiple sessions for the same task (e.g. origin + one
   * recovery) are stored without collision.
   *
   * Optional — implementations that do not support transcript streaming
   * (e.g. `nullTraceStore`) simply omit this method; callers use optional
   * chaining (`store.appendTranscriptChunk?.(...)`).
   */
  appendTranscriptChunk?: (
    taskId: string,
    sessionId: string,
    seq: number,
    events: readonly unknown[],
  ) => Promise<void>

  /**
   * Read all streaming transcript events for `taskId` in chronological order
   * (by `session_id ASC, seq ASC`). Returns the flat list of raw event objects
   * across all chunk rows; callers apply their own type coercion.
   *
   * When `sessionId` is supplied, only rows for that session are returned.
   *
   * Optional — omitted on stores that do not support transcript streaming;
   * callers fall back to the `step_ended` payload path.
   */
  readTranscriptChunks?: (taskId: string, sessionId?: string) => Promise<unknown[]>

  /**
   * Delete transcript chunk rows whose write timestamp is older than
   * `beforeMs` (epoch milliseconds). Returns the count of deleted rows.
   *
   * Intended for the same periodic-prune job that trims `trace_events`.
   * Retention constant: {@link TRANSCRIPT_RETENTION_DAYS}.
   */
  pruneTranscripts?: (beforeMs: number) => Promise<number>

  /**
   * Store the full conversation transcript for a task as a gzip-compressed
   * bytea in `task_durable_transcripts`. Uses an upsert (ON CONFLICT DO
   * UPDATE) so calling again for the same taskId updates the row with the
   * latest conversation.
   *
   * Prefer this over embedding the transcript string in `step_ended` payloads —
   * payloads are scanned by hot aggregate queries and must remain small.
   *
   * Optional — implementations that do not support durable transcripts
   * (e.g. `nullTraceStore`) simply omit this method; callers use optional
   * chaining (`store.appendDurableTranscript?.(...)`).
   */
  appendDurableTranscript?: (
    taskId: string,
    sessionId: string,
    stepName: string,
    transcriptJson: string,
  ) => Promise<void>

  /**
   * Read and decompress the durable transcript for a task from
   * `task_durable_transcripts`. Returns the raw JSON string on success,
   * `null` when no row exists or decompression fails.
   *
   * Optional — omitted on stores that do not support durable transcripts;
   * callers fall back to the streaming chunks path or on-disk JSONL.
   */
  readDurableTranscript?: (taskId: string) => Promise<string | null>

  /**
   * One-time migration: find all `step_ended` rows whose payload embeds an
   * inline `transcript` string, write them compressed to
   * `task_durable_transcripts` (ON CONFLICT DO NOTHING — does not overwrite
   * an existing row), and rewrite the payload with a `transcriptRef` marker
   * (byte length only) in place of the raw string.
   *
   * Idempotent — safe to call on every startup; after migration all matching
   * rows have been rewritten so subsequent calls are fast no-ops.
   * Returns the count of rows migrated.
   *
   * Optional — omitted on stores that do not support durable transcripts.
   */
  backfillInlineTranscripts?: () => Promise<number>
}

/**
 * Map `(kind, payload)` to a severity level. Single source of truth.
 *
 * - `task_blocked`, `recovery_spawned` → `warn`
 * - `task_failed`, `step_ended` with `payload.outcome === 'failed'` → `error`
 * - `step_ended` with `payload.outcome === 'killed'` → `warn`
 *   (watchdog-killed runs are problems but not hard failures)
 * - `tool_invoked` with `payload.exitCode === 0` → `info`
 * - `tool_invoked` with non-zero exit AND `payload.expectsFailure === true` → `info`
 *   (probe designed to exit nonzero — e.g. branch-existence check — not a failure)
 * - `tool_invoked` with non-zero exit AND falsy `expectsFailure` → `warn`
 *   (unexpected nonzero exit; `error` is reserved for task-level failures)
 * - `log_line` → reads `payload.level` ('info'|'warn'|'error'); falls back to 'info'
 * - `worker-model-mismatch` → `warn` (the subprocess is running a different model
 *   than the Worker pin; budget drift risk, needs investigation)
 * - everything else → `info`
 *
 * `log_line` payload shape:
 *   { level: 'info'|'warn'|'error', msg: string, source: string
 *     (e.g. 'workflow'|'daemon'|'bus'|'sweeper'), fields?: Record<string,unknown> }
 * taskId/originId/phase stay on the TraceEventInput envelope (may be null for
 * daemon-global lines).
 */
export const deriveSeverity = (
  kind: TraceEventKind,
  payload: Record<string, unknown>,
): TraceEventSeverity => {
  if (kind === 'task_failed') return 'error'
  if (kind === 'step_ended' && payload.outcome === 'failed') return 'error'
  if (kind === 'step_ended' && payload.outcome === 'killed') return 'warn'
  if (kind === 'task_blocked' || kind === 'recovery_spawned') return 'warn'
  if (kind === 'tool_invoked') {
    const exitCode = payload.exitCode
    if (typeof exitCode === 'number' && exitCode === 0) return 'info'
    if (payload.expectsFailure === true) return 'info'
    return 'warn'
  }
  if (kind === 'log_line') {
    const level = payload.level
    if (level === 'warn' || level === 'error') return level
    return 'info'
  }
  if (kind === 'worker-model-mismatch') return 'warn'
  return 'info'
}

/**
 * Number of days to retain `task_transcripts` rows before they are eligible
 * for pruning. Pass this to `pruneTranscripts` at periodic cleanup time.
 */
export const TRANSCRIPT_RETENTION_DAYS = 30

/**
 * How many streaming events to batch before flushing a `task_transcripts` row.
 * Smaller values increase durability for killed sessions at the cost of more
 * DB writes; larger values reduce write frequency but risk losing more on kill.
 * 20 events ≈ 1-5 KB per row — a comfortable row size.
 */
export const TRANSCRIPT_CHUNK_BATCH = 20

// Zod schema for parsing the JSON-blob payload at read time. JSON.parse
// alone can return anything — narrow it to a string-keyed object so the
// public `TraceEvent['payload']` type holds.
const payloadSchema = z.record(z.string(), z.unknown())

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    const result = payloadSchema.safeParse(parsed)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}

const isTraceEventKind = (value: unknown): value is TraceEventKind =>
  typeof value === 'string' && TRACE_EVENT_KIND_SET.has(value)

const isPhase = (value: unknown): value is TraceEventPhase =>
  typeof value === 'string' && TRACE_EVENT_PHASE_SET.has(value)

const isSeverity = (value: unknown): value is TraceEventSeverity =>
  value === 'info' || value === 'warn' || value === 'error'

const rowToEvent = (row: Record<string, unknown>): TraceEvent => {
  const kind = row.kind
  if (!isTraceEventKind(kind)) {
    // A row carrying an unknown kind shouldn't exist (the writer enforces
    // the enum) but if it ever does we'd rather surface it than crash.
    throw new Error(`trace_events: unknown kind ${String(kind)}`)
  }
  const severity = row.severity
  if (!isSeverity(severity)) {
    throw new Error(`trace_events: unknown severity ${String(severity)}`)
  }
  const phaseRaw = row.phase
  const phase: TraceEventPhase | null =
    phaseRaw === null || phaseRaw === undefined
      ? null
      : isPhase(phaseRaw)
        ? phaseRaw
        : null
  return {
    id: row.id as string,
    timestamp: Number(row.timestamp),
    kind,
    severity,
    taskId: (row.task_id as string | null) ?? null,
    originId: (row.origin_id as string | null) ?? null,
    phase,
    payload: parsePayload(row.payload as string | null),
  }
}

interface CursorPayload {
  ts: number
  id: string
}

const encodeCursor = (cursor: CursorPayload): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

const decodeCursor = (cursor: string): CursorPayload | null => {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'ts' in parsed &&
      'id' in parsed &&
      typeof (parsed as { ts: unknown }).ts === 'number' &&
      typeof (parsed as { id: unknown }).id === 'string'
    ) {
      return { ts: (parsed as CursorPayload).ts, id: (parsed as CursorPayload).id }
    }
    return null
  } catch {
    return null
  }
}

const DEFAULT_LIMIT = 100

/**
 * Open the Mars trace-event store on the database identified by `dbTarget`
 * (a `postgres://` DSN from `.mars/pg.dsn`, or the identity key under the
 * PGlite test backend). The schema is owned by `ensureSchema`
 * (pg-schema.ts) and must have been applied by the init/daemon flow; this
 * function performs no DDL. The caller owns the returned handle —
 * `close()` releases the (reference-counted) shared client.
 *
 * The daemon opens one persistent instance at startup (open early / close
 * late); short-lived CLI invocations open per call — `openDb` dedupes onto
 * the same pool either way.
 */
export const openTraceEventStore = async (
  dbTarget: string,
): Promise<TraceEventStore> => {
  const client = openDb(dbTarget)

  return {
    record: async (event: TraceEventInput): Promise<void> => {
      const payload = event.payload ?? {}
      const severity = deriveSeverity(event.kind, payload)
      // Info-level log_line rows are not persisted: they duplicate watch.log
      // and dominated trace_events volume (≈163 k rows / 14 h in production).
      // warn/error log_lines are kept (with a tighter 2-day age cap in prune).
      if (event.kind === 'log_line' && severity === 'info') return
      await client.execute({
        sql: `INSERT INTO trace_events
              (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          Date.now(),
          event.kind,
          severity,
          event.taskId ?? null,
          event.originId ?? null,
          event.phase ?? null,
          JSON.stringify(payload),
        ],
      })
    },

    query: async (filter: TraceEventFilter): Promise<TraceEvent[]> => {
      const where: string[] = []
      const args: (string | number)[] = []

      if (filter.taskId !== undefined) {
        where.push('task_id = ?')
        args.push(filter.taskId)
      }
      if (filter.originId !== undefined) {
        where.push('origin_id = ?')
        args.push(filter.originId)
      }
      if (filter.kind && filter.kind.length > 0) {
        where.push(`kind IN (${filter.kind.map(() => '?').join(', ')})`)
        args.push(...filter.kind)
      }
      if (filter.severity && filter.severity.length > 0) {
        where.push(`severity IN (${filter.severity.map(() => '?').join(', ')})`)
        args.push(...filter.severity)
      }
      if (filter.phase && filter.phase.length > 0) {
        where.push(`phase IN (${filter.phase.map(() => '?').join(', ')})`)
        args.push(...filter.phase)
      }
      if (filter.sinceMs !== undefined) {
        where.push('timestamp >= ?')
        args.push(filter.sinceMs)
      }
      if (filter.untilMs !== undefined) {
        where.push('timestamp <= ?')
        args.push(filter.untilMs)
      }
      if (filter.q !== undefined && filter.q !== '') {
        // ILIKE preserves the old SQLite LIKE case-insensitivity. We wrap
        // with `%` so any substring inside the JSON-serialized payload
        // matches.
        where.push('payload ILIKE ?')
        args.push(`%${filter.q}%`)
      }

      // Cursor-based pagination: rows are ordered (timestamp DESC, id DESC).
      // The cursor pins the last (ts, id) seen; the next page starts strictly
      // before it in that ordering. `id` is a uuid so it tie-breaks equal
      // timestamps deterministically — plain text comparison is enough.
      if (filter.cursor !== undefined) {
        const cur = decodeCursor(filter.cursor)
        if (cur !== null) {
          where.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
          args.push(cur.ts, cur.ts, cur.id)
        }
      }

      const limit = filter.limit ?? DEFAULT_LIMIT
      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      const result = await client.execute({
        sql: `SELECT id, timestamp, kind, severity, task_id, origin_id, phase, payload
              FROM trace_events
              ${whereClause}
              ORDER BY timestamp DESC, id DESC
              LIMIT ?`,
        args: [...args, limit],
      })
      return result.rows.map((row) =>
        rowToEvent(row as unknown as Record<string, unknown>),
      )
    },

    close: async (): Promise<void> => {
      await client.close()
    },

    appendTranscriptChunk: async (
      taskId: string,
      sessionId: string,
      seq: number,
      events: readonly unknown[],
    ): Promise<void> => {
      if (events.length === 0) return
      await client.execute({
        sql: `INSERT INTO task_transcripts
              (task_id, session_id, seq, chunk, ts)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (task_id, session_id, seq) DO NOTHING`,
        args: [
          taskId,
          sessionId,
          seq,
          JSON.stringify(events),
          Date.now(),
        ],
      })
    },

    readTranscriptChunks: async (
      taskId: string,
      sessionId?: string,
    ): Promise<unknown[]> => {
      const whereExtra = sessionId !== undefined ? ' AND session_id = ?' : ''
      const args: (string | number)[] = sessionId !== undefined
        ? [taskId, sessionId]
        : [taskId]
      const result = await client.execute({
        sql: `SELECT chunk FROM task_transcripts
              WHERE task_id = ?${whereExtra}
              ORDER BY session_id ASC, seq ASC`,
        args,
      })
      const events: unknown[] = []
      for (const row of result.rows) {
        const r = row as unknown as { chunk: string }
        try {
          const parsed = JSON.parse(r.chunk) as unknown
          if (Array.isArray(parsed)) {
            for (const evt of parsed) events.push(evt)
          }
        } catch {
          // skip malformed chunk rows
        }
      }
      return events
    },

    pruneTranscripts: async (beforeMs: number): Promise<number> => {
      const result = await client.execute({
        sql: `DELETE FROM task_transcripts WHERE ts < ?`,
        args: [beforeMs],
      })
      return result.rowsAffected ?? 0
    },

    appendDurableTranscript: async (
      taskId: string,
      sessionId: string,
      stepName: string,
      transcriptJson: string,
    ): Promise<void> => {
      const compressed = await gzipAsync(Buffer.from(transcriptJson, 'utf8'))
      await client.execute({
        sql: `INSERT INTO task_durable_transcripts
              (task_id, session_id, step_name, created_at, transcript, byte_len)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (task_id) DO UPDATE SET
                session_id = excluded.session_id,
                step_name  = excluded.step_name,
                created_at = excluded.created_at,
                transcript = excluded.transcript,
                byte_len   = excluded.byte_len`,
        args: [
          taskId,
          sessionId,
          stepName,
          Date.now(),
          compressed,
          transcriptJson.length,
        ],
      })
    },

    readDurableTranscript: async (taskId: string): Promise<string | null> => {
      const result = await client.execute({
        sql: `SELECT transcript FROM task_durable_transcripts WHERE task_id = ?`,
        args: [taskId],
      })
      if (result.rows.length === 0) return null
      const row = result.rows[0] as unknown as { transcript: Uint8Array | null }
      if (!row.transcript) return null
      try {
        const decompressed = await gunzipAsync(Buffer.from(row.transcript))
        return decompressed.toString('utf8')
      } catch {
        return null
      }
    },

    backfillInlineTranscripts: async (): Promise<number> => {
      // Find all step_ended rows whose payload embeds an inline transcript string.
      const rows = await client.execute(
        `SELECT id, task_id, payload FROM trace_events
          WHERE kind = 'step_ended'
            AND payload::jsonb ->> 'transcript' IS NOT NULL`,
      )
      let migrated = 0
      for (const row of rows.rows) {
        const r = row as unknown as { id: string; task_id: string | null; payload: string }
        if (!r.task_id) continue
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(r.payload) as Record<string, unknown>
        } catch {
          continue
        }
        const transcriptRaw = payload.transcript
        if (typeof transcriptRaw !== 'string' || transcriptRaw.length === 0) continue
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
        const stepName = typeof payload.stepName === 'string' ? payload.stepName : 'code'
        const byteLen = transcriptRaw.length
        // Write compressed transcript — ON CONFLICT DO NOTHING so a newer
        // durable row written by runWorkerWithSpan is left intact.
        const compressed = await gzipAsync(Buffer.from(transcriptRaw, 'utf8'))
        await client.execute({
          sql: `INSERT INTO task_durable_transcripts
                (task_id, session_id, step_name, created_at, transcript, byte_len)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (task_id) DO NOTHING`,
          args: [r.task_id, sessionId, stepName, Date.now(), compressed, byteLen],
        })
        // Rewrite the payload without the inline transcript; add a lightweight
        // transcriptRef marker so the row is self-describing.
        const { transcript: _removed, ...rest } = payload
        const updatedPayload: Record<string, unknown> = {
          ...rest,
          transcriptRef: { byteLen },
        }
        await client.execute({
          sql: `UPDATE trace_events SET payload = ? WHERE id = ?`,
          args: [JSON.stringify(updatedPayload), r.id],
        })
        migrated++
      }
      return migrated
    },
  }
}

/** Build a cursor pointing at the last event in a page so the next call resumes after it. */
export const cursorAfter = (event: TraceEvent): string =>
  encodeCursor({ ts: event.timestamp, id: event.id })

/**
 * Find every step_started event that has no corresponding step_ended with the
 * same workflowInstanceId + stepName and record a step_ended for each with
 * outcome=killed.
 *
 * Called at daemon startup (inside the reconcile seam) to close Step spans
 * that were left running by a prior daemon that crashed. A span that is
 * already closed (outcome completed / failed / killed) is left untouched.
 *
 * Returns the count of spans swept to killed.
 */
export const sweepOrphanRunningSpans = async (
  store: TraceEventStore,
): Promise<number> => {
  // A single reconcile pass — use a large limit since the event store should
  // never approach this cardinality at daemon-restart time.
  const RECONCILE_LIMIT = 100_000

  const [allStarted, allEnded] = await Promise.all([
    store.query({ kind: ['step_started'], limit: RECONCILE_LIMIT }),
    store.query({ kind: ['step_ended'], limit: RECONCILE_LIMIT }),
  ])

  // Build a set of (workflowInstanceId, stepName) pairs that are already closed.
  // The null byte separator avoids collisions between adjacent string values.
  const closedKeys = new Set<string>()
  for (const e of allEnded) {
    const wfId = e.payload.workflowInstanceId
    const stepName = e.payload.stepName
    if (typeof wfId === 'string' && typeof stepName === 'string') {
      closedKeys.add(`${wfId}\0${stepName}`)
    }
  }

  const orphans = allStarted.filter((e) => {
    const wfId = e.payload.workflowInstanceId
    const stepName = e.payload.stepName
    if (typeof wfId !== 'string' || typeof stepName !== 'string') return false
    return !closedKeys.has(`${wfId}\0${stepName}`)
  })

  await Promise.all(
    orphans.map((e) => {
      const wfId = e.payload.workflowInstanceId as string
      const stepName = e.payload.stepName as string
      const payload: Record<string, unknown> = {
        stepName,
        workflowInstanceId: wfId,
        outcome: 'killed',
        durationMs: -1,
      }
      if (typeof e.payload.workerName === 'string') {
        payload.workerName = e.payload.workerName
      }
      return store.record({
        kind: 'step_ended',
        taskId: e.taskId,
        originId: e.originId,
        phase: e.phase,
        payload,
      })
    }),
  )

  return orphans.length
}
