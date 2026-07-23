/**
 * DB busy-storm watchdog — daemon-level escalation.
 *
 * The 2026-07-03 incident: a stranded write transaction held for 40 minutes
 * starved every daemon subsystem. The lib-level tracker (`lib/db-busy-watchdog`)
 * counts errors; this module translates the count into staged daemon actions:
 *
 *   Stage 0 → (no storm)    : nothing.
 *   Stage 1 → 'warn'        : log loudly so the operator sees it immediately.
 *   Stage 2 → 'recycle'     : attempt a connection-pool recycle via `recyclePool`;
 *                             a transient deadlock burst that resolves itself after
 *                             the pool refresh never reaches stage 3.
 *   Stage 3 → 'restart'     : trigger a graceful daemon self-restart. Safe because
 *                             the mars-c11be862 branch-deletion fix ensures that
 *                             in-flight tasks with committed work are re-queued
 *                             (not lost). Gated by MARS_DB_BUSY_STORM_RESTART
 *                             (default 'true'); set to 'false' to disable.
 *
 * Each stage fires on a separate watchdog tick (default: every 30 s via
 * MARS_DB_BUSY_WATCHDOG_MS).  The daemon passes `currentStage` (its local
 * variable) to the function and updates it from the returned `nextStage`.
 * When the storm clears, `nextStage` resets to `null` and the cycle can repeat.
 *
 * Status: self-restart ENABLED by default (mars-c11be862 has landed).
 * Disable via `MARS_DB_BUSY_STORM_RESTART=false` if needed.
 */

import { getDbBusyStatus } from '../lib/db-busy-watchdog.js'

/** The stage the daemon is currently at in the escalation sequence. */
export type BusyEscalationStage = 'warn' | 'recycle' | 'restart'

export interface BusyEscalationResult {
  /** Stage to persist for the next watchdog tick; null means storm cleared. */
  nextStage: BusyEscalationStage | null
  /** What this tick actually did. */
  action: 'none' | 'logged' | 'recycled' | 'restarted'
}

/**
 * Check the current DB busy-error count and advance the escalation sequence
 * by one stage.
 *
 * @param dbTarget      Database target string (DSN or PGlite key) passed to
 *                      `recyclePool`.
 * @param log           The daemon's log function.
 * @param recyclePool   Closes and evicts the DB pool entry so the next openDb
 *                      call creates a fresh backend. Injected for testability.
 * @param triggerRestart Initiates a graceful daemon restart. Injected for
 *                      testability.
 * @param currentStage  The stage recorded from the previous watchdog tick
 *                      (null on the first tick or after a storm clears).
 * @param nowMs         Current timestamp override (tests only).
 */
export async function checkAndEscalateDbBusyStorm(
  dbTarget: string,
  log: (msg: string) => void,
  recyclePool: (target: string) => Promise<void>,
  triggerRestart: () => void,
  currentStage: BusyEscalationStage | null,
  nowMs?: number,
): Promise<BusyEscalationResult> {
  const status = getDbBusyStatus(nowMs)

  if (!status.stormDetected) {
    // Storm cleared (or never started) — reset escalation sequence.
    return { nextStage: null, action: 'none' }
  }

  const windowSec = Math.round(status.windowMs / 1_000)
  const { errorCount } = status

  if (currentStage === null) {
    // Stage 1: log loudly so the operator can see it in watch.log and the
    // action queue. No side effects yet — give the pool a chance to recover
    // on its own before we intervene.
    log(
      `[db-busy-watchdog] STORM DETECTED: ${errorCount} DB error(s) in the last ${windowSec}s — ` +
        `dispatch and outbox passes may be stalled (deadlock-retry budget exhausted). ` +
        `Will attempt connection-pool recycle on the next watchdog tick ` +
        `(${Math.round(resolvedWatchdogMs() / 1_000)}s).`,
    )
    return { nextStage: 'warn', action: 'logged' }
  }

  if (currentStage === 'warn') {
    // Stage 2: attempt a pool recycle. If the deadlock burst was transient and
    // the pool was merely slow to drain, fresh connections will clear the storm
    // and the next tick will see stormDetected = false.
    log(
      `[db-busy-watchdog] storm persists (${errorCount} error(s) in ${windowSec}s); ` +
        `attempting connection-pool recycle for target '${dbTarget}'.`,
    )
    await recyclePool(dbTarget).catch((err: unknown) => {
      log(
        `[db-busy-watchdog] pool recycle failed: ${(err as Error).message}; ` +
          `proceeding to restart stage.`,
      )
    })
    return { nextStage: 'recycle', action: 'recycled' }
  }

  if (currentStage === 'recycle') {
    // Stage 3: pool recycle did not clear the storm. Trigger a daemon restart
    // so a fresh process starts with a clean connection pool.
    //
    // mars-c11be862 (branch-deletion fix) has landed: the restart re-queue path
    // preserves branches with committed work, so self-restart is safe by default.
    // Disable via MARS_DB_BUSY_STORM_RESTART=false if needed (e.g. debugging).
    const restartEnabled = process.env.MARS_DB_BUSY_STORM_RESTART !== 'false'
    if (!restartEnabled) {
      log(
        `[db-busy-watchdog] storm persists (${errorCount} error(s) in ${windowSec}s); ` +
          `self-restart suppressed by MARS_DB_BUSY_STORM_RESTART=false. ` +
          `Restart the daemon manually to clear the DB connection storm.`,
      )
      return { nextStage: 'recycle', action: 'none' }
    }
    log(
      `[db-busy-watchdog] storm persists after pool recycle (${errorCount} error(s) in ${windowSec}s); ` +
        `triggering daemon self-restart to recover clean DB connections.`,
    )
    triggerRestart()
    return { nextStage: 'restart', action: 'restarted' }
  }

  // currentStage === 'restart': daemon is in the process of restarting;
  // avoid triggering a second restart.
  return { nextStage: 'restart', action: 'none' }
}

/** Default watchdog interval in ms, used in the log message for the operator. */
const resolvedWatchdogMs = (): number => {
  const raw = process.env.MARS_DB_BUSY_WATCHDOG_MS
  if (!raw) return 30_000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 30_000
}
