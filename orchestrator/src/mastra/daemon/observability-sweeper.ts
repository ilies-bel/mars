import { pruneObservability } from '../lib/observability-prune'

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
