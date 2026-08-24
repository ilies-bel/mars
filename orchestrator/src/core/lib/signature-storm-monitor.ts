import type { DbResultSet, DbStatement } from './db.js'
import { raiseActionQueueItem } from './action-queue'
import { isSameFailureFamily } from './failure-signature.js'
import { isSignatureStormExempt } from './failure-kinds.js'

/**
 * Minimal write/read seam the monitor needs. Satisfied structurally by both a
 * raw {@link import('./db.js').DbClient} and a `DomainTaskStore`, so the
 * monitor stays decoupled from which seam calls it. Mirrors the identical
 * interface in {@link gate-meta-monitor.ts}.
 */
export interface MonitorDb {
  execute(stmt: DbStatement): Promise<DbResultSet>
}

/**
 * Time-windowed per-signature circuit breaker.
 *
 * Each failure is logged to `signature_storm_events` with a timestamp.
 * Within a rolling window ({@link SIGNATURE_STORM_WINDOW_MS}, default 10 min),
 * if any single signature accumulates >= {@link SIGNATURE_STORM_TRIP_THRESHOLD}
 * failures from DIFFERENT tasks, the breaker trips. A different signature
 * interleaving does NOT reset the count — each signature's window is
 * independent.
 *
 * The `failure_signature_streak` singleton row is kept as the durable
 * `tripped` flag so daemon restarts can read it at boot.
 *
 * Exemptions ({@link isSignatureStormExempt}): unchanged from the old design.
 * Non-diagnostic signatures ({@link isDiagnosticSignature}) are also skipped.
 */

export const SIGNATURE_STORM_TRIP_THRESHOLD = (() => {
  const raw = process.env.MARS_SIGNATURE_STORM_THRESHOLD
  if (!raw) return 3
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 3
  return Math.floor(n)
})()

export const SIGNATURE_STORM_WINDOW_MS = (() => {
  const raw = process.env.MARS_SIGNATURE_STORM_WINDOW_MS
  if (!raw) return 10 * 60 * 1000
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1000) return 10 * 60 * 1000
  return Math.floor(n)
})()

/** Action-queue kind for the level-triggered "signature storm" row. */
export const SIGNATURE_STORM_ACTION_QUEUE_KIND = 'signature-storm' as const

interface StreakRow {
  current_signature: string | null
  streak_count: number
  last_task_id: string | null
  tripped: boolean
}

const readStreakRow = async (client: MonitorDb): Promise<StreakRow> => {
  const r = await client.execute({
    sql: `SELECT current_signature, streak_count, last_task_id, tripped
            FROM failure_signature_streak WHERE id = 1`,
    args: [],
  })
  if (r.rows.length === 0) {
    return {
      current_signature: null,
      streak_count: 0,
      last_task_id: null,
      tripped: false,
    }
  }
  return r.rows[0] as unknown as StreakRow
}

const writeStreakRow = async (
  client: MonitorDb,
  row: StreakRow,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO failure_signature_streak
            (id, current_signature, streak_count, last_task_id, tripped, updated_at)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            current_signature = excluded.current_signature,
            streak_count      = excluded.streak_count,
            last_task_id      = excluded.last_task_id,
            tripped           = excluded.tripped,
            updated_at        = excluded.updated_at`,
    args: [
      row.current_signature,
      row.streak_count,
      row.last_task_id,
      row.tripped,
      new Date().toISOString(),
    ],
  })
}

export interface RecordFailureSignatureResult {
  /** Distinct-task count for this signature within the time window. */
  streak: number
  /** True on the observation that first pushed the count to the threshold. */
  tripped: boolean
  /**
   * True when the row was ALREADY tripped before this call. When true,
   * `tripped` is also true but callers must NOT fire duplicate side-effects
   * (pause, steward, action-queue row).
   */
  alreadyTripped: boolean
}

const NON_DIAGNOSTIC_SEGMENTS: ReadonlySet<string> = new Set(['', 'unknown', 'unclassified'])

export const isDiagnosticSignature = (signature: string): boolean => {
  const slash = signature.indexOf('/')
  const failingStep = slash === -1 ? signature : signature.slice(0, slash)
  const errorClass = slash === -1 ? '' : signature.slice(slash + 1).split('/')[0] ?? ''
  const colon = failingStep.lastIndexOf(':')
  const diagnosticSlot = colon === -1 ? errorClass : failingStep.slice(colon + 1)
  return !NON_DIAGNOSTIC_SEGMENTS.has(diagnosticSlot)
}

/** Durable state of the signature-storm circuit breaker. */
export interface SignatureStormState {
  tripped: boolean
  signature: string | null
  streak: number
  lastTaskId: string | null
}

export const readSignatureStormState = async (
  client: MonitorDb,
): Promise<SignatureStormState> => {
  const row = await readStreakRow(client)
  return {
    tripped: row.tripped === true,
    signature: row.current_signature,
    streak: row.streak_count,
    lastTaskId: row.last_task_id,
  }
}

/**
 * Log a failure event and check whether any signature has hit the threshold
 * within the time window. Per-signature, time-windowed — a different
 * signature interleaving does NOT reset any other signature's count.
 */
export const recordFailureSignature = async (
  client: MonitorDb,
  taskId: string,
  signature: string,
): Promise<RecordFailureSignatureResult> => {
  if (isSignatureStormExempt(signature)) {
    return { streak: 0, tripped: false, alreadyTripped: false }
  }
  if (!isDiagnosticSignature(signature)) {
    return { streak: 0, tripped: false, alreadyTripped: false }
  }

  const row = await readStreakRow(client)
  const sameFailure =
    row.current_signature !== null && isSameFailureFamily(row.current_signature, signature)

  // Already tripped for this signature family — idempotent.
  if (row.tripped && sameFailure) {
    await logStormEvent(client, signature, taskId)
    return { streak: row.streak_count, tripped: true, alreadyTripped: true }
  }

  // Log the event.
  await logStormEvent(client, signature, taskId)

  // Prune old events outside the window.
  await pruneStormEvents(client)

  // Count distinct tasks for this signature within the window.
  const streak = await countDistinctTasksInWindow(client, signature)

  const crossing = streak >= SIGNATURE_STORM_TRIP_THRESHOLD
  const nowTripped = crossing

  await writeStreakRow(client, {
    current_signature: signature,
    streak_count: streak,
    last_task_id: taskId,
    tripped: nowTripped,
  })

  if (nowTripped) {
    try {
      await raiseSignatureStormRow(signature, streak)
    } catch {
      // Non-fatal.
    }
    return { streak, tripped: true, alreadyTripped: false }
  }

  return { streak, tripped: false, alreadyTripped: false }
}

const logStormEvent = async (
  client: MonitorDb,
  signature: string,
  taskId: string,
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO signature_storm_events (signature, task_id, recorded_at)
          VALUES (?, ?, ?)`,
    args: [signature, taskId, new Date().toISOString()],
  })
}

const pruneStormEvents = async (client: MonitorDb): Promise<void> => {
  const cutoff = new Date(Date.now() - SIGNATURE_STORM_WINDOW_MS).toISOString()
  await client.execute({
    sql: `DELETE FROM signature_storm_events WHERE recorded_at < ?`,
    args: [cutoff],
  })
}

/**
 * Count distinct task_ids for events whose signature belongs to the same
 * failure family as `signature`, within the time window. Uses
 * {@link isSameFailureFamily} semantics by pulling all events in the window
 * and filtering in JS (the family comparison is not expressible in SQL).
 */
const countDistinctTasksInWindow = async (
  client: MonitorDb,
  signature: string,
): Promise<number> => {
  const cutoff = new Date(Date.now() - SIGNATURE_STORM_WINDOW_MS).toISOString()
  const r = await client.execute({
    sql: `SELECT DISTINCT signature, task_id
            FROM signature_storm_events
           WHERE recorded_at >= ?`,
    args: [cutoff],
  })
  const taskIds = new Set<string>()
  for (const row of r.rows) {
    const eventSig = (row as Record<string, unknown>).signature as string
    const eventTaskId = (row as Record<string, unknown>).task_id as string
    if (isSameFailureFamily(eventSig, signature)) {
      taskIds.add(eventTaskId)
    }
  }
  return taskIds.size
}

/**
 * Reset the failure-signature streak. Also clears storm events so a future
 * storm can trip independently.
 */
export const resetFailureSignatureStreak = async (
  client: MonitorDb,
): Promise<void> => {
  await client.execute({
    sql: `UPDATE failure_signature_streak
            SET current_signature = NULL,
                streak_count      = 0,
                last_task_id      = NULL,
                tripped           = false,
                updated_at        = ?
          WHERE id = 1`,
    args: [new Date().toISOString()],
  })
  await client.execute({
    sql: `DELETE FROM signature_storm_events`,
    args: [],
  })
}

const raiseSignatureStormRow = async (
  signature: string,
  streak: number,
): Promise<void> => {
  const windowMin = Math.round(SIGNATURE_STORM_WINDOW_MS / 60_000)
  await raiseActionQueueItem({
    kind: SIGNATURE_STORM_ACTION_QUEUE_KIND,
    category: 'daemon',
    priority: 'urgent',
    title: `Signature storm detected — ${signature} failed ${streak} tasks in ${windowMin} min; queue PAUSED`,
    body:
      `The failure signature '${signature}' has appeared on ${streak} distinct tasks within ` +
      `the last ${windowMin} minutes. This is the signature of a systemic / environmental failure ` +
      `(e.g. disk full, network partition, CI infra down) rather than a per-task regression. ` +
      `\n\nThe dispatch queue has been PAUSED (reason: storm) — in-flight tasks finish but no ` +
      `new tasks start. A write-capable Steward has been dispatched into its own worktree to ` +
      `diagnose the root cause and land a fix. ` +
      `\n\nResume is AUTOMATIC on two paths: the Steward landing a fix (which also resolves this ` +
      `row), or a bounded fallback timer so dispatch can never stay dead if the Steward fails. ` +
      `Use \`mars operator\` to inspect control levers before resuming dispatch.`,
    payload: { signature, streak },
    context: {},
    raisedBy: 'daemon:signature-storm-monitor',
    signature: `signature-storm:${signature}`,
  })
}
