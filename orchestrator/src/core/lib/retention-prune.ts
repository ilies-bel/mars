import { openDb } from './db.js'

/**
 * Effective retention policy for trace_events (all constants documented here
 * so the policy lives in one place):
 *
 *   - info-level log_line rows are never written to trace_events — they
 *     duplicate watch.log and were 90 % of write volume (≈163 k rows / 14 h).
 *     The writer in trace-events-store.ts filters them at record() time.
 *
 *   - warn/error log_line rows are kept but pruned after LOG_LINE_RETENTION_DAYS
 *     (2 days). Structured events use the broader RETENTION_DAYS_DEFAULT (30 d).
 *
 *   - The row-count cap (RETENTION_MAX_ROWS_DEFAULT = 50 000) is enforced by
 *     looping RETENTION_BATCH_SIZE-sized DELETEs until the table is below the
 *     cap or RETENTION_SWEEP_BUDGET_MS (500 ms) is spent, whichever comes first.
 *     Previous behaviour: one batch (1 000 rows) per hour-interval sweep — only
 *     1 k deletes/h against 13 k inserts/h, so the cap was never reachable.
 *     The budget loop makes the cap real while keeping each sweep tick's work
 *     bounded and predictable.
 *
 *   - Every sweep returns traceEventsRemaining so the caller can log a gauge
 *     line (current rows vs cap) making drift visible instead of silent.
 *
 * Sweep interval: MARS_OBSERVABILITY_SWEEP_MS (default 1 h, wired in server.ts).
 */

/** Days of trace_events history to retain. Override via MARS_RETENTION_DAYS env var. */
export const RETENTION_DAYS_DEFAULT = 30

/**
 * Days to retain warn/error log_line rows. Much tighter than the general window
 * because log_lines are high-volume and their diagnostic value decays quickly.
 * Info-level log_lines are never written to trace_events (filtered in record()).
 */
export const LOG_LINE_RETENTION_DAYS = 2

/**
 * Maximum rows kept in the trace_events table. When the table exceeds this
 * limit the oldest rows (by timestamp) are removed first.
 * Override via MARS_RETENTION_MAX_ROWS env var.
 */
export const RETENTION_MAX_ROWS_DEFAULT = 50_000

/**
 * Maximum rows deleted from any single DELETE statement. Keeps each DELETE
 * short and its dead-tuple churn bounded, so one sweep tick can never turn
 * into an unbounded long-running statement.
 */
export const RETENTION_BATCH_SIZE = 1_000

/**
 * Wall-clock budget in ms for the row-count cap pass. The pass loops
 * batchSize-sized DELETEs until the table is under maxRows or this budget is
 * spent, whichever comes first. Bounding by time (not by pass count) keeps
 * each sweep tick short while allowing real catch-up when the table is
 * significantly over cap.
 */
export const RETENTION_SWEEP_BUDGET_MS = 500

export interface RetentionOptions {
  /**
   * Days of trace_events to retain (age-based pass). Set to 0 to skip the
   * age pass entirely and rely only on the row-count cap. Defaults to
   * RETENTION_DAYS_DEFAULT (30 days).
   */
  maxAgeDays?: number
  /**
   * Age cap in days for warn/error log_line rows. Defaults to
   * LOG_LINE_RETENTION_DAYS (2 days). Set to 0 to skip this pass.
   * Info-level log_lines are never written so this only affects warn/error.
   */
  maxLogLineAgeDays?: number
  /**
   * Row-count cap for trace_events. The oldest rows are trimmed when the
   * table exceeds this limit. Defaults to RETENTION_MAX_ROWS_DEFAULT (50 000).
   */
  maxRows?: number
  /**
   * Maximum rows deleted from any one DELETE statement. Defaults to
   * RETENTION_BATCH_SIZE (1 000). Set to a very large number (e.g.
   * Number.MAX_SAFE_INTEGER) for one-shot manual compaction.
   */
  batchSize?: number
  /**
   * Wall-clock budget in ms for the row-count cap pass (Pass 2). The pass
   * loops batchSize-sized DELETEs until the table is under maxRows or this
   * budget is spent. Defaults to RETENTION_SWEEP_BUDGET_MS (500 ms).
   */
  sweepBudgetMs?: number
}

export interface RetentionResult {
  /** trace_events rows deleted because they exceeded maxAgeDays. */
  traceEventsByAge: number
  /** warn/error log_line rows deleted because they exceeded maxLogLineAgeDays. */
  traceEventsByLogLineAge: number
  /** trace_events rows deleted because the table exceeded maxRows. */
  traceEventsByCount: number
  /**
   * subscriber_processed_events rows deleted because their event_id is no
   * longer present in the events outbox (orphaned dedup-ledger entries).
   */
  subscriberProcessedEvents: number
  /**
   * Row count in trace_events after all prune passes. Logged as a gauge each
   * sweep so drift (e.g. table far above cap) is visible in the daemon log.
   */
  traceEventsRemaining: number
}

/**
 * Prune high-volume append-only tables to prevent the Mars database from
 * growing without bound.
 *
 * Four bounded passes:
 *
 *   1. trace_events by age      — delete rows older than `maxAgeDays` (30 d).
 *   1a. log_line by tight age   — delete log_line rows older than `maxLogLineAgeDays`
 *                                  (2 d); tighter cap for high-volume log rows.
 *   2. trace_events by count    — loop batchSize-sized DELETEs until the table
 *                                  is under `maxRows` or `sweepBudgetMs` elapses.
 *   3. subscriber_processed_events — delete orphaned dedup-ledger rows whose
 *                                  event_id is no longer in the events outbox.
 *
 * Pass 3 is safe to run even though subscriber_processed_events is an
 * idempotency/dedup ledger: if an event_id is no longer in the events table
 * the outbox has already pruned that event (cursor gate + age gate both
 * passed), meaning no subscriber will ever be asked to process it again. The
 * dedup row is therefore stale and its removal cannot cause reprocessing.
 *
 * Each DELETE is bounded by `batchSize` (primary-key IN-subquery batching) so
 * a single sweep tick's work stays predictable. For full compaction (manual
 * `mars db compact`) pass a very large batchSize.
 *
 * Space reclamation after the DELETEs is autovacuum's job — there is no
 * explicit VACUUM or checkpoint step here.
 *
 * Returns a breakdown of the rows removed in each category plus
 * `traceEventsRemaining` (current count after pruning) for gauge logging.
 */
export async function pruneRetention(
  dbTarget: string,
  opts?: RetentionOptions,
): Promise<RetentionResult> {
  const maxAgeDays = opts?.maxAgeDays ?? RETENTION_DAYS_DEFAULT
  const maxLogLineAgeDays = opts?.maxLogLineAgeDays ?? LOG_LINE_RETENTION_DAYS
  const maxRows = opts?.maxRows ?? RETENTION_MAX_ROWS_DEFAULT
  const batchSize = opts?.batchSize ?? RETENTION_BATCH_SIZE
  const sweepBudgetMs = opts?.sweepBudgetMs ?? RETENTION_SWEEP_BUDGET_MS

  const client = openDb(dbTarget)
  try {
    // ── Pass 1: trace_events by age ────────────────────────────────────────
    let traceEventsByAge = 0
    if (maxAgeDays > 0) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
      const r = await client.execute({
        // PK-based IN subquery: LIMIT on the inner SELECT bounds each batch
        // (DELETE has no LIMIT of its own).
        sql: `DELETE FROM trace_events
              WHERE id IN (
                SELECT id FROM trace_events
                WHERE timestamp < ?
                LIMIT ?
              )`,
        args: [cutoff, batchSize],
      })
      traceEventsByAge = r.rowsAffected
    }

    // ── Pass 1a: log_line rows by tight age cap ────────────────────────────
    // warn/error log_lines have a 2-day window vs 30 days for structured
    // events. Info-level log_lines are never written (filtered in record()).
    let traceEventsByLogLineAge = 0
    if (maxLogLineAgeDays > 0) {
      const logLineCutoff = Date.now() - maxLogLineAgeDays * 24 * 60 * 60 * 1000
      const r = await client.execute({
        sql: `DELETE FROM trace_events
              WHERE id IN (
                SELECT id FROM trace_events
                WHERE kind = 'log_line' AND timestamp < ?
                LIMIT ?
              )`,
        args: [logLineCutoff, batchSize],
      })
      traceEventsByLogLineAge = r.rowsAffected
    }

    // ── Pass 2: trace_events by row count (looping) ───────────────────────
    // Loop batchSize-sized DELETEs until the table is under maxRows or the
    // sweep budget (sweepBudgetMs) is exhausted, whichever comes first.
    // Each iteration is a bounded DELETE so a sweep tick's work stays
    // predictable. The budget replaces the old "single batch per sweep"
    // behaviour that made the row cap unreachable at high insert rates.
    let traceEventsByCount = 0
    {
      const budgetDeadline = Date.now() + sweepBudgetMs
      const cr = await client.execute('SELECT COUNT(*) AS n FROM trace_events')
      let currentCount = Number(
        (cr.rows[0] as unknown as { n: number | bigint }).n,
      )
      while (currentCount > maxRows && Date.now() < budgetDeadline) {
        const toDelete = Math.min(currentCount - maxRows, batchSize)
        const r = await client.execute({
          sql: `DELETE FROM trace_events
                WHERE id IN (
                  SELECT id FROM trace_events
                  ORDER BY timestamp ASC
                  LIMIT ?
                )`,
          args: [toDelete],
        })
        if (r.rowsAffected === 0) break // guard: empty table or nothing matched
        traceEventsByCount += r.rowsAffected
        const cr2 = await client.execute(
          'SELECT COUNT(*) AS n FROM trace_events',
        )
        currentCount = Number(
          (cr2.rows[0] as unknown as { n: number | bigint }).n,
        )
      }
    }

    // ── Pass 3: subscriber_processed_events orphan prune ───────────────────
    // events and subscriber_processed_events are both owned by the canonical
    // schema (pg-schema.ts), so no existence probe is needed. The composite
    // PK (subscriber_id, event_id) drives the batch subquery.
    let subscriberProcessedEvents = 0
    {
      const r = await client.execute({
        sql: `DELETE FROM subscriber_processed_events
              WHERE (subscriber_id, event_id) IN (
                SELECT subscriber_id, event_id FROM subscriber_processed_events
                WHERE event_id NOT IN (SELECT id FROM events)
                LIMIT ?
              )`,
        args: [batchSize],
      })
      subscriberProcessedEvents = r.rowsAffected
    }

    // ── Gauge: final row count after all passes ────────────────────────────
    const finalCr = await client.execute(
      'SELECT COUNT(*) AS n FROM trace_events',
    )
    const traceEventsRemaining = Number(
      (finalCr.rows[0] as unknown as { n: number | bigint }).n,
    )

    return {
      traceEventsByAge,
      traceEventsByLogLineAge,
      traceEventsByCount,
      subscriberProcessedEvents,
      traceEventsRemaining,
    }
  } finally {
    await client.close()
  }
}
