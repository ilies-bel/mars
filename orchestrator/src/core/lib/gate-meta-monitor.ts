import type { DbResultSet, DbStatement } from './db.js'
import { raiseActionQueueItem } from './action-queue'

/**
 * Minimal write/read seam the monitor needs. Satisfied structurally by both a
 * raw {@link import('./db.js').DbClient} (the subscriber passes one to
 * {@link ensureGateMetaMonitorSchema}) and a `DomainTaskStore` (the failure
 * chokepoint threads one in), so the monitor stays decoupled from which seam
 * calls it. Only `.execute()` is used — the one method both expose identically.
 */
export interface MonitorDb {
  execute(stmt: DbStatement): Promise<DbResultSet>
}

/**
 * Verify-gate meta-monitor (incident 2026-07-03T08:15Z, draft proposal
 * acd01d23).
 *
 * A newly-enforcing verify gate whose input pipeline can silently starve must
 * not be able to fail the whole fleet identically without anyone noticing. The
 * always-on completeness gate did exactly that: it failed CLOSED for 100% of
 * tasks with the same verdict from its first live minute, and each failure
 * burned an opus recovery task.
 *
 * This module watches the stream of verify-gate verdicts. A "verdict" is the
 * verify failure signature `verify:<gate>/<error-class>` (computed by
 * {@link computeFailureSignature} in the verify primitive). When the SAME
 * verdict recurs K times consecutively across DIFFERENT origin tasks, the gate
 * is presumed broken: we
 *
 *  (a) raise exactly ONE level-triggered action-queue row for the episode
 *      (modelled on the daemon's `provider-rate-limited` row — idempotent
 *      raises bump `seen_count` instead of inserting siblings), and
 *  (b) flip the verdict to SUPPRESSED so the recovery-spawn seam stops
 *      spawning recovery tasks for failures carrying it — leaving each origin
 *      failed-but-restartable (its one recovery slot is never consumed).
 *
 * "Consecutive" is global: a single `current_verdict` is tracked, and any
 * different verdict resets the streak. "Across different tasks" means the
 * streak only advances when the failing task id differs from the last one that
 * advanced it — a single task failing the same gate twice does not count as
 * two tasks.
 */

/**
 * Number of consecutive identical verdicts (across different tasks) that trips
 * the meta-monitor. A named constant, deliberately NOT configurable: this is a
 * failure-classification safety net, not a tunable retry knob.
 */
export const GATE_VERDICT_TRIP_THRESHOLD = 5

/** Action-queue kind for the level-triggered "gate may be broken" row. */
export const GATE_BROKEN_ACTION_QUEUE_KIND = 'gate-broken' as const

/**
 * The meta-monitor tables (`gate_verdict_monitor` — a singleton streak row via
 * `CHECK (id = 1)` — and the per-verdict suppression ledger
 * `gate_suppressed_verdicts`, kept separate so a later verdict tripping the
 * monitor does not clear an earlier suppression an operator has not yet acted
 * on) are owned by the canonical schema (pg-schema.ts `ensureSchema`, applied
 * at daemon/init start). This function is retained as the historical call-site
 * seam and is now a no-op.
 */
export const ensureGateMetaMonitorSchema = async (
  _client: MonitorDb,
): Promise<void> => {
  // Schema is guaranteed by pg-schema.ts ensureSchema at startup.
}

/**
 * Historical test hook for the removed in-process "schema ensured" latch.
 * No-op since the canonical schema owns the tables.
 */
export const resetGateMetaMonitorSchemaLatchForTests = (): void => {
  // No latch remains; schema ownership moved to pg-schema.ts.
}

interface MonitorRow {
  current_verdict: string | null
  streak_count: number
  last_task_id: string | null
}

const readMonitorRow = async (client: MonitorDb): Promise<MonitorRow> => {
  const r = await client.execute({
    sql: `SELECT current_verdict, streak_count, last_task_id
            FROM gate_verdict_monitor WHERE id = 1`,
    args: [],
  })
  if (r.rows.length === 0) {
    return { current_verdict: null, streak_count: 0, last_task_id: null }
  }
  return r.rows[0] as unknown as MonitorRow
}

const writeMonitorRow = async (
  client: MonitorDb,
  row: MonitorRow,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO gate_verdict_monitor
            (id, current_verdict, streak_count, last_task_id, updated_at)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            current_verdict = excluded.current_verdict,
            streak_count    = excluded.streak_count,
            last_task_id    = excluded.last_task_id,
            updated_at      = excluded.updated_at`,
    args: [
      row.current_verdict,
      row.streak_count,
      row.last_task_id,
      Date.now(),
    ],
  })
}

export interface RecordGateVerdictResult {
  /** The consecutive-across-different-tasks streak after this observation. */
  streak: number
  /** True on the observation that first pushed the streak to the threshold. */
  tripped: boolean
  /** True whenever the verdict is suppressed (including the tripping call). */
  suppressed: boolean
}

/**
 * Record one verify-gate verdict observed for `taskId` and advance the
 * consecutive-across-different-tasks streak.
 *
 * Streak rules:
 *  - A verdict different from the tracked `current_verdict` starts a fresh
 *    streak of 1 (any change of verdict resets — "consecutive" is global).
 *  - The same verdict from a DIFFERENT task advances the streak by one.
 *  - The same verdict from the SAME task (`taskId === last_task_id`) does not
 *    advance it — the requirement is distinct tasks, not distinct failures.
 *
 * On the observation that first reaches {@link GATE_VERDICT_TRIP_THRESHOLD}
 * the verdict is marked suppressed and one level-triggered action-queue row is
 * raised. Subsequent observations of an already-suppressed verdict return
 * `suppressed: true` without re-tripping.
 *
 * @returns the streak, whether this call tripped the threshold, and whether
 *          the verdict is (now) suppressed.
 */
export const recordGateVerdict = async (
  client: MonitorDb,
  taskId: string,
  verdict: string,
): Promise<RecordGateVerdictResult> => {
  await ensureGateMetaMonitorSchema(client)

  const alreadySuppressed = await isVerdictSuppressed(client, verdict)

  const row = await readMonitorRow(client)

  let streak: number
  let lastTaskId: string
  if (row.current_verdict !== verdict) {
    // Verdict changed (or first ever) → fresh streak.
    streak = 1
    lastTaskId = taskId
  } else if (row.last_task_id === taskId) {
    // Same verdict, same task — does not count as a new task. Streak holds.
    streak = row.streak_count
    lastTaskId = row.last_task_id
  } else {
    // Same verdict, different task → advance.
    streak = row.streak_count + 1
    lastTaskId = taskId
  }

  await writeMonitorRow(client, {
    current_verdict: verdict,
    streak_count: streak,
    last_task_id: lastTaskId,
  })

  // Trip on the FIRST crossing only, and only if not already suppressed (so a
  // re-observation after suppression never raises a second row or re-marks).
  const crossing = streak >= GATE_VERDICT_TRIP_THRESHOLD
  if (crossing && !alreadySuppressed) {
    await markVerdictSuppressed(client, verdict)
    await raiseGateBrokenRow(verdict, streak)
    return { streak, tripped: true, suppressed: true }
  }

  return { streak, tripped: false, suppressed: alreadySuppressed }
}

/**
 * True iff `verdict` is currently suppressed — the read the recovery-spawn
 * seam consults before deciding whether to spawn a recovery.
 */
export const isVerdictSuppressed = async (
  client: MonitorDb,
  verdict: string,
): Promise<boolean> => {
  await ensureGateMetaMonitorSchema(client)
  const r = await client.execute({
    sql: `SELECT 1 FROM gate_suppressed_verdicts WHERE verdict = ? LIMIT 1`,
    args: [verdict],
  })
  return r.rows.length > 0
}

const markVerdictSuppressed = async (
  client: MonitorDb,
  verdict: string,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO gate_suppressed_verdicts (verdict, tripped_at)
          VALUES (?, ?)
          ON CONFLICT (verdict) DO NOTHING`,
    args: [verdict, Date.now()],
  })
}

/**
 * Clear the suppression for `verdict` (operator resolution path — e.g. after
 * the gate is fixed). Also resets the streak when it is the currently-tracked
 * verdict so the monitor starts clean. Returns true when a suppression row was
 * removed.
 */
export const clearVerdictSuppression = async (
  client: MonitorDb,
  verdict: string,
): Promise<boolean> => {
  await ensureGateMetaMonitorSchema(client)
  const del = await client.execute({
    sql: `DELETE FROM gate_suppressed_verdicts WHERE verdict = ?`,
    args: [verdict],
  })
  const removed = del.rowsAffected > 0
  const row = await readMonitorRow(client)
  if (row.current_verdict === verdict) {
    await writeMonitorRow(client, {
      current_verdict: null,
      streak_count: 0,
      last_task_id: null,
    })
  }
  return removed
}

/**
 * Raise the one level-triggered action-queue row for a tripped verdict.
 * Modelled on the daemon's `provider-rate-limited` row: the dedup signature is
 * stable per verdict so a burst of identical failures bumps `seen_count`
 * instead of inserting siblings — exactly one row per episode.
 */
const raiseGateBrokenRow = async (
  verdict: string,
  streak: number,
): Promise<void> => {
  const gateName = gateNameFromVerdict(verdict)
  try {
    await raiseActionQueueItem({
      kind: GATE_BROKEN_ACTION_QUEUE_KIND,
      category: 'daemon',
      priority: 'urgent',
      title: `Gate ${gateName} may be broken — failing all tasks identically with ${verdict}`,
      body:
        `The verify gate '${gateName}' has produced the same verdict '${verdict}' on ` +
        `${streak} consecutive tasks. This is the signature of a gate whose input ` +
        `pipeline has silently starved (see incident 2026-07-03T08:15Z) rather than a ` +
        `real per-task regression. Recovery-task spawns for this verdict are SUPPRESSED ` +
        `until you act — the affected origins are failed but remain restartable ` +
        `(no recovery slot was consumed). Inspect the gate, fix or disable it, then ` +
        `restart the affected tasks.`,
      payload: { verdict, gate: gateName, streak },
      context: {},
      raisedBy: 'daemon:gate-meta-monitor',
      signature: `gate-broken:${verdict}`,
    })
  } catch {
    // Best-effort: a DB hiccup raising the row must not break the drain or
    // leave the verdict un-suppressed — suppression already committed above.
  }
}

/**
 * Extract the gate name from a verdict of the form `verify:<gate>/<class>`.
 * Falls back to the whole verdict when it does not match that shape.
 */
export const gateNameFromVerdict = (verdict: string): string => {
  const withoutClass = verdict.includes('/')
    ? verdict.slice(0, verdict.lastIndexOf('/'))
    : verdict
  return withoutClass.startsWith('verify:')
    ? withoutClass.slice('verify:'.length)
    : withoutClass
}
