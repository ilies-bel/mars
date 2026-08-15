/**
 * Daemon-outage alert: on daemon start, if the gap between the last heartbeat
 * and the current boot exceeds `MARS_DAEMON_OUTAGE_THRESHOLD_MS` (default
 * 30 min), raise a single `daemon-outage` action-queue row naming the outage
 * window and the count of tasks that were queued while the daemon was dead.
 *
 * This turns a silent outage into a recorded one. Without it, the operator
 * discovers the downtime only by running a `mars` command and getting
 * "action queue: daemon not running" — or, after the daemon restarts, by
 * seeing a wall of per-task `stale-queued` rows with no summary of what
 * caused them.
 *
 * The item is signature-keyed on `'daemon-outage'` (no origin task), so
 * repeated outages before an acknowledgement bump `seen_count` on the same
 * open row rather than inserting siblings.
 *
 * The `prev_gap_ms` field in `daemon_heartbeat` (written by
 * `startHeartbeatWriter` at each boot) is the authoritative source for the
 * outage duration: it is computed as `Date.now() - prevHb.lastBeatTs` in
 * `server.ts` before the heartbeat writer upserts the row, so it is available
 * in the `daemon_heartbeat` table by the time reconcilers run.
 */

import { resolveStateClient } from '../store/state-client'
import { listTasks } from '../queue'
import { raiseActionQueueItem, supersedeActionQueueItemsBySignature } from '../lib/action-queue'
import type { ActionQueueKind } from '../lib/action-queue-kinds'

export const DAEMON_OUTAGE_KIND: ActionQueueKind = 'daemon-outage'

/** Default threshold: 30 minutes. */
export const DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS = 30 * 60_000

const resolvedThresholdMs = (): number => {
  const raw = process.env.MARS_DAEMON_OUTAGE_THRESHOLD_MS
  if (!raw) return DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_OUTAGE_THRESHOLD_MS
}

/**
 * Read the outage info from the current `daemon_heartbeat` row (id = 1).
 * Returns null when:
 *  - no heartbeat row exists yet (first-ever boot),
 *  - `prev_gap_ms` is null or zero (clean restart with no meaningful gap),
 *  - the gap is below the configured threshold.
 */
const readOutageInfo = async (thresholdMs: number): Promise<{
  prevGapMs: number
  lastBeatAt: string
  detectedAt: string
} | null> => {
  const c = resolveStateClient()
  const result = await c.execute(
    'SELECT boot_ts, prev_gap_ms FROM daemon_heartbeat WHERE id = 1',
  )
  if (result.rows.length === 0) return null

  const row = result.rows[0]
  const prevGapRaw = (row as Record<string, unknown>).prev_gap_ms
  if (prevGapRaw === null || prevGapRaw === undefined) return null

  const prevGapMs = Number(prevGapRaw)
  if (!Number.isFinite(prevGapMs) || prevGapMs <= 0 || prevGapMs < thresholdMs) return null

  const bootTs = new Date((row as Record<string, unknown>).boot_ts as string).getTime()
  return {
    prevGapMs,
    lastBeatAt: new Date(bootTs - prevGapMs).toISOString(),
    detectedAt: new Date(bootTs).toISOString(),
  }
}

/**
 * If the gap between the last heartbeat and the current boot exceeds the
 * threshold, raise a `daemon-outage` action-queue item. Returns the item id
 * raised (or bumped on re-detection), or `null` when the gap is below the
 * threshold or no heartbeat row exists.
 */
export const detectAndRaiseDaemonOutage = async (): Promise<string | null> => {
  const threshold = resolvedThresholdMs()
  let outage: { prevGapMs: number; lastBeatAt: string; detectedAt: string } | null = null

  try {
    outage = await readOutageInfo(threshold)
  } catch {
    // DB read failure is non-fatal — skip the alert rather than crashing boot.
    return null
  }
  if (outage === null) return null

  // Count queued tasks that accumulated while the daemon was dead.
  let strandedCount = 0
  try {
    const queued = await listTasks('queued')
    strandedCount = queued.length
  } catch {
    // Non-fatal: outage row still raised without the count.
  }

  const outageMinutes = Math.round(outage.prevGapMs / 60_000)

  const id = await raiseActionQueueItem({
    kind: DAEMON_OUTAGE_KIND,
    category: 'daemon',
    priority: 'high',
    title: `Daemon was offline ~${outageMinutes} min (${strandedCount} task(s) queued)`,
    body: [
      `The Mars daemon was offline for approximately ${outageMinutes} min.`,
      `Last heartbeat: ${outage.lastBeatAt}`,
      `Daemon restarted: ${outage.detectedAt}`,
      '',
      strandedCount > 0
        ? `${strandedCount} task(s) were queued when the daemon came back up.`
        : 'No tasks were waiting when the daemon came back up.',
      '',
      'Recovery:',
      '  • Daemon has restarted — queued tasks will be dispatched automatically.',
      '  • Run `mars list` to review tasks that accumulated during the outage.',
      '  • Run `mars action-queue list open --kind stale-queued` to see per-task stale alerts.',
    ].join('\n'),
    payload: {
      outageMs: outage.prevGapMs,
      lastBeatAt: outage.lastBeatAt,
      detectedAt: outage.detectedAt,
      strandedTaskCount: strandedCount,
    },
    context: {},
    raisedBy: 'daemon:daemon-outage-sweep',
    signature: 'daemon-outage',
    occurrence: {
      outageMs: outage.prevGapMs,
      strandedTaskCount: strandedCount,
      detectedAt: outage.detectedAt,
    },
  })

  return id
}

/**
 * Close every open `daemon-outage` action-queue row.
 *
 * Called at daemon startup after {@link detectAndRaiseDaemonOutage} so that
 * the action queue never shows a stale outage row from a prior daemon
 * lifetime. By definition the outage is over the moment the daemon boots —
 * the row's content is preserved in `action_queue_history` for audit.
 *
 * Returns the ids of the rows that were closed (possibly empty when no
 * open rows exist, which is the common case after a clean restart).
 */
export const closeOpenDaemonOutageRows = async (): Promise<string[]> => {
  return supersedeActionQueueItemsBySignature(
    DAEMON_OUTAGE_KIND,
    'daemon-outage',
    'daemon-restarted',
    'daemon:startup-reconcile',
  )
}
