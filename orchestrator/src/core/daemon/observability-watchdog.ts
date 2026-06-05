/**
 * Periodically checks the trace_events footprint inside mars.db. When the
 * table exceeds 500 MB, a single open action-queue item is raised so the
 * operator notices a runaway daemon or telemetry-capture bug.
 *
 * Repeated checks while the store is still oversize bump the existing open
 * item (seen_count++) rather than inserting a sibling row. The dedup key is a
 * fixed signature so all oversize detections collapse into one row regardless
 * of how many checks have fired.
 *
 * IMPORTANT: this watchdog NEVER prunes the store or changes the retention
 * window. The oversize condition stays visible as a diagnostic signal — the
 * operator must act.
 */

import { openLibsql } from '../lib/libsql'
import { type ActionQueueKind, raiseActionQueueItem } from '../lib/action-queue'

export const OBSERVABILITY_WATCHDOG_KIND: ActionQueueKind = 'observability-store-oversize'

/** 500 MB in bytes. */
export const OVERSIZE_THRESHOLD_BYTES = 500 * 1024 * 1024

const OVERSIZE_SIGNATURE = 'observability-store-oversize'

/**
 * Return the total size in bytes of all pages belonging to the `trace_events`
 * table inside the SQLite database at `stateDbPath`, using the `dbstat`
 * virtual table. Returns 0 if the table does not exist or the query fails.
 */
const measureStoreSizeBytes = async (stateDbPath: string): Promise<number> => {
  const client = openLibsql({ url: `file:${stateDbPath}` })
  try {
    const result = await client.execute(
      "SELECT COALESCE(SUM(pgsize), 0) AS total FROM dbstat WHERE name='trace_events'",
    )
    return Number(result.rows[0]?.total ?? 0)
  } catch {
    return 0
  } finally {
    client.close()
  }
}

/**
 * Build the human-readable action-queue item body for an oversize detection.
 * Exported so tests can verify the exact wording without coupling to the
 * surrounding raise logic.
 */
export const buildOversizeBody = (sizeBytes: number): string => {
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1)
  return (
    `The trace_events table in mars.db is ${sizeMb} MB, which exceeds the 500 MB warning threshold. ` +
    `No data has been pruned automatically. Investigate for a runaway daemon or telemetry-capture bug.`
  )
}

/**
 * Check the trace_events footprint in mars.db and raise an action-queue item
 * if oversize.
 *
 * @param stateDbPath  Absolute path to the mars.db SQLite file.
 * @param getSizeBytes Size-measurer function. Defaults to the real dbstat
 *                     implementation; pass a stub in tests.
 * @returns The action-queue item id when an item was raised or bumped, or `null` if
 *          the store is within the 500 MB threshold.
 */
export const checkObservabilityStoreSize = async (
  stateDbPath: string,
  getSizeBytes: (path: string) => Promise<number> = measureStoreSizeBytes,
): Promise<string | null> => {
  const sizeBytes = await getSizeBytes(stateDbPath)
  if (sizeBytes < OVERSIZE_THRESHOLD_BYTES) return null

  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1)
  const id = await raiseActionQueueItem({
    kind: OBSERVABILITY_WATCHDOG_KIND,
    category: 'daemon',
    priority: 'high',
    title: `Observability store oversize: ${sizeMb} MB (threshold: 500 MB)`,
    body: buildOversizeBody(sizeBytes),
    payload: { sizeBytes, sizeMb: Number(sizeMb) },
    context: { stateDbPath },
    raisedBy: 'daemon:observability-watchdog',
    signature: OVERSIZE_SIGNATURE,
    occurrence: {
      sizeBytes,
      sizeMb: Number(sizeMb),
      detectedAt: new Date().toISOString(),
    },
  })
  return id
}
