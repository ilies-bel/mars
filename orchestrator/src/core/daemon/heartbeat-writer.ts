/**
 * Daemon liveness heartbeat writer.
 *
 * On start, upserts a single row in `daemon_heartbeat` (id=1) with the
 * current pid and boot timestamp. A recurring interval then updates
 * `last_beat_ts` so external observers can detect a stale/dead daemon.
 *
 * The interval is env-tunable via MARS_HEARTBEAT_MS (default 5 000 ms).
 * The timer is `.unref()`'d so it never prevents a clean shutdown.
 * Call `stop()` during shutdown to cancel the interval explicitly.
 */

import type { DbClient } from '../lib/db.js'

export interface HeartbeatHandle {
  stop: () => void
}

export interface HeartbeatDeps {
  db: DbClient
  /** Injectable for tests; defaults to `() => new Date()`. */
  now?: () => Date
}

/**
 * Start the heartbeat writer. Awaiting this resolves only after the
 * boot-row upsert has landed in the DB, so callers can immediately
 * read the row after the await.
 */
export const startHeartbeatWriter = async (
  deps: HeartbeatDeps,
): Promise<HeartbeatHandle> => {
  const { db } = deps
  const now = deps.now ?? (() => new Date())
  const intervalMs = Number(process.env.MARS_HEARTBEAT_MS ?? 5_000)

  // Upsert the boot row synchronously so callers see a fresh row
  // immediately after await.
  const boot = now()
  await db.execute({
    sql: `INSERT INTO daemon_heartbeat (id, pid, boot_ts, last_beat_ts)
          VALUES (1, $1, $2, $2)
          ON CONFLICT (id) DO UPDATE
            SET pid          = EXCLUDED.pid,
                boot_ts      = EXCLUDED.boot_ts,
                last_beat_ts = EXCLUDED.last_beat_ts`,
    args: [process.pid, boot.toISOString()],
  })

  const timer = setInterval(() => {
    void db.execute({
      sql: `UPDATE daemon_heartbeat SET last_beat_ts = $1 WHERE id = 1`,
      args: [now().toISOString()],
    })
  }, intervalMs)

  // Do not hold the event loop open once the daemon shuts down.
  timer.unref()

  return { stop: () => clearInterval(timer) }
}
