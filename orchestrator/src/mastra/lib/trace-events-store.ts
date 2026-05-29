import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { openLibsql } from './libsql'

/**
 * The single Mars trace-event surface. Collapses the former DuckDB
 * `mars_trace_events` table and SQLite `step_spans` table into one
 * append-only event log living alongside the rest of `.mars/mars.db`.
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
] as const

export type TraceEventKind = (typeof TRACE_EVENT_KINDS)[number]

export type TraceEventSeverity = 'info' | 'warn' | 'error'

export type TraceEventPhase = 'setup' | 'code' | 'verify' | 'merge'

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
  /** ISO-8601 timestamp. */
  timestamp: string
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
  sinceIso?: string
  untilIso?: string
  /**
   * Substring match against the serialized payload JSON. SQLite `LIKE`
   * with `%q%` wrappers; case-insensitive (the LIKE collation is the
   * default — NOCASE on ASCII only). Empty/undefined → no filter.
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
}

/**
 * Map `(kind, payload)` to a severity level. Single source of truth.
 *
 * - `task_blocked`, `recovery_spawned` → `warn`
 * - `task_failed`, `step_ended` with `payload.outcome === 'failure'` → `error`
 * - `tool_invoked` with `payload.exitCode === 0` → `info`
 * - `tool_invoked` with non-zero exit AND `payload.expectsFailure === true` → `warn`
 * - `tool_invoked` with non-zero exit AND falsy `expectsFailure` → `error`
 * - everything else → `info`
 */
export const deriveSeverity = (
  kind: TraceEventKind,
  payload: Record<string, unknown>,
): TraceEventSeverity => {
  if (kind === 'task_failed') return 'error'
  if (kind === 'step_ended' && payload.outcome === 'failure') return 'error'
  if (kind === 'task_blocked' || kind === 'recovery_spawned') return 'warn'
  if (kind === 'tool_invoked') {
    const exitCode = payload.exitCode
    if (typeof exitCode === 'number' && exitCode === 0) return 'info'
    if (payload.expectsFailure === true) return 'warn'
    return 'error'
  }
  return 'info'
}

const TRACE_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS trace_events (
  id        TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  kind      TEXT NOT NULL,
  severity  TEXT NOT NULL DEFAULT 'info',
  task_id   TEXT,
  origin_id TEXT,
  phase     TEXT,
  payload   TEXT NOT NULL DEFAULT '{}'
)
`

const INDEX_TASK_TIME = `
CREATE INDEX IF NOT EXISTS idx_trace_events_task_time
  ON trace_events (task_id, timestamp)
`

const INDEX_TIME_DESC = `
CREATE INDEX IF NOT EXISTS idx_trace_events_time_desc
  ON trace_events (timestamp DESC)
`

const INDEX_ORIGIN_TIME = `
CREATE INDEX IF NOT EXISTS idx_trace_events_origin_time
  ON trace_events (origin_id, timestamp)
`

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
    timestamp: row.timestamp as string,
    kind,
    severity,
    taskId: (row.task_id as string | null) ?? null,
    originId: (row.origin_id as string | null) ?? null,
    phase,
    payload: parsePayload(row.payload as string | null),
  }
}

interface CursorPayload {
  ts: string
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
      typeof (parsed as { ts: unknown }).ts === 'string' &&
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
 * Open (creating it if absent) the Mars trace-event store backed by the
 * SQLite file at `dbPath`, ensuring the schema and indexes exist. The
 * caller owns the returned handle.
 *
 * Passing the same `dbPath` that `state.db` uses co-locates trace events
 * alongside inbox and proposal data in a single file (see ADR-0034).
 */
export const openTraceEventStore = async (
  dbPath: string,
): Promise<TraceEventStore> => {
  const client = openLibsql({ url: `file:${dbPath}` })
  await client.execute(TRACE_EVENTS_DDL)
  await client.execute(INDEX_TASK_TIME)
  await client.execute(INDEX_TIME_DESC)
  await client.execute(INDEX_ORIGIN_TIME)

  return {
    record: async (event: TraceEventInput): Promise<void> => {
      const payload = event.payload ?? {}
      const severity = deriveSeverity(event.kind, payload)
      await client.execute({
        sql: `INSERT INTO trace_events
              (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          new Date().toISOString(),
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
      if (filter.sinceIso !== undefined) {
        where.push('timestamp >= ?')
        args.push(filter.sinceIso)
      }
      if (filter.untilIso !== undefined) {
        where.push('timestamp <= ?')
        args.push(filter.untilIso)
      }
      if (filter.q !== undefined && filter.q !== '') {
        // SQLite LIKE is case-insensitive on ASCII by default. We wrap with
        // `%` so any substring inside the JSON-serialized payload matches.
        where.push('payload LIKE ?')
        args.push(`%${filter.q}%`)
      }

      // Cursor-based pagination: rows are ordered (timestamp DESC, id DESC).
      // The cursor pins the last (ts, id) seen; the next page starts strictly
      // before it in that ordering. `id` is a uuid so it tie-breaks equal
      // timestamps deterministically — the SQLite default text comparison is
      // enough.
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
      client.close()
    },
  }
}

/** Build a cursor pointing at the last event in a page so the next call resumes after it. */
export const cursorAfter = (event: TraceEvent): string =>
  encodeCursor({ ts: event.timestamp, id: event.id })
