import { randomUUID } from 'node:crypto'
import { openLibsql } from './libsql'

/**
 * A single step span row.  Spans whose `outcome` is `null` represent
 * in-flight work; they are returned by `listSpans` alongside completed ones.
 */
export interface StepSpan {
  id: string
  stepName: string
  workflowInstanceId: string
  originId: string
  /** ISO-8601 timestamp */
  startedAt: string
  /** ISO-8601 timestamp, or `null` while the span is still open. */
  endedAt: string | null
  /** `null` while the span is still open. */
  outcome: string | null
  workerName: string | null
  sessionId: string | null
  transcript: string | null
  usageSignals: Record<string, unknown> | null
  verifyOutput: string | null
}

export interface OpenSpanParams {
  stepName: string
  workflowInstanceId: string
  originId: string
  /** Defaults to `new Date()` when omitted. */
  startedAt?: Date
  workerName?: string
  sessionId?: string
  /** Optional slot; can also be filled (or overwritten) via `closeSpan`. */
  verifyOutput?: string
}

export interface CloseSpanParams {
  outcome: string
  /** Defaults to `new Date()` when omitted. */
  endedAt?: Date
  /**
   * The Claude session id returned by the worker run. When provided it is
   * written into the `session_id` column; when omitted the open-time value
   * (if any) is preserved via `COALESCE`.
   */
  sessionId?: string
  transcript?: string
  usageSignals?: Record<string, unknown>
  /**
   * When provided, overwrites the value stored at open time.
   * When omitted, the open-time value is preserved.
   */
  verifyOutput?: string
}

/**
 * Public seam for the step_spans table.  The raw libsql `Client` never
 * crosses this interface — callers interact exclusively through the three
 * typed methods below.
 */
export interface StepSpanStore {
  /**
   * Open a new span for a workflow step.  Returns a span id the caller
   * must pass to `closeSpan` when the step finishes.
   *
   * Opening the same `stepName` + `workflowInstanceId` pair more than
   * once creates a new row each time rather than overwriting the previous
   * one — useful when a step is retried within the same workflow instance.
   */
  openSpan: (params: OpenSpanParams) => Promise<string>

  /**
   * Close a span by recording its outcome and end timestamp.  Only the
   * row identified by `id` is updated; all other rows are untouched.
   */
  closeSpan: (id: string, params: CloseSpanParams) => Promise<void>

  /**
   * Return every span whose `origin_id` matches `originId`, ordered by
   * `started_at` ascending.  In-flight spans (outcome = null) are included.
   */
  listSpans: (originId: string) => Promise<StepSpan[]>
}

const STEP_SPANS_DDL = `
CREATE TABLE IF NOT EXISTS step_spans (
  id                   TEXT PRIMARY KEY,
  step_name            TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  origin_id            TEXT NOT NULL,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  outcome              TEXT,
  worker_name          TEXT,
  session_id           TEXT,
  transcript           TEXT,
  usage_signals        TEXT,
  verify_output        TEXT
)
`

const parseUsageSignals = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

const rowToStepSpan = (row: Record<string, unknown>): StepSpan => ({
  id: row.id as string,
  stepName: row.step_name as string,
  workflowInstanceId: row.workflow_instance_id as string,
  originId: row.origin_id as string,
  startedAt: row.started_at as string,
  endedAt: (row.ended_at as string | null) ?? null,
  outcome: (row.outcome as string | null) ?? null,
  workerName: (row.worker_name as string | null) ?? null,
  sessionId: (row.session_id as string | null) ?? null,
  transcript: (row.transcript as string | null) ?? null,
  usageSignals: parseUsageSignals(row.usage_signals as string | null),
  verifyOutput: (row.verify_output as string | null) ?? null,
})

/**
 * Open (creating it if absent) the step-span store backed by the SQLite
 * file at `dbPath` and ensure its schema exists.  The caller owns the
 * returned `StepSpanStore` handle; the raw database client never leaves
 * this module.
 *
 * Passing the same `dbPath` that `state.db` uses co-locates step spans
 * alongside inbox and proposal data in a single file.
 */
export const openStepSpanStore = async (dbPath: string): Promise<StepSpanStore> => {
  const client = openLibsql({ url: `file:${dbPath}` })
  await client.execute(STEP_SPANS_DDL)
  await client.execute(`
    CREATE INDEX IF NOT EXISTS idx_step_spans_origin_started
      ON step_spans (origin_id, started_at)
  `)

  return {
    openSpan: async (params: OpenSpanParams): Promise<string> => {
      const id = randomUUID()
      const startedAt = (params.startedAt ?? new Date()).toISOString()
      await client.execute({
        sql: `INSERT INTO step_spans
              (id, step_name, workflow_instance_id, origin_id, started_at,
               worker_name, session_id, verify_output)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          params.stepName,
          params.workflowInstanceId,
          params.originId,
          startedAt,
          params.workerName ?? null,
          params.sessionId ?? null,
          params.verifyOutput ?? null,
        ],
      })
      return id
    },

    closeSpan: async (id: string, params: CloseSpanParams): Promise<void> => {
      const endedAt = (params.endedAt ?? new Date()).toISOString()
      await client.execute({
        sql: `UPDATE step_spans
              SET ended_at      = ?,
                  outcome       = ?,
                  session_id    = COALESCE(?, session_id),
                  transcript    = ?,
                  usage_signals = ?,
                  verify_output = COALESCE(?, verify_output)
              WHERE id = ?`,
        args: [
          endedAt,
          params.outcome,
          params.sessionId ?? null,
          params.transcript ?? null,
          params.usageSignals !== undefined
            ? JSON.stringify(params.usageSignals)
            : null,
          params.verifyOutput ?? null,
          id,
        ],
      })
    },

    listSpans: async (originId: string): Promise<StepSpan[]> => {
      const result = await client.execute({
        sql: `SELECT id, step_name, workflow_instance_id, origin_id,
                     started_at, ended_at, outcome, worker_name,
                     session_id, transcript, usage_signals, verify_output
              FROM step_spans
              WHERE origin_id = ?
              ORDER BY started_at ASC`,
        args: [originId],
      })
      return result.rows.map((row) =>
        rowToStepSpan(row as unknown as Record<string, unknown>),
      )
    },
  }
}
