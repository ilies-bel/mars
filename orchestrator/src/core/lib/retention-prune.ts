import { openLibsql } from './libsql'

/** Days of trace_events history to retain. Override via MARS_RETENTION_DAYS env var. */
export const RETENTION_DAYS_DEFAULT = 30
/**
 * Maximum rows kept in the trace_events table. When the table exceeds this
 * limit the oldest rows (by timestamp) are removed first.
 * Override via MARS_RETENTION_MAX_ROWS env var.
 */
export const RETENTION_MAX_ROWS_DEFAULT = 50_000
/**
 * Maximum rows deleted from any single table per sweep invocation. Keeps each
 * DELETE short so it cannot hold a write lock long enough to starve the event
 * loop (which is the root cause of the daemon-wedge this sweep is meant to
 * prevent).
 */
export const RETENTION_BATCH_SIZE = 1_000

export interface RetentionOptions {
  /**
   * Days of trace_events to retain (age-based pass). Set to 0 to skip the
   * age pass entirely and rely only on the row-count cap. Defaults to
   * RETENTION_DAYS_DEFAULT (30 days).
   */
  maxAgeDays?: number
  /**
   * Row-count cap for trace_events. The oldest rows are trimmed when the
   * table exceeds this limit. Defaults to RETENTION_MAX_ROWS_DEFAULT (50 000).
   */
  maxRows?: number
  /**
   * Maximum rows deleted from any one table per call. Defaults to
   * RETENTION_BATCH_SIZE (1 000). Set to a very large number (e.g.
   * Number.MAX_SAFE_INTEGER) for one-shot manual compaction.
   */
  batchSize?: number
}

export interface RetentionResult {
  /** trace_events rows deleted because they exceeded maxAgeDays. */
  traceEventsByAge: number
  /** trace_events rows deleted because the table exceeded maxRows. */
  traceEventsByCount: number
  /**
   * subscriber_processed_events rows deleted because their event_id is no
   * longer present in the events outbox (orphaned dedup-ledger entries).
   */
  subscriberProcessedEvents: number
}

/**
 * Prune high-volume append-only tables to prevent mars.db from growing without
 * bound and starving the synchronous better-sqlite3 write path.
 *
 * Three bounded passes:
 *
 *   1. trace_events by age  — delete rows older than `maxAgeDays`.
 *   2. trace_events by count — trim oldest rows when the table exceeds
 *      `maxRows` (secondary cap; fires even when all rows are recent).
 *   3. subscriber_processed_events — delete orphaned dedup-ledger rows
 *      whose event_id is no longer present in the events outbox.
 *
 * Pass 3 is safe to run even though subscriber_processed_events is an
 * idempotency/dedup ledger: if an event_id is no longer in the events table
 * the outbox has already pruned that event (cursor gate + age gate both
 * passed), meaning no subscriber will ever be asked to process it again. The
 * dedup row is therefore stale and its removal cannot cause reprocessing.
 *
 * Each pass is bounded by `batchSize` so no single DELETE holds a write lock
 * long enough to reproduce the daemon wedge. For full compaction (manual
 * `mars db compact`) pass a very large batchSize.
 *
 * Does NOT run VACUUM or WAL checkpoint — those are the caller's
 * responsibility. VACUUM requires a full file rewrite under a write lock and
 * belongs in a manual command, not a hot sweep.
 *
 * Returns a breakdown of the rows removed in each category.
 */
export async function pruneRetention(
  dbPath: string,
  opts?: RetentionOptions,
): Promise<RetentionResult> {
  const maxAgeDays = opts?.maxAgeDays ?? RETENTION_DAYS_DEFAULT
  const maxRows = opts?.maxRows ?? RETENTION_MAX_ROWS_DEFAULT
  const batchSize = opts?.batchSize ?? RETENTION_BATCH_SIZE

  const client = openLibsql({ url: `file:${dbPath}` })
  try {
    // Ensure trace_events exists so this is safe to call on a fresh repo.
    await client.execute(`
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
    `)

    // ── Pass 1: trace_events by age ────────────────────────────────────────
    let traceEventsByAge = 0
    if (maxAgeDays > 0) {
      const cutoff = new Date(
        Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
      ).toISOString()
      const r = await client.execute({
        // rowid-based IN subquery: works on any table without WITHOUT ROWID.
        // LIMIT on the inner SELECT bounds the write-lock duration.
        sql: `DELETE FROM trace_events
              WHERE rowid IN (
                SELECT rowid FROM trace_events
                WHERE timestamp < ?
                LIMIT ?
              )`,
        args: [cutoff, batchSize],
      })
      traceEventsByAge = r.rowsAffected
    }

    // ── Pass 2: trace_events by row count ──────────────────────────────────
    let traceEventsByCount = 0
    const countResult = await client.execute(
      'SELECT COUNT(*) AS n FROM trace_events',
    )
    const totalRows = Number(
      (countResult.rows[0] as unknown as { n: number | bigint }).n,
    )
    if (totalRows > maxRows) {
      const toDelete = Math.min(totalRows - maxRows, batchSize)
      const r = await client.execute({
        sql: `DELETE FROM trace_events
              WHERE rowid IN (
                SELECT rowid FROM trace_events
                ORDER BY timestamp ASC
                LIMIT ?
              )`,
        args: [toDelete],
      })
      traceEventsByCount = r.rowsAffected
    }

    // ── Pass 3: subscriber_processed_events orphan prune ───────────────────
    // Only runs when both tables are present — skip on fresh repos or DBs
    // that predate the subscriber pipeline.
    let subscriberProcessedEvents = 0
    const tableCheck = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM sqlite_master
            WHERE type = 'table' AND name IN ('events', 'subscriber_processed_events')`,
      args: [],
    })
    const presentTableCount = Number(
      (tableCheck.rows[0] as unknown as { n: number | bigint }).n,
    )
    if (presentTableCount === 2) {
      const r = await client.execute({
        sql: `DELETE FROM subscriber_processed_events
              WHERE rowid IN (
                SELECT rowid FROM subscriber_processed_events
                WHERE event_id NOT IN (SELECT id FROM events)
                LIMIT ?
              )`,
        args: [batchSize],
      })
      subscriberProcessedEvents = r.rowsAffected
    }

    return { traceEventsByAge, traceEventsByCount, subscriberProcessedEvents }
  } finally {
    client.close()
  }
}
