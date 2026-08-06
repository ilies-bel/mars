/**
 * Presence tracker — derives away→present transitions from UI client heartbeats.
 *
 * The UI client posts a ping to POST /presence at a regular cadence. Each ping
 * is compared against the stored last-seen timestamp; when the gap meets or
 * exceeds `thresholdMs`, one `presence_transitions` row is written to mark that
 * the operator has returned after an away period. Subsequent close-together
 * pings produce no further rows until another long gap occurs.
 *
 * Two exports:
 *   - `detectTransition` — pure function, testable without a DB.
 *   - `recordPing`       — stateful; reads/writes `presence_pings` and writes
 *                          to `presence_transitions` when a transition is found.
 */

import type { DbClient } from '../lib/db.js'
import { publishWithRetry } from '../../bus/publisher.js'

/**
 * Returns `true` when the gap between `prev` and `next` (epoch-milliseconds)
 * equals or exceeds `thresholdMs`, signalling an away→present transition.
 * Returns `false` when `prev` is `null` — the first-ever ping has no prior
 * away period to close.
 */
export function detectTransition(
  prev: number | null,
  next: number,
  thresholdMs: number,
): boolean {
  if (prev === null) return false
  return next - prev >= thresholdMs
}

/**
 * Record a presence ping at `ts` (epoch-milliseconds). Reads the previous
 * last-seen value from `presence_pings`, detects a transition via
 * `detectTransition`, writes one row to `presence_transitions` when a
 * transition is found, then upserts the new last-seen timestamp.
 *
 * Idempotent within a ping burst: once the stored `last_seen_ms` is updated to
 * `ts`, the next call with the same `ts` sees a zero gap and writes nothing.
 */
export async function recordPing(
  db: DbClient,
  ts: number,
  thresholdMs: number,
): Promise<void> {
  const pingResult = await db.execute(
    'SELECT last_seen_ms FROM presence_pings WHERE id = 1',
  )
  const prev =
    pingResult.rows.length > 0
      ? Number(pingResult.rows[0].last_seen_ms)
      : null

  if (detectTransition(prev, ts, thresholdMs)) {
    const transitionResult = await db.execute({
      sql: `INSERT INTO presence_transitions (from_ms, to_ms, threshold_ms, recorded_at)
            VALUES (?, ?, ?, ?)
            RETURNING id`,
      args: [prev!, ts, thresholdMs, Date.now()],
    })
    const transitionId = Number(transitionResult.rows[0].id)
    await publishWithRetry(db, 'presence.transition', {
      transitionId,
      fromMs: prev!,
      toMs: ts,
    })
  }

  await db.execute(
    `INSERT INTO presence_pings (id, last_seen_ms)
     VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET last_seen_ms = EXCLUDED.last_seen_ms`,
    [ts],
  )
}
