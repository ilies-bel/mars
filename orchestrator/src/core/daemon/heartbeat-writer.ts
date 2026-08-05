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
  /** Persist the settled counter before a graceful daemon shutdown. */
  flush: () => Promise<void>
  /** Whether this live daemon is currently able to dispatch queued work. */
  setDispatchEnabled: (enabled: boolean) => void
  /** Cumulative dispatch-enabled uptime, including the current live interval. */
  getDispatchUptimeMs: () => number
}

export interface HeartbeatDeps {
  db: DbClient
  /** Receives non-fatal heartbeat write failures while the daemon is running. */
  log?: (message: string) => void
  /** Injectable for tests; defaults to `() => new Date()`. */
  now?: () => Date
  /**
   * Milliseconds the daemon was offline before this boot, computed as
   * `boot_ts - prevLastBeatTs` by the caller. Written to `prev_gap_ms` on
   * the heartbeat row so watchdogs can rebase task deadlines.
   * Defaults to `null` (no outage recorded) when omitted.
   */
  prevGapMs?: number
  /** Cumulative dispatch uptime carried forward from the previous daemon. */
  dispatchUptimeMs?: number
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
  const prevGapMs = deps.prevGapMs ?? null
  let dispatchUptimeMs = deps.dispatchUptimeMs ?? 0
  let dispatchEnabled = false
  let stopped = false
  let lastObservedMs = now().getTime()

  const settleDispatchUptime = (): number => {
    const observedMs = now().getTime()
    if (dispatchEnabled) {
      dispatchUptimeMs += Math.max(0, observedMs - lastObservedMs)
    }
    lastObservedMs = observedMs
    return dispatchUptimeMs
  }

  // Upsert the boot row synchronously so callers see a fresh row
  // immediately after await.
  const boot = now()
  lastObservedMs = boot.getTime()
  await db.execute({
    sql: `INSERT INTO daemon_heartbeat (id, pid, boot_ts, last_beat_ts, prev_gap_ms, dispatch_uptime_ms)
          VALUES (1, $1, $2, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE
            SET pid          = EXCLUDED.pid,
                boot_ts      = EXCLUDED.boot_ts,
                last_beat_ts = EXCLUDED.last_beat_ts,
                prev_gap_ms  = EXCLUDED.prev_gap_ms,
                dispatch_uptime_ms = EXCLUDED.dispatch_uptime_ms`,
    args: [process.pid, boot.toISOString(), prevGapMs, dispatchUptimeMs],
  })

  const persistHeartbeat = async (timestamp: Date, uptimeMs: number): Promise<void> => {
    await db.execute({
      sql: `UPDATE daemon_heartbeat
            SET last_beat_ts = $1, dispatch_uptime_ms = $2
            WHERE id = 1`,
      args: [timestamp.toISOString(), uptimeMs],
    })
  }

  const reportWriteFailure = (err: unknown): void => {
    if (!stopped) {
      const message = err instanceof Error ? err.message : String(err)
      deps.log?.(`[heartbeat] write failed (non-fatal): ${message}`)
    }
  }

  const timer = setInterval(() => {
    const timestamp = now()
    const uptimeMs = settleDispatchUptime()
    void persistHeartbeat(timestamp, uptimeMs).catch(reportWriteFailure)
  }, intervalMs)

  // Do not hold the event loop open once the daemon shuts down.
  timer.unref()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    flush: async () => {
      const timestamp = now()
      await persistHeartbeat(timestamp, settleDispatchUptime())
    },
    setDispatchEnabled: (enabled) => {
      const timestamp = now()
      const uptimeMs = settleDispatchUptime()
      dispatchEnabled = enabled
      void persistHeartbeat(timestamp, uptimeMs).catch(reportWriteFailure)
    },
    getDispatchUptimeMs: () => settleDispatchUptime(),
  }
}
