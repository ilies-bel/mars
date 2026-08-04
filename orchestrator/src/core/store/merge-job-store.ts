/**
 * Merge-job store — durable single-consumer merge queue (PRD 92af89ce).
 *
 * Each `merge_jobs` row represents one merge attempt for a task branch. The
 * store enforces strict status transitions:
 *
 *   queued → claimed (claimNext atomically selects the oldest queued row)
 *   claimed → running (markRunning stamps started_at)
 *   running → done | failed (markDone / markFailed stamp finished_at)
 *   any non-terminal → canceled (markCanceled)
 *
 * A partial unique index (`merge_jobs_active_task_uidx`) prevents more than
 * one active (queued/claimed/running) job per task_id at the DB level.
 *
 * Schema ownership: the `merge_jobs` table and its index are created by
 * `ensureSchema` in core/lib/pg-schema.ts — this module carries no DDL.
 *
 * Factory: `createMergeJobStore(client)` binds all methods to the given
 * `DbClient`. `getDefaultMergeJobStore()` is the composition-root accessor
 * that lazily obtains the seam-internal client.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DbClient } from '../lib/db.js'
import { resolveStateClient } from './state-client.js'

// ── Status type ───────────────────────────────────────────────────────────────

export type MergeJobStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'

// ── Domain type ───────────────────────────────────────────────────────────────

export interface MergeJob {
  id: string
  taskId: string
  status: MergeJobStatus
  attempts: number
  claimedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  errorCode: string | null
  integrationBranch: string
  worktreePath: string
  branch: string
  /**
   * The integration-branch tip after this job landed, or null for a job that
   * has not finished (or one from before Mars recorded it). This is the only
   * durable record of which commits on the integration branch are Mars's own
   * work — everything else there arrived by hand.
   */
  mergedSha: string | null
  createdAt: string
  updatedAt: string
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface EnqueueMergeJobInput {
  taskId: string
  integrationBranch: string
  worktreePath: string
  branch: string
}

// ── Zod schema for row validation ─────────────────────────────────────────────

/**
 * Coerce a timestamptz value to an ISO-8601 string regardless of backend.
 * - pg (embedded) returns Date objects for timestamptz columns.
 * - PGlite returns ISO strings.
 */
const timestampCoerce = z.preprocess((v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  return v
}, z.string().nullable())

const MergeJobRowSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  status: z.enum(['queued', 'claimed', 'running', 'done', 'failed', 'canceled']),
  attempts: z.number(),
  claimed_at: timestampCoerce,
  started_at: timestampCoerce,
  finished_at: timestampCoerce,
  error: z.string().nullable(),
  error_code: z.string().nullable(),
  integration_branch: z.string(),
  worktree_path: z.string(),
  branch: z.string(),
  merged_sha: z.string().nullable().default(null),
  created_at: z.preprocess((v) => {
    if (v instanceof Date) return v.toISOString()
    return v
  }, z.string()),
  updated_at: z.preprocess((v) => {
    if (v instanceof Date) return v.toISOString()
    return v
  }, z.string()),
})

function rowToMergeJob(raw: unknown): MergeJob {
  const row = MergeJobRowSchema.parse(raw)
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    attempts: row.attempts,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    errorCode: row.error_code,
    integrationBranch: row.integration_branch,
    worktreePath: row.worktree_path,
    branch: row.branch,
    mergedSha: row.merged_sha,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── Store interface ───────────────────────────────────────────────────────────

export interface MergeJobStore {
  /**
   * Insert a new merge job for the given task in 'queued' status.
   * Throws if an active (queued/claimed/running) job already exists for
   * the task_id (enforced by the partial unique index).
   */
  enqueue(input: EnqueueMergeJobInput): Promise<MergeJob>

  /**
   * Atomically claim the oldest queued job. Returns `null` when the queue is
   * empty. Increments `attempts` and stamps `claimed_at`.
   */
  claimNext(): Promise<MergeJob | null>

  /**
   * Advance a claimed job to 'running'. Stamps `started_at`.
   * Returns the updated row, or `null` if the job was not found / not in
   * 'claimed' status.
   */
  markRunning(id: string): Promise<MergeJob | null>

  /**
   * Mark a job as 'done'. Stamps `finished_at`.
   * Returns the updated row, or `null` if not found.
   */
  markDone(id: string, mergedSha?: string | null): Promise<MergeJob | null>

  /**
   * Mark a job as 'failed'. Records `error` and optional `errorCode`. Stamps
   * `finished_at`. Returns the updated row, or `null` if not found.
   */
  markFailed(
    id: string,
    err: { message: string; code?: string },
  ): Promise<MergeJob | null>

  /**
   * Mark a job as 'canceled'. Records `reason` in `error`. Stamps
   * `finished_at`. Returns the updated row, or `null` if not found.
   */
  markCanceled(id: string, reason: string): Promise<MergeJob | null>

  /**
   * Fetch the most recent merge job for a given task_id. Returns `null` if
   * none exists.
   */
  getByTaskId(taskId: string): Promise<MergeJob | null>

  /**
   * List all active (queued/claimed/running) merge jobs, oldest first.
   */
  listActive(): Promise<MergeJob[]>

  /**
   * List all merge jobs with the given status, oldest first.
   */
  listByStatus(status: MergeJobStatus): Promise<MergeJob[]>

  /**
   * Return the active (queued/claimed/running) merge job for a given task_id,
   * or `null` if none exists. Used by restart/purge guards to refuse operations
   * that would tear down a worktree under an in-flight merge.
   */
  getActiveMergeJob(taskId: string): Promise<MergeJob | null>
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a `MergeJobStore` bound to the given DB client.
 */
export const createMergeJobStore = (client: DbClient): MergeJobStore => {
  const store: MergeJobStore = {
    async enqueue(input) {
      const id = randomUUID()
      const rs = await client.execute({
        sql: `INSERT INTO merge_jobs
                (id, task_id, status, attempts, integration_branch, worktree_path, branch)
              VALUES (?, ?, 'queued', 0, ?, ?, ?)
              RETURNING *`,
        args: [id, input.taskId, input.integrationBranch, input.worktreePath, input.branch],
      })
      if (rs.rows.length === 0) {
        throw new Error('merge-job-store: INSERT returned no rows')
      }
      return rowToMergeJob(rs.rows[0])
    },

    async claimNext() {
      // Atomic CTE: select the oldest queued job, update it to 'claimed', and
      // return the updated row. FOR UPDATE SKIP LOCKED ensures concurrent
      // callers on the embedded backend don't double-claim the same row.
      const rs = await client.execute(`
        UPDATE merge_jobs
        SET status     = 'claimed',
            claimed_at = NOW(),
            attempts   = attempts + 1,
            updated_at = NOW()
        WHERE id = (
          SELECT id FROM merge_jobs
          WHERE  status = 'queued'
          ORDER  BY created_at ASC
          LIMIT  1
          FOR    UPDATE SKIP LOCKED
        )
        RETURNING *
      `)
      if (rs.rows.length === 0) return null
      return rowToMergeJob(rs.rows[0])
    },

    async markRunning(id) {
      const rs = await client.execute({
        sql: `UPDATE merge_jobs
              SET status     = 'running',
                  started_at = NOW(),
                  updated_at = NOW()
              WHERE id = ? AND status = 'claimed'
              RETURNING *`,
        args: [id],
      })
      if (rs.rows.length === 0) return null
      return rowToMergeJob(rs.rows[0])
    },

    async markDone(id, mergedSha) {
      const rs = await client.execute({
        sql: `UPDATE merge_jobs
              SET status      = 'done',
                  finished_at = NOW(),
                  merged_sha  = COALESCE(?, merged_sha),
                  updated_at  = NOW()
              WHERE id = ?
              RETURNING *`,
        args: [mergedSha ?? null, id],
      })
      if (rs.rows.length === 0) return null
      return rowToMergeJob(rs.rows[0])
    },

    async markFailed(id, err) {
      const rs = await client.execute({
        sql: `UPDATE merge_jobs
              SET status      = 'failed',
                  error       = ?,
                  error_code  = ?,
                  finished_at = NOW(),
                  updated_at  = NOW()
              WHERE id = ?
              RETURNING *`,
        args: [err.message, err.code ?? null, id],
      })
      if (rs.rows.length === 0) return null
      return rowToMergeJob(rs.rows[0])
    },

    async markCanceled(id, reason) {
      const rs = await client.execute({
        sql: `UPDATE merge_jobs
              SET status      = 'canceled',
                  error       = ?,
                  finished_at = NOW(),
                  updated_at  = NOW()
              WHERE id = ?
              RETURNING *`,
        args: [reason, id],
      })
      if (rs.rows.length === 0) return null
      return rowToMergeJob(rs.rows[0])
    },

    async getByTaskId(taskId) {
      const rs = await client.execute({
        sql: `SELECT * FROM merge_jobs
              WHERE  task_id = ?
              ORDER  BY created_at DESC
              LIMIT  1`,
        args: [taskId],
      })
      if (rs.rows.length === 0) return null
      return rowToMergeJob(rs.rows[0])
    },

    async listActive() {
      const rs = await client.execute(`
        SELECT * FROM merge_jobs
        WHERE  status IN ('queued', 'claimed', 'running')
        ORDER  BY created_at ASC
      `)
      return rs.rows.map(rowToMergeJob)
    },

    async listByStatus(status) {
      const rs = await client.execute({
        sql: `SELECT * FROM merge_jobs
              WHERE  status = ?
              ORDER  BY created_at ASC`,
        args: [status],
      })
      return rs.rows.map(rowToMergeJob)
    },

    async getActiveMergeJob(taskId) {
      const rs = await client.execute({
        sql: `SELECT * FROM merge_jobs
              WHERE  task_id = ?
                AND  status IN ('queued', 'claimed', 'running')
              ORDER  BY created_at DESC
              LIMIT  1`,
        args: [taskId],
      })
      if (rs.rows.length === 0) return null
      return rowToMergeJob(rs.rows[0])
    },
  }

  return store
}

// ── Composition-root accessor ─────────────────────────────────────────────────

let defaultMergeJobStore: MergeJobStore | null = null

/**
 * Composition-root accessor: the single process-wide `MergeJobStore` over the
 * Mars database. Lazily constructs the store around the seam-internal client
 * (`resolveQueueClient`). This is the only sanctioned way for production
 * modules to obtain a merge-job store when one was not threaded in via DI.
 *
 * Tests must use `createMergeJobStore(client)` with an isolated client rather
 * than this accessor.
 */
export const getDefaultMergeJobStore = (): MergeJobStore => {
  if (defaultMergeJobStore) return defaultMergeJobStore
  // resolveStateClient() and resolveQueueClient() both call
  // openDb(resolveDbTarget()) — they bind to the same underlying database
  // instance (openDb is memoized per target). Using the state-client seam
  // avoids an import cycle through queue.ts.
  defaultMergeJobStore = createMergeJobStore(resolveStateClient())
  return defaultMergeJobStore
}

/**
 * Test-only: drop the cached default store so a subsequent call rebuilds
 * against whatever queue client is current.
 */
export const __resetDefaultMergeJobStoreForTests = (): void => {
  defaultMergeJobStore = null
}
