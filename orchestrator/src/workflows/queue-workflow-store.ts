import type { Client } from '@libsql/client'
import type {
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  WorkflowStore,
} from '@mars/workflow'
import { getClient } from '../mastra/queue'

/**
 * `WorkflowStore` adapter over the orchestrator's `.mars/queue.db`.
 *
 * The @mars/workflow engine persists run + step lifecycle into two tables it
 * defines — `workflow_runs` and `workflow_step_runs`, keyed by
 * `(run_id, step_name)`. The reference `SqliteStore` (packages/workflow's
 * store-sqlite.ts) backs those tables with `node:sqlite`; here we mirror its
 * column/SQL shape exactly but route through the orchestrator's existing
 * libsql `Client` (same connection `queue.ts` uses), so the engine's
 * checkpoint-resume state lives alongside the task queue in one file.
 *
 * Resume is the whole point of co-locating with `.mars/queue.db`: the daemon
 * dispatches `runWorkflow(..., { runId: task.id })`, so a `mars continue`
 * re-dispatch of the same task id finds the prior run's `'completed'` step
 * records here and short-circuits them.
 */

// `CREATE TABLE IF NOT EXISTS` so the schema is materialised on first use and
// is a no-op thereafter. Mirrors store-sqlite.ts's DDL verbatim except for the
// libsql-friendly statement split (libsql `execute` takes one statement).
const RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id          TEXT PRIMARY KEY,
    workflow_id TEXT    NOT NULL,
    input_json  TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )
`

const STEP_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_step_runs (
    run_id         TEXT    NOT NULL,
    step_name      TEXT    NOT NULL,
    status         TEXT    NOT NULL,
    sha            TEXT,
    started_at     INTEGER NOT NULL,
    finished_at    INTEGER,
    attempt        INTEGER NOT NULL,
    summary        TEXT,
    error_summary  TEXT,
    transcript_key TEXT,
    result_json    TEXT,
    seq            INTEGER NOT NULL,
    PRIMARY KEY (run_id, step_name)
  )
`

// Row shapes as libsql returns them (snake_case columns).
interface RunRow {
  id: string
  workflow_id: string
  input_json: string
  status: string
  created_at: number
  updated_at: number
}

interface StepRow {
  run_id: string
  step_name: string
  status: string
  sha: string | null
  started_at: number
  finished_at: number | null
  attempt: number
  summary: string | null
  error_summary: string | null
  transcript_key: string | null
  result_json: string | null
  seq: number
}

const rowToRun = (row: RunRow): RunRecord => ({
  id: row.id,
  workflowId: row.workflow_id,
  inputJson: row.input_json,
  status: row.status as RunStatus,
  // libsql can hand back INTEGER columns as bigint depending on the value;
  // normalise to number so consumers compare against `Date.now()` cleanly.
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
})

const rowToStep = (row: StepRow): StepRecord => ({
  runId: row.run_id,
  name: row.step_name,
  status: row.status as StepStatus,
  sha: row.sha,
  startedAt: Number(row.started_at),
  finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  attempt: Number(row.attempt),
  summary: row.summary,
  errorSummary: row.error_summary,
  transcriptKey: row.transcript_key,
  resultJson: row.result_json,
})

/**
 * Build a `WorkflowStore` over an existing libsql `Client`. Tables are created
 * lazily on first method call (a single guarded `CREATE TABLE IF NOT EXISTS`
 * pass) so construction stays synchronous and cheap.
 *
 * @param client Defaults to the queue's shared singleton (`getClient()`), so
 *   the engine's run/step state lands in the same `.mars/queue.db`. Tests
 *   inject an in-memory client.
 */
export const createQueueWorkflowStore = (
  client: Client = getClient(),
): WorkflowStore => {
  let initialised = false
  const ensureSchema = async (): Promise<void> => {
    if (initialised) return
    await client.execute(RUNS_DDL)
    await client.execute(STEP_RUNS_DDL)
    initialised = true
  }

  return {
    async createRun(run: RunRecord): Promise<void> {
      await ensureSchema()
      // Idempotent on `id` (INSERT OR IGNORE): a resumed run re-enters
      // runWorkflow, which only inserts when getRun returns undefined, but the
      // OR IGNORE keeps a racing double-create harmless.
      await client.execute({
        sql: `INSERT OR IGNORE INTO workflow_runs
                (id, workflow_id, input_json, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          run.id,
          run.workflowId,
          run.inputJson,
          run.status,
          run.createdAt,
          run.updatedAt,
        ],
      })
    },

    async getRun(runId: string): Promise<RunRecord | undefined> {
      await ensureSchema()
      const r = await client.execute({
        sql: `SELECT * FROM workflow_runs WHERE id = ?`,
        args: [runId],
      })
      const row = r.rows[0] as unknown as RunRow | undefined
      return row ? rowToRun(row) : undefined
    },

    async setRunStatus(
      runId: string,
      status: RunStatus,
      updatedAt: number,
    ): Promise<void> {
      await ensureSchema()
      await client.execute({
        sql: `UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?`,
        args: [status, updatedAt, runId],
      })
    },

    async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
      await ensureSchema()
      const r = await client.execute({
        sql: `SELECT * FROM workflow_step_runs WHERE run_id = ? AND step_name = ?`,
        args: [runId, name],
      })
      const row = r.rows[0] as unknown as StepRow | undefined
      return row ? rowToStep(row) : undefined
    },

    async listSteps(runId: string): Promise<StepRecord[]> {
      await ensureSchema()
      const r = await client.execute({
        sql: `SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY seq ASC`,
        args: [runId],
      })
      return (r.rows as unknown as StepRow[]).map(rowToStep)
    },

    async putStep(record: StepRecord): Promise<void> {
      await ensureSchema()
      // Preserve first-seen ordering: keep the existing seq on update,
      // otherwise append after the current max for this run. Mirrors
      // store-sqlite.ts's seq bookkeeping so listSteps renders the trace in
      // insertion order regardless of update churn.
      const existingSeq = await client.execute({
        sql: `SELECT seq FROM workflow_step_runs WHERE run_id = ? AND step_name = ?`,
        args: [record.runId, record.name],
      })
      let seq: number
      if (existingSeq.rows.length > 0) {
        seq = Number((existingSeq.rows[0] as unknown as { seq: number }).seq)
      } else {
        const maxSeq = await client.execute({
          sql: `SELECT COALESCE(MAX(seq), -1) AS m FROM workflow_step_runs WHERE run_id = ?`,
          args: [record.runId],
        })
        seq = Number((maxSeq.rows[0] as unknown as { m: number }).m) + 1
      }

      await client.execute({
        sql: `INSERT INTO workflow_step_runs
                (run_id, step_name, status, sha, started_at, finished_at,
                 attempt, summary, error_summary, transcript_key, result_json, seq)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(run_id, step_name) DO UPDATE SET
                status         = excluded.status,
                sha            = excluded.sha,
                started_at     = excluded.started_at,
                finished_at    = excluded.finished_at,
                attempt        = excluded.attempt,
                summary        = excluded.summary,
                error_summary  = excluded.error_summary,
                transcript_key = excluded.transcript_key,
                result_json    = excluded.result_json`,
        args: [
          record.runId,
          record.name,
          record.status,
          record.sha,
          record.startedAt,
          record.finishedAt,
          record.attempt,
          record.summary,
          record.errorSummary,
          record.transcriptKey,
          record.resultJson,
          seq,
        ],
      })
    },
  }
}
