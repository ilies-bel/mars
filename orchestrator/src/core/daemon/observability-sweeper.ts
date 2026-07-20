import { pruneObservability } from '../lib/observability-prune'
import { pruneRetention, type RetentionResult } from '../lib/retention-prune'

/**
 * Number of days to retain telemetry in the daemon's periodic sweep. Matches
 * the default retention window of `mars observability prune` so operators get
 * consistent behaviour whether the sweep or the manual command ran last.
 */
export const OBSERVABILITY_RETENTION_DAYS = 3

/**
 * Prune telemetry events older than three days from the store at `dbTarget`.
 * Returns the count of deleted rows.
 *
 * This is the routine called by the daemon's recurring sweep. It delegates
 * directly to `pruneObservability` so the manual `mars observability prune`
 * command and the automatic sweep share the same deletion logic.
 */
export const sweepObservability = (dbTarget: string): Promise<number> =>
  pruneObservability(dbTarget, OBSERVABILITY_RETENTION_DAYS)

/**
 * Run the retention sweep: prune high-volume append-only tables so the state
 * store stays bounded across long-lived daemon sessions.
 *
 * Covers three categories in a single sweep (all DELETEs are batch-bounded to
 * keep write-transaction duration short):
 *
 *   - trace_events by age        — rows older than RETENTION_DAYS_DEFAULT (30 d).
 *   - log_line rows by tight age — warn/error log_line rows older than
 *                                   LOG_LINE_RETENTION_DAYS (2 d). Info-level
 *                                   log_lines are never written to trace_events
 *                                   (filtered in trace-events-store.ts record()).
 *   - trace_events by count      — loops RETENTION_BATCH_SIZE-sized DELETEs
 *                                   until the table is under
 *                                   RETENTION_MAX_ROWS_DEFAULT (50 000) or
 *                                   RETENTION_SWEEP_BUDGET_MS (500 ms) elapses.
 *   - subscriber_processed_events — orphaned dedup-ledger rows deleted when
 *                                   their event_id is no longer in the events
 *                                   outbox.
 *
 * Space reclamation after the prune is PostgreSQL's job: autovacuum reuses
 * the freed pages (the SQLite-era WAL checkpoint after a prune is gone).
 *
 * Returns the full per-category breakdown from pruneRetention, including
 * traceEventsRemaining for gauge logging by the caller.
 */
export const sweepRetention = (dbTarget: string): Promise<RetentionResult> =>
  pruneRetention(dbTarget)
