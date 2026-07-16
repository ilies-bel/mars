/**
 * Scorer results — the RUN half of the per-Workflow quality evaluator
 * (PRD 6cf85bc9, consuming the accepted-Scorer records from 6988ed3b).
 *
 * One row per (Scorer, Workflow instance): the normalized 0..1 score plus the
 * judge's one-line rationale. Deliberately NOT a column on the per-step
 * records (a score is per-INSTANCE, not per-step, and step rows stay lean)
 * and NOT inlined into trace payloads (hot aggregate queries scan payloads);
 * the daemon emits a lightweight `scorer_result` trace event that references
 * the row instead.
 *
 * A Scorer is a record-only quality signal, never a merge gate: nothing in
 * this module (or its callers) can change a task's status or spawn recovery.
 * A failed scoring run lands as an `error` row (score NULL, rationale =
 * failure message) and stops — level-triggered, no retry.
 *
 * Storage: `scorer_results` in `.mars/mars.db` via the same state-client seam
 * as `scorers` (ADR-0034). The UNIQUE(scorer_id, task_id) index makes result
 * recording idempotent per instance — a duplicate `task.completed` delivery
 * can never double-score.
 */

import { type Client } from '@libsql/client'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { resolveStateClient } from './store/state-client'

/** Terminal status of one scoring run. */
export const ScorerResultStatusSchema = z.enum(['scored', 'error'])
export type ScorerResultStatus = z.infer<typeof ScorerResultStatusSchema>

/**
 * The Scorer Worker's output contract, enforced at parse time: a continuous
 * normalized score in 0..1 plus a mandatory one-line rationale (mirrors
 * `SCORER_OUTPUT_CONTRACT` in scorers.ts).
 */
export const ScorerVerdictSchema = z.object({
  score: z.number().min(0).max(1),
  rationale: z.string().min(1).max(1000),
})
export type ScorerVerdict = z.infer<typeof ScorerVerdictSchema>

/** Full persisted row. `parse`d on every read path. */
export const ScorerResultSchema = z.object({
  id: z.string().min(1),
  /** The accepted Scorer that produced this result. */
  scorerId: z.string().min(1),
  /** The graded Workflow instance (task id). */
  taskId: z.string().min(1),
  /** The instance's effective workflow kind at scoring time. */
  workflow: z.string().min(1),
  /** Normalized 0..1 score; null on `error` rows. */
  score: z.number().min(0).max(1).nullable(),
  /** One-line rationale on `scored` rows; the failure message on `error` rows. */
  rationale: z.string(),
  status: ScorerResultStatusSchema,
  createdAt: z.number(),
  /**
   * The workflow-config version that was active (trial preferred, then
   * promoted/baseline) when this result was recorded. Null when no versions
   * exist yet, preserving backwards-compatibility with legacy calls.
   */
  workflowConfigVersionId: z.string().nullable(),
})
export type ScorerResult = z.infer<typeof ScorerResultSchema>

export interface RecordScorerResultInput {
  scorerId: string
  taskId: string
  workflow: string
  score: number | null
  rationale: string
  status: ScorerResultStatus
  /** Workflow-config version id to attach to this result; null when none exists. */
  workflowConfigVersionId?: string | null
}

export interface ListScorerResultsFilter {
  scorerId?: string
  taskId?: string
  workflow?: string
  /** Restrict to a status; omit for both `scored` and `error` rows. */
  status?: ScorerResultStatus
  /** Newest-first row cap. Default 50. */
  limit?: number
}

/**
 * Per-workflow score trend over a trailing window — always median + p90,
 * never a bare mean (ADR-0038's distribution discipline). Computed over
 * `scored` rows only; `error` rows are excluded from the distribution but
 * reported via `errorCount` so a silently failing judge stays visible.
 */
export interface ScorerTrend {
  workflow: string
  /** Number of scored rows the distribution was computed over (≤ window). */
  sampleCount: number
  /** Number of error rows inside the same trailing window. */
  errorCount: number
  median: number | null
  p90: number | null
  /** Most recent score in the window, newest row first. Null when empty. */
  latest: number | null
}

const stateClient = (): Client => resolveStateClient()

let initialised = false

export const initScorerResults = async (): Promise<void> => {
  if (initialised) return
  const c = stateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS scorer_results (
      id TEXT PRIMARY KEY,
      scorer_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workflow TEXT NOT NULL,
      score REAL,
      rationale TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scored' CHECK(status IN ('scored','error')),
      created_at INTEGER NOT NULL,
      workflow_config_version_id TEXT
    )
  `)
  // Migrate existing databases: add workflow_config_version_id if missing.
  const cols = await c.execute(`PRAGMA table_info(scorer_results)`)
  const colNames = new Set(
    cols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!colNames.has('workflow_config_version_id')) {
    await c.execute(
      `ALTER TABLE scorer_results ADD COLUMN workflow_config_version_id TEXT`,
    )
  }
  // Idempotency guard: one result per (Scorer, instance). recordScorerResult
  // uses INSERT OR IGNORE against this index.
  await c.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_scorer_results_scorer_task
       ON scorer_results(scorer_id, task_id)`,
  )
  // Trend queries scan per workflow, newest first.
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_scorer_results_workflow
       ON scorer_results(workflow, created_at)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_scorer_results_task
       ON scorer_results(task_id)`,
  )
  // Per-version rolling score queries: group by workflow config version.
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_scorer_results_workflow_config_version
       ON scorer_results(workflow, workflow_config_version_id)`,
  )
  initialised = true
}

/** Test-only: forget the init latch so a fresh temp DB re-runs the DDL. */
export const __resetScorerResultsForTests = (): void => {
  initialised = false
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

const rowToResult = (row: Record<string, unknown>): ScorerResult =>
  ScorerResultSchema.parse({
    id: row.id,
    scorerId: row.scorer_id,
    taskId: row.task_id,
    workflow: row.workflow,
    score: row.score === null || row.score === undefined ? null : clamp01(Number(row.score)),
    rationale: typeof row.rationale === 'string' ? row.rationale : '',
    status: row.status,
    createdAt: Number(row.created_at ?? 0),
    workflowConfigVersionId:
      typeof row.workflow_config_version_id === 'string'
        ? row.workflow_config_version_id
        : null,
  })

export const generateScorerResultId = (): string =>
  `sr-${randomBytes(6).toString('hex')}`

/**
 * Persist one scoring run outcome. Idempotent per (scorerId, taskId): a
 * second call for the same pair is a no-op that returns the existing row —
 * v1 runs each accepted Scorer exactly once per instance, and a duplicate
 * `task.completed` delivery must not double-score.
 */
export const recordScorerResult = async (
  input: RecordScorerResultInput,
): Promise<{ result: ScorerResult; inserted: boolean }> => {
  await initScorerResults()
  const c = stateClient()
  const now = Date.now()
  const id = generateScorerResultId()
  const candidate: ScorerResult = ScorerResultSchema.parse({
    id,
    scorerId: input.scorerId,
    taskId: input.taskId,
    workflow: input.workflow,
    score: input.score === null ? null : clamp01(input.score),
    rationale: input.rationale,
    status: input.status,
    createdAt: now,
    workflowConfigVersionId: input.workflowConfigVersionId ?? null,
  })
  const r = await c.execute({
    sql: `INSERT OR IGNORE INTO scorer_results
            (id, scorer_id, task_id, workflow, score, rationale, status, created_at,
             workflow_config_version_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      candidate.id,
      candidate.scorerId,
      candidate.taskId,
      candidate.workflow,
      candidate.score,
      candidate.rationale,
      candidate.status,
      candidate.createdAt,
      candidate.workflowConfigVersionId,
    ],
  })
  if (r.rowsAffected > 0) return { result: candidate, inserted: true }
  const existing = await getScorerResult(input.scorerId, input.taskId)
  if (!existing) {
    throw new Error(
      `scorer_results insert for (${input.scorerId}, ${input.taskId}) was ignored but no existing row found`,
    )
  }
  return { result: existing, inserted: false }
}

/** Fetch the (unique) result row for one (Scorer, instance) pair. */
export const getScorerResult = async (
  scorerId: string,
  taskId: string,
): Promise<ScorerResult | null> => {
  await initScorerResults()
  const c = stateClient()
  const r = await c.execute({
    sql: `SELECT * FROM scorer_results WHERE scorer_id = ? AND task_id = ?`,
    args: [scorerId, taskId],
  })
  if (r.rows.length === 0) return null
  return rowToResult(r.rows[0] as unknown as Record<string, unknown>)
}

export const listScorerResults = async (
  filter?: ListScorerResultsFilter,
): Promise<ScorerResult[]> => {
  await initScorerResults()
  const c = stateClient()
  const where: string[] = []
  const args: Array<string | number> = []
  if (filter?.scorerId) {
    where.push('scorer_id = ?')
    args.push(filter.scorerId)
  }
  if (filter?.taskId) {
    where.push('task_id = ?')
    args.push(filter.taskId)
  }
  if (filter?.workflow) {
    where.push('workflow = ?')
    args.push(filter.workflow)
  }
  if (filter?.status) {
    where.push('status = ?')
    args.push(filter.status)
  }
  const limit = filter?.limit ?? 50
  const sql = `SELECT * FROM scorer_results${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at DESC, id DESC LIMIT ?`
  args.push(limit)
  const r = await c.execute({ sql, args })
  return r.rows.map((row) => rowToResult(row as unknown as Record<string, unknown>))
}

/** Distinct workflow kinds with at least one recorded result, newest first. */
export const listScoredWorkflows = async (): Promise<string[]> => {
  await initScorerResults()
  const c = stateClient()
  const r = await c.execute(
    `SELECT workflow, MAX(created_at) AS latest
       FROM scorer_results
      GROUP BY workflow
      ORDER BY latest DESC`,
  )
  return r.rows.map(
    (row) => (row as unknown as { workflow: string }).workflow,
  )
}

/** Median of a non-empty numeric array (interpolated for even lengths). */
export const medianOf = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** Nearest-rank p90 of a non-empty numeric array. */
export const p90Of = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(0.9 * sorted.length))
  return sorted[rank - 1]
}

/**
 * Compute the trailing-window score trend for one workflow kind: median +
 * p90 over the last `window` scored rows (default 20), plus the error-row
 * count within the same trailing window of runs.
 */
export const computeScorerTrend = async (
  workflow: string,
  window = 20,
): Promise<ScorerTrend> => {
  const recent = await listScorerResults({ workflow, limit: window })
  const scored = recent.filter(
    (r): r is ScorerResult & { score: number } =>
      r.status === 'scored' && r.score !== null,
  )
  const scores = scored.map((r) => r.score)
  return {
    workflow,
    sampleCount: scored.length,
    errorCount: recent.filter((r) => r.status === 'error').length,
    median: medianOf(scores),
    p90: p90Of(scores),
    latest: scored.length > 0 ? scored[0].score : null,
  }
}
