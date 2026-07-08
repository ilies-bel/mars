import { existsSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'
import type { Client } from '@libsql/client'
import type {
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  Workflow,
  WorkflowStore,
} from '@mars/workflow'
import { getCompositionRootClient } from '../core/store/task-store'
import { getRepoRoot } from '../core/context'
import { readWorkflowProvenance } from './agent-draft'

/**
 * `WorkflowStore` adapter over the orchestrator's consolidated `.mars/mars.db`.
 *
 * The @mars/workflow engine persists run + step lifecycle into two tables it
 * defines — `workflow_runs` and `workflow_step_runs`, keyed by
 * `(run_id, step_name)`. The reference `SqliteStore` (packages/workflow's
 * store-sqlite.ts) backs those tables with `node:sqlite`; here we mirror its
 * column/SQL shape exactly but route through the orchestrator's existing
 * libsql `Client` (same connection `queue.ts` uses), so the engine's
 * checkpoint-resume state lives alongside the task queue in one file. (The old
 * `queue.db`/`state.db` split was merged into `mars.db`; any leftover files are
 * stale post-merge artifacts.)
 *
 * Resume is the whole point of co-locating in `.mars/mars.db`: the daemon
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
 * @param client Defaults to the composition-root libsql client
 *   (`getCompositionRootClient()`), so the engine's run/step state lands in
 *   the same `.mars/mars.db`. Tests inject an in-memory client.
 */
export const createQueueWorkflowStore = (
  client: Client = getCompositionRootClient(),
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

    async deleteRun(runId: string): Promise<void> {
      await ensureSchema()
      await client.batch(
        [
          {
            sql: 'DELETE FROM workflow_step_runs WHERE run_id = ?',
            args: [runId],
          },
          {
            sql: 'DELETE FROM workflow_runs WHERE id = ?',
            args: [runId],
          },
        ],
        'write',
      )
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

/**
 * Repo-relative directory the user-owned workflow modules live in. Mirrors
 * `WORKFLOWS_DEST_REL` in `src/init/scaffold-workflows.ts` — `mars init`
 * scaffolds the official templates here as plain JS the consumer is expected
 * to edit (ADR-0056), and `mars update` never silently clobbers them
 * (ADR-0057). The daemon loads them from here at dispatch time.
 */
const WORKFLOWS_DIR_REL = '.mars/workflows'

/**
 * The on-disk filename for a workflow of the given name. The scaffold lands
 * each template at `.mars/workflows/<name>-workflow.js`. Names default to the
 * task's kind (`task` | `fix` | `diagnose`) but any name is legal — the
 * `workflow` task field selects non-default pipelines (e.g. `live`).
 */
export const workflowFileName = (name: string): string =>
  `${name}-workflow.js`

/**
 * Absolute path the user-owned workflow of the given name lives at, under
 * `repoRoot` (defaults to the composition-root repo root).
 */
export const userWorkflowPath = (
  name: string,
  repoRoot: string = getRepoRoot(),
): string => resolvePath(repoRoot, WORKFLOWS_DIR_REL, workflowFileName(name))

/**
 * The minimal shape a user-owned workflow module must default-export. It is a
 * plain-JS `@mars/workflow` workflow object — `{ id, fn }`, optionally an
 * `inputSchema` — runnable verbatim by `runWorkflow`. The scaffold templates
 * (`src/init/templates/workflows/*.js`) emit exactly this; we validate the
 * two load-bearing fields at load time and treat anything else as malformed.
 */
const isWorkflowShape = (value: unknown): value is Workflow<unknown, unknown, unknown> => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; fn?: unknown }
  return typeof candidate.id === 'string' && typeof candidate.fn === 'function'
}

/**
 * Thrown by {@link loadWorkflowByName} when the named workflow file is
 * missing, fails to import, or default-exports the wrong shape. Carries the
 * workflow name and resolved path so the dispatcher can fail the task with an
 * actionable message. Detected structurally via {@link isWorkflowLoadError}
 * (name-based, survives dynamic-import module duplication).
 */
export class WorkflowLoadError extends Error {
  readonly workflowName: string
  readonly path: string

  constructor(workflowName: string, path: string, message: string) {
    super(message)
    this.name = 'WorkflowLoadError'
    this.workflowName = workflowName
    this.path = path
  }
}

export const isWorkflowLoadError = (err: unknown): err is WorkflowLoadError =>
  err instanceof Error && err.name === 'WorkflowLoadError'

/**
 * Resolve the workflow to run by NAME — `task.workflow ?? task.kind`.
 *
 * There is NO fallback: a missing or malformed file throws a
 * {@link WorkflowLoadError} naming the file and the remedy. The dispatcher
 * must never silently substitute a different pipeline — with per-step
 * Execution modes, a typo'd live workflow silently degrading to the
 * fully-auto implement pipeline would hand a manual step to an agent
 * (supersedes the ADR-0056 bundled-fallback clause).
 *
 * The import URL carries the file's mtime, so an edited workflow goes live on
 * the NEXT dispatch without a daemon restart (Node's ESM cache is keyed by
 * the full URL; a bare import would pin the first-loaded version for the
 * daemon's lifetime).
 *
 * This loader changes WHICH workflow runs, not how it runs: the caller still
 * dispatches it through `runWorkflow` with the same `store` /
 * `services: { store }` wiring, so task-state writes keep funnelling through
 * the Arc aggregate (ADR-0052 / S4).
 */
export const loadWorkflowByName = async <I, O, S>(
  name: string,
  repoRoot: string = getRepoRoot(),
): Promise<Workflow<I, O, S>> => {
  const path = userWorkflowPath(name, repoRoot)
  if (!existsSync(path)) {
    throw new WorkflowLoadError(
      name,
      path,
      `no workflow file for '${name}': expected ${path}. No fallback pipeline is ever substituted — create the file (see 'mars workflow list') or run 'mars update' to re-scaffold the defaults.`,
    )
  }
  // Agent-draft gate (ADR-0068): a self-authored workflow that has not been
  // operator-approved is NOT dispatch-eligible. Hard-fail with the remedy —
  // never fall back to a different pipeline (ADR-0067).
  const provenance = readWorkflowProvenance(readFileSync(path, 'utf8'))
  if (provenance.pendingApproval) {
    throw new WorkflowLoadError(
      name,
      path,
      `workflow '${name}' is an agent draft pending approval (authored by ${provenance.author ?? 'unknown'}). It is not dispatch-eligible until an operator reviews and approves it: mars workflow approve ${name}. No fallback pipeline is substituted.`,
    )
  }
  return importWorkflowFile(name, path)
}

/**
 * Import a workflow module from an explicit file path and shape-check its
 * default export. This is the raw load step behind {@link loadWorkflowByName}
 * — WITHOUT the agent-draft approval gate — used by `mars workflow author`
 * to dry-run a draft body before (and after) it lands on disk. Dispatch must
 * always go through {@link loadWorkflowByName} so the gate applies.
 */
export const importWorkflowFile = async <I, O, S>(
  name: string,
  path: string,
): Promise<Workflow<I, O, S>> => {
  // Plain-JS user module outside the TS source tree: the specifier is
  // computed at runtime, so TS cannot (and should not) statically resolve it.
  // Import by file URL so absolute paths work cross-platform.
  const { mtimeMs, size } = statSync(path)
  let mod: { default?: unknown }
  try {
    mod = (await import(
      `${pathToFileURL(path).href}?v=${mtimeMs}-${size}`
    )) as { default?: unknown }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new WorkflowLoadError(
      name,
      path,
      `workflow file ${path} failed to load: ${msg}. No fallback pipeline is substituted — fix the file and re-dispatch (check it with 'mars workflow validate ${name}').`,
    )
  }
  const candidate = mod.default
  if (!isWorkflowShape(candidate)) {
    throw new WorkflowLoadError(
      name,
      path,
      `workflow file ${path} must default-export a workflow object with { id: string, fn: function } (use defineWorkflow from 'mars/workflow'). No fallback pipeline is substituted — fix the export (check it with 'mars workflow validate ${name}').`,
    )
  }
  return candidate as Workflow<I, O, S>
}
