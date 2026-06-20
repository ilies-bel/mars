import { pruneObservability } from '../lib/observability-prune'
import { pruneRetention, type RetentionResult } from '../lib/retention-prune'
import { openLibsql } from '../lib/libsql'

/**
 * Number of days to retain telemetry in the daemon's periodic sweep. Matches
 * the default retention window of `mars observability prune` so operators get
 * consistent behaviour whether the sweep or the manual command ran last.
 */
export const OBSERVABILITY_RETENTION_DAYS = 3

/**
 * Prune telemetry events older than three days from the store at `dbPath`.
 * Returns the count of deleted rows.
 *
 * This is the routine called by the daemon's recurring sweep. It delegates
 * directly to `pruneObservability` so the manual `mars observability prune`
 * command and the automatic sweep share the same deletion logic.
 */
export const sweepObservability = (dbPath: string): Promise<number> =>
  pruneObservability(dbPath, OBSERVABILITY_RETENTION_DAYS)

/**
 * Run the retention sweep: prune high-volume append-only tables so mars.db
 * stays bounded across long-lived daemon sessions.
 *
 * Covers three tables in a single sweep (all deletes are batched to keep
 * write-lock duration short):
 *
 *   - trace_events          — capped at RETENTION_MAX_ROWS_DEFAULT rows and
 *                             RETENTION_DAYS_DEFAULT days (30 days / 50 000
 *                             rows). This is the secondary guard; the primary
 *                             3-day time-based sweep runs via sweepObservability.
 *   - subscriber_processed_events — orphaned dedup-ledger rows deleted when
 *                             their event_id is no longer in the events outbox.
 *
 * After a meaningful prune (any rows deleted) a WAL checkpoint is issued so
 * freed pages are transferred from the WAL to the main DB file promptly. The
 * daemon's 60-second WAL-checkpoint sweep also handles this, so a checkpoint
 * failure here is non-fatal.
 *
 * Returns the full per-category breakdown from pruneRetention.
 */
export async function sweepRetention(dbPath: string): Promise<RetentionResult> {
  const result = await pruneRetention(dbPath)

  const totalDeleted =
    result.traceEventsByAge +
    result.traceEventsByCount +
    result.subscriberProcessedEvents

  if (totalDeleted > 0) {
    const client = openLibsql({ url: `file:${dbPath}` })
    try {
      await client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // Non-fatal — the 60-second WAL-checkpoint sweep will retry.
    } finally {
      client.close()
    }
  }

  return result
}
