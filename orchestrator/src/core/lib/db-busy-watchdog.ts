/**
 * Central DB busy-error tracker for the busy-storm watchdog.
 *
 * The 2026-07-03 incident: a stranded write transaction starved every daemon
 * subsystem (dispatch poll, outbox sweep, WAL checkpoint, transcript streaming)
 * for 40+ minutes without any automatic recovery. This module counts
 * consecutive DB errors (deadlock exhaustion in the PostgreSQL era; the
 * SQLITE_BUSY equivalent) within a sliding time window so the daemon can
 * detect a "busy storm" and escalate.
 *
 * Chokepoint: `db.ts` calls `recordDbBusyError` whenever `withDeadlockRetry`
 * exhausts its retry budget.  The daemon reads `getDbBusyStatus()` on its
 * periodic watchdog tick and escalates through three stages:
 *   1. Log loudly.
 *   2. Attempt a connection-pool recycle.
 *   3. Self-restart (safe since the mars-c11be862 re-queue fix landed).
 *
 * Thresholds are tunable via environment variables so integration tests and
 * operators can adjust sensitivity without code changes.
 */

/**
 * Number of errors within the window before a storm is declared.
 * Default 10 — a single deadlock burst (1–2 retries) should not trigger;
 * a sustained wedge of 10 exhausted-retry failures in 60 s is abnormal.
 */
const resolvedThreshold = (): number => {
  const raw = process.env.MARS_BUSY_STORM_THRESHOLD
  if (!raw) return 10
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 10
}

/**
 * Sliding window length in ms. Default 60 000 (1 minute).
 * Errors older than `windowMs` ago do not count toward the threshold.
 */
const resolvedWindowMs = (): number => {
  const raw = process.env.MARS_BUSY_STORM_WINDOW_MS
  if (!raw) return 60_000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 60_000
}

/** Sliding window of error timestamps (epoch ms, sorted ascending). */
const errorTimestamps: number[] = []

/**
 * Record one DB-contention error.
 *
 * @param _source Caller label (e.g. `'deadlock:exhausted'`) — for tracing;
 *                currently unused but kept in the signature so future logging
 *                can include it without a breaking change.
 * @param nowMs   Override for the current timestamp (tests only).
 */
export function recordDbBusyError(_source: string, nowMs?: number): void {
  const now = nowMs ?? Date.now()
  errorTimestamps.push(now)
  pruneExpiredEntries(now)
}

function pruneExpiredEntries(nowMs: number): void {
  const cutoff = nowMs - resolvedWindowMs()
  // errorTimestamps is append-only and monotonically increasing, so the
  // expired prefix is always a contiguous leading slice.
  let i = 0
  while (i < errorTimestamps.length && errorTimestamps[i]! < cutoff) i += 1
  if (i > 0) errorTimestamps.splice(0, i)
}

export interface DbBusyStatus {
  /** Number of errors recorded within the current sliding window. */
  errorCount: number
  /** The window length in ms (resolved from env or default). */
  windowMs: number
  /** True when `errorCount` has reached or exceeded the storm threshold. */
  stormDetected: boolean
}

/**
 * Return the current busy-storm status based on errors within the window.
 *
 * @param nowMs Override for the current timestamp (tests only).
 */
export function getDbBusyStatus(nowMs?: number): DbBusyStatus {
  const now = nowMs ?? Date.now()
  pruneExpiredEntries(now)
  const errorCount = errorTimestamps.length
  return {
    errorCount,
    windowMs: resolvedWindowMs(),
    stormDetected: errorCount >= resolvedThreshold(),
  }
}

/**
 * Reset all module-level state. Tests only — never call in production code.
 */
export function __resetDbBusyStateForTests(): void {
  errorTimestamps.length = 0
}
