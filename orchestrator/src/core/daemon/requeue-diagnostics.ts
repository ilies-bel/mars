/**
 * requeue-diagnostics — pure helpers for diagnosing step-level retry loops.
 *
 * These helpers are consumed by the requeue-ceiling escalation path (and its
 * future successors) to surface per-step retry context that the top-level
 * task-age window cannot express:
 *
 * - {@link computeStepWindow} — the earliest → latest startedAt for the step
 *   that has been retried the most.
 * - {@link computeAttemptDensity} — how many attempts per minute within that
 *   window (useful to distinguish a slow-but-making-progress task from a tight
 *   hot loop).
 * - {@link computeBlockedWaitMs} — total time (ms) the task was parked in
 *   status='blocked', derived from task.blocked / task.queued event pairs in
 *   the outbox events table.
 *
 * All three are pure or near-pure (computeBlockedWaitMs reads the DB) and are
 * intentionally not wired into {@link checkAndEscalateRequeueCeiling} yet — that
 * is done in a later slice.
 */

import type { StepRecord } from '@mars/workflow'
import { resolveQueueClient, ensureQueueSchema } from '../queue'
import type { Task } from '../queue'

// ── Tuning constants ──────────────────────────────────────────────────────────

/**
 * Minimum attempt density (attempts per minute) that classifies a breach as
 * a hot retry churn. Configurable via `MARS_REQUEUE_DENSITY_FLOOR_PER_MIN`;
 * defaults to 1 attempt/minute.
 */
export const DENSITY_FLOOR_PER_MIN: number = Number(
  process.env.MARS_REQUEUE_DENSITY_FLOOR_PER_MIN ?? 1,
)

/**
 * Minimum fraction of elapsed time spent in `status='blocked'` that
 * classifies a breach as a blocked-wait pattern. Configurable via
 * `MARS_REQUEUE_BLOCKED_RATIO`; defaults to 0.5 (50%).
 */
export const BLOCKED_WAIT_RATIO: number = Number(
  process.env.MARS_REQUEUE_BLOCKED_RATIO ?? 0.5,
)

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Describes the retry window for the failing step (the step with the highest
 * attempt count in a run's step list).
 */
export interface StepWindow {
  /** Earliest non-zero startedAt among the failing step's records (ms). */
  firstAttemptStartedAt: number
  /** Latest non-zero startedAt among the failing step's records (ms). */
  lastAttemptStartedAt: number
  /** lastAttemptStartedAt − firstAttemptStartedAt (ms). */
  spanMs: number
  /** Total number of times the failing step has been attempted. */
  attemptCount: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Identify the failing step (the step with the highest `attempt` count) from
 * `steps` and compute its retry window.
 *
 * Because the workflow store uses an upsert-on-conflict strategy, a run
 * typically produces at most one StepRecord per step name. Passing multiple
 * records with the same step name (e.g. in tests) is handled: first/last
 * startedAt are derived from the full set of matching records.
 *
 * Returns `null` when `steps` is empty or when no step has ever been attempted
 * (all `attempt` values are 0).
 */
export const computeStepWindow = (steps: StepRecord[]): StepWindow | null => {
  if (steps.length === 0) return null

  const maxAttempt = Math.max(...steps.map((s) => s.attempt))
  if (maxAttempt === 0) return null

  // Pick the step name whose record carries the highest attempt count.
  const failingStepName = steps.find((s) => s.attempt === maxAttempt)!.name

  // Reduce all records for that step name to a first/last startedAt window.
  const stepRecords = steps.filter((s) => s.name === failingStepName)
  const validTimestamps = stepRecords.map((s) => s.startedAt).filter((ts) => ts > 0)

  const attemptCount = maxAttempt

  if (validTimestamps.length === 0) {
    return { firstAttemptStartedAt: 0, lastAttemptStartedAt: 0, spanMs: 0, attemptCount }
  }

  const firstAttemptStartedAt = Math.min(...validTimestamps)
  const lastAttemptStartedAt = Math.max(...validTimestamps)
  const spanMs = lastAttemptStartedAt - firstAttemptStartedAt

  return { firstAttemptStartedAt, lastAttemptStartedAt, spanMs, attemptCount }
}

/**
 * Compute attempt density in **attempts per minute** for the given step window.
 *
 * The denominator is `max(spanMs / 60_000, 1)` so a zero-span window (single
 * data point, or all timestamps missing) yields `attemptCount` attempts/minute
 * rather than dividing by zero.
 */
export const computeAttemptDensity = (w: StepWindow): number => {
  return w.attemptCount / Math.max(w.spanMs / 60_000, 1)
}

/**
 * Sum the total time (ms) the task has spent in status='blocked'.
 *
 * Pairs `task.blocked` → `task.queued` event timestamps from the outbox
 * `events` table (ordered by insertion id). If the task is currently blocked
 * (no subsequent `task.queued` event closes the last interval), `nowMs` is
 * used as the interval end.
 *
 * The events table stores `ts` in **whole seconds** (PostgreSQL
 * `floor(extract(epoch from now()))::bigint`); durations are returned in **ms**
 * by multiplying the second-resolution deltas by 1 000.
 *
 * @param taskId - The task whose blocked-wait time to measure.
 * @param nowMs  - Injectable clock (ms since epoch); closes any open interval.
 */
export const computeBlockedWaitMs = async (
  taskId: string,
  nowMs: number,
): Promise<number> => {
  await ensureQueueSchema()
  const client = resolveQueueClient()

  const result = await client.execute({
    sql: `SELECT type, ts
            FROM events
           WHERE type IN ('task.blocked', 'task.queued')
             AND payload::jsonb ->> 'taskId' = ?
           ORDER BY id ASC`,
    args: [taskId],
  })

  const rows = result.rows as unknown as Array<{ type: string; ts: number | bigint }>

  let totalMs = 0
  let blockedSinceSec: number | null = null

  for (const row of rows) {
    const tsSec = Number(row.ts)
    if (row.type === 'task.blocked') {
      // Start (or restart) a blocked interval. Overwriting a prior open
      // interval is defensive: in normal operation task.queued always closes
      // the previous interval before another task.blocked is emitted.
      blockedSinceSec = tsSec
    } else if (row.type === 'task.queued' && blockedSinceSec !== null) {
      totalMs += (tsSec - blockedSinceSec) * 1_000
      blockedSinceSec = null
    }
  }

  // If the task is still in a blocked interval, count to nowMs.
  if (blockedSinceSec !== null) {
    totalMs += nowMs - blockedSinceSec * 1_000
  }

  return totalMs
}

// ── Breach classifier ─────────────────────────────────────────────────────────

/**
 * Discriminated union describing why a requeue-ceiling breach occurred.
 *
 * - `retry-churn`       — attempt density is above the floor; the task is in a
 *                         tight hot loop (≥ {@link DENSITY_FLOOR_PER_MIN} per min).
 * - `blocked-wait`      — the majority of elapsed time was spent in
 *                         `status='blocked'` (≥ {@link BLOCKED_WAIT_RATIO} of
 *                         `elapsedMs`).
 * - `queue-starvation`  — very few attempts (≤ 2), no blocked wait, but the
 *                         task hasn't made progress — the queue may be starved.
 * - `long-running`      — a single healthy attempt is still executing slowly;
 *                         not a retry churn.
 */
export type RequeueBreachClass = {
  kind: 'retry-churn' | 'blocked-wait' | 'queue-starvation' | 'long-running'
  reason: string
}

/**
 * Classify a requeue-ceiling breach into an actionable kind.
 *
 * This is a **pure function** — it accepts pre-computed diagnostics and has
 * no side effects or DB calls.
 *
 * Priority order:
 * 1. High attempt density AND more than two retries → `retry-churn`
 * 2. High blocked-wait ratio → `blocked-wait`
 * 3. Very few retries with zero blocked wait → `queue-starvation`
 * 4. Otherwise → `long-running`
 *
 * @param t           - The task being evaluated (used for diagnostics labels).
 * @param window      - Pre-computed step window from {@link computeStepWindow}
 *                      (null if no steps have been attempted).
 * @param blockedWaitMs - Total ms the task has spent in `status='blocked'`,
 *                        from {@link computeBlockedWaitMs}.
 * @param elapsedMs   - Total elapsed ms since the first attempt (or task
 *                      creation); the caller computes this from the ceiling
 *                      anchor.
 */
export const classifyRequeueBreach = (
  t: Task,
  window: StepWindow | null,
  blockedWaitMs: number,
  elapsedMs: number,
): RequeueBreachClass => {
  const density = window != null ? computeAttemptDensity(window) : 0
  const attemptCount = window?.attemptCount ?? 0

  if (t.recoverySpawnedCount > 2 && density >= DENSITY_FLOOR_PER_MIN) {
    return {
      kind: 'retry-churn',
      reason:
        `task ${t.id}: attempt density ${density.toFixed(2)}/min ≥ floor ` +
        `${DENSITY_FLOOR_PER_MIN}/min (${attemptCount} attempt(s))`,
    }
  }

  if (elapsedMs > 0 && blockedWaitMs / elapsedMs >= BLOCKED_WAIT_RATIO) {
    const pct = Math.round((blockedWaitMs / elapsedMs) * 100)
    return {
      kind: 'blocked-wait',
      reason:
        `task ${t.id}: ${pct}% of elapsed time blocked ` +
        `(${blockedWaitMs}ms blocked / ${elapsedMs}ms elapsed)`,
    }
  }

  if (attemptCount <= 2 && blockedWaitMs === 0) {
    return {
      kind: 'queue-starvation',
      reason:
        `task ${t.id}: ${attemptCount} attempt(s) with no blocked wait — ` +
        `sparse progress suggests queue starvation`,
    }
  }

  return {
    kind: 'long-running',
    reason:
      `task ${t.id}: ${attemptCount} attempt(s) over ` +
      `${Math.round(elapsedMs / 60_000)}m — healthy attempt or slow progress`,
  }
}
