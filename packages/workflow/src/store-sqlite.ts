import { createRequire } from 'node:module';
import type {
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  WorkflowStore,
} from './store.js';

/**
 * Structural subset of `node:sqlite`'s `DatabaseSync` we depend on. We load
 * the module lazily via `createRequire` rather than a static
 * `import … from 'node:sqlite'` so bundler-based test runners (vitest/vite)
 * don't try to pre-resolve the builtin — it is resolved by Node at runtime,
 * where it exists.
 */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

function loadSqlite(): SqliteModule {
  const require = createRequire(import.meta.url);
  return require('node:sqlite') as SqliteModule;
}

/**
 * Default durable `WorkflowStore`, backed by the SQLite engine built into
 * Node (`node:sqlite`, stable from Node 22.13). No native addon, no
 * `better-sqlite3` install step — the runtime ships it.
 *
 * Two tables, exactly as the README documents: `workflow_runs` and
 * `workflow_step_runs` keyed by `(run_id, step_name)`. The schema is
 * created on construction if absent.
 */
export class SqliteStore implements WorkflowStore {
  private readonly db: SqliteDatabase;

  /**
   * @param path File path for the database, or `':memory:'` for an
   *   ephemeral in-process database.
   */
  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id          TEXT PRIMARY KEY,
        workflow_id TEXT    NOT NULL,
        input_json  TEXT    NOT NULL,
        status      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

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
      );
    `);
  }

  /** Release the underlying file handle. */
  close(): void {
    this.db.close();
  }

  async createRun(run: RunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_runs
           (id, workflow_id, input_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.workflowId, run.inputJson, run.status, run.createdAt, run.updatedAt);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM workflow_runs WHERE id = ?`)
      .get(runId) as unknown as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  async setRunStatus(runId: string, status: RunStatus, updatedAt: number): Promise<void> {
    this.db
      .prepare(`UPDATE workflow_runs SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, updatedAt, runId);
  }

  async getStep(runId: string, name: string): Promise<StepRecord | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM workflow_step_runs WHERE run_id = ? AND step_name = ?`)
      .get(runId, name) as unknown as StepRow | undefined;
    return row ? rowToStep(row) : undefined;
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId) as unknown as StepRow[];
    return rows.map(rowToStep);
  }

  async putStep(record: StepRecord): Promise<void> {
    // Preserve first-seen ordering: keep the existing seq on update,
    // otherwise append after the current max for this run.
    const existing = this.db
      .prepare(`SELECT seq FROM workflow_step_runs WHERE run_id = ? AND step_name = ?`)
      .get(record.runId, record.name) as unknown as { seq: number } | undefined;
    const seq = existing
      ? existing.seq
      : (
          this.db
            .prepare(`SELECT COALESCE(MAX(seq), -1) AS m FROM workflow_step_runs WHERE run_id = ?`)
            .get(record.runId) as unknown as { m: number }
        ).m + 1;

    this.db
      .prepare(
        `INSERT INTO workflow_step_runs
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
      )
      .run(
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
      );
  }
}

/** Row shape as `node:sqlite` returns it for `workflow_runs`. */
interface RunRow {
  id: string;
  workflow_id: string;
  input_json: string;
  status: string;
  created_at: number;
  updated_at: number;
}

/** Row shape as `node:sqlite` returns it for `workflow_step_runs`. */
interface StepRow {
  run_id: string;
  step_name: string;
  status: string;
  sha: string | null;
  started_at: number;
  finished_at: number | null;
  attempt: number;
  summary: string | null;
  error_summary: string | null;
  transcript_key: string | null;
  result_json: string | null;
  seq: number;
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    inputJson: row.input_json,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToStep(row: StepRow): StepRecord {
  return {
    runId: row.run_id,
    name: row.step_name,
    status: row.status as StepStatus,
    sha: row.sha,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    attempt: row.attempt,
    summary: row.summary,
    errorSummary: row.error_summary,
    transcriptKey: row.transcript_key,
    resultJson: row.result_json,
  };
}
