/**
 * Periodically checks the observability store (observability.duckdb) size on
 * disk. When the store exceeds 500 MB, a single open inbox item is raised so
 * the operator notices a runaway daemon or telemetry-capture bug.
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

import { stat } from 'node:fs/promises'
import { type InboxKind, raiseInboxItem } from '../lib/inbox'

export const OBSERVABILITY_WATCHDOG_KIND: InboxKind = 'observability-store-oversize'

/** 500 MB in bytes. */
export const OVERSIZE_THRESHOLD_BYTES = 500 * 1024 * 1024

const OVERSIZE_SIGNATURE = 'observability-store-oversize'

/**
 * Return the total size in bytes of all observability store files:
 * the main .duckdb file and its WAL companion if present. Returns 0
 * if neither file exists.
 */
const measureStoreSizeBytes = async (observabilityDbPath: string): Promise<number> => {
  const candidates = [observabilityDbPath, `${observabilityDbPath}.wal`]
  let total = 0
  for (const p of candidates) {
    const size = await stat(p)
      .then((s) => (s.isFile() ? s.size : 0))
      .catch(() => 0)
    total += size
  }
  return total
}

/**
 * Build the human-readable inbox item body for an oversize detection.
 * Exported so tests can verify the exact wording without coupling to the
 * surrounding raise logic.
 */
export const buildOversizeBody = (sizeBytes: number): string => {
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1)
  return (
    `The observability store is ${sizeMb} MB, which exceeds the 500 MB warning threshold. ` +
    `No data has been pruned automatically. Investigate for a runaway daemon or telemetry-capture bug.`
  )
}

/**
 * Check the observability store size and raise an inbox item if oversize.
 *
 * @param observabilityDbPath  Absolute path to the observability.duckdb file.
 * @param getSizeBytes         Size-measurer function. Defaults to the real
 *                             fs-stat implementation; pass a stub in tests.
 * @returns The inbox item id when an item was raised or bumped, or `null` if
 *          the store is within the 500 MB threshold.
 */
export const checkObservabilityStoreSize = async (
  observabilityDbPath: string,
  getSizeBytes: (path: string) => Promise<number> = measureStoreSizeBytes,
): Promise<string | null> => {
  const sizeBytes = await getSizeBytes(observabilityDbPath)
  if (sizeBytes < OVERSIZE_THRESHOLD_BYTES) return null

  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1)
  const id = await raiseInboxItem({
    kind: OBSERVABILITY_WATCHDOG_KIND,
    category: 'daemon',
    priority: 'high',
    title: `Observability store oversize: ${sizeMb} MB (threshold: 500 MB)`,
    body: buildOversizeBody(sizeBytes),
    payload: { sizeBytes, sizeMb: Number(sizeMb) },
    context: { observabilityDbPath },
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
