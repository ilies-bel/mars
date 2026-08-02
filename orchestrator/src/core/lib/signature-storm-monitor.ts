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
 * All-gate consecutive-failure-signature circuit breaker.
 *
 * Where {@link gate-meta-monitor} watches only verify-gate verdicts (a
 * specialised "did this gate break?" guard), this monitor watches the stream
 * of failure signatures across EVERY gate — setup, code, verify, merge, …
 *
 * The sentinel is the full `<failingStep>/<error-class>` signature produced
 * by {@link computeFailureSignature}. When the SAME signature appears on
 * {@link SIGNATURE_STORM_TRIP_THRESHOLD} consecutive DIFFERENT tasks, the
 * fleet is presumed stuck in a systemic / environmental failure (e.g. disk
 * full, network partition, CI infra down). The action taken:
 *
 *  (a) Exactly one `signature-storm` level-triggered action-queue row is
 *      raised, naming the signature, the consecutive count, and instructing
 *      the operator that the queue is paused and that a steward has been
 *      dispatched.
 *  (b) The `tripped` flag is persisted so daemon restarts do not re-trip and
 *      raise a duplicate row for the same episode. It is the DURABLE half of
 *      the daemon's single pause state: a daemon that starts with
 *      `tripped=true` comes up paused with reason `storm`
 *      (see {@link readSignatureStormState}), and clearing the pause clears
 *      this flag in the same step, so the two can never drift.
 *  (c) The CALLER (daemon-side) is responsible for pausing dispatch with
 *      reason `storm` and waking the write-capable Steward.
 *      `recordFailureSignature` signals the first trip via
 *      `{ tripped: true, alreadyTripped: false }`.
 *
 * Streak rules (identical to gate-meta-monitor):
 *  - A signature from a different FAMILY resets the streak to 1.
 *  - The same signature from a DIFFERENT task advances the streak by 1.
 *  - The same signature from the SAME task (`taskId === last_task_id`) does
 *    NOT advance it — the requirement is distinct tasks.
 *
 * "Same signature" means {@link isSameFailureFamily}, not string equality. One
 * failure reaches this monitor at two step granularities — the inline call site
 * knows the fine step (`code:commit-contract/uncommitted-changes`) while the
 * durable recovery-spawn subscriber recovers only the coarse gate from the DB
 * (`code/uncommitted-changes`). Under string equality the two forms of ONE
 * failure reset each other's streak, and whichever form happened to trip was
 * then the only form the Steward's evidence lookup searched for. Family
 * comparison is the SHARED rule: this counter and `collectStormEvidence` use
 * the same helper, so the rows the streak counted are exactly the rows the
 * brief can quote.
 *
 * Reset: any successful task completion calls {@link resetFailureSignatureStreak}
 * which zeroes the streak and clears `tripped`. Dispatch itself resumes when
 * the Steward lands a fix, when the daemon's bounded fallback timer fires, or
 * when the operator clears the pause — all three clear this flag and
 * the pause together.
 */

/**
 * Number of consecutive identical failure signatures (across different tasks)
 * that trips the circuit breaker. Configurable via `MARS_SIGNATURE_STORM_THRESHOLD`
 * (integer ≥ 1; defaults to 3 if absent or invalid).
 */
export const SIGNATURE_STORM_TRIP_THRESHOLD = (() => {
  const raw = process.env.MARS_SIGNATURE_STORM_THRESHOLD
  if (!raw) return 3
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 3
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
  /** The consecutive-across-different-tasks streak after this observation. */
  streak: number
  /** True on the observation that first pushed the streak to the threshold. */
  tripped: boolean
  /**
   * True when the row was ALREADY tripped before this call. When true,
   * `tripped` is also true but callers must NOT fire duplicate side-effects
   * (pause, steward, action-queue row).
   */
  alreadyTripped: boolean
}

/**
 * Record one failure signature observed for `taskId` and advance the
 * consecutive-across-different-tasks streak.
 *
 * On the FIRST crossing of {@link SIGNATURE_STORM_TRIP_THRESHOLD}:
 *  - `tripped` is set to `true` in the DB row.
 *  - One `signature-storm` action-queue row is raised (best-effort; a DB
 *    hiccup raising the row must not break the recovery path).
 *  - Returns `{ tripped: true, alreadyTripped: false }` so the CALLER can
 *    execute daemon-side effects (setIsPaused, investigateWorktree).
 *
 * Subsequent calls while `tripped=true` return `{ tripped: true, alreadyTripped: true }`
 * without raising another row — idempotent per episode.
 */
/**
 * Signature segments that carry NO diagnostic information. A signature whose
 * only classified slot holds one of these records that classification failed,
 * not what failed.
 */
const NON_DIAGNOSTIC_SEGMENTS: ReadonlySet<string> = new Set(['', 'unknown', 'unclassified'])

/**
 * Does `signature` actually name a failure cause, or is it a placeholder?
 *
 * Grammar (see {@link computeFailureSignature}): a signature is
 * `<failingStep>/<errorClass>`, where `<failingStep>` is a colon-separated
 * step id — a bare gate name (`code`, `verify`, `setup`, `merge`, `unknown`)
 * optionally followed by a KIND segment (`verify:has-diff`,
 * `setup:origin-worktree-missing`, `merge:vcs-supervisor-aborted`).
 *
 * The breaker's whole premise is "the SAME signature failed N consecutive
 * tasks, therefore one systemic cause" — which only holds when the signature
 * identifies a cause. Two slots can supply one:
 *
 *  - the KIND segment of the failing step, when the step carries one; or
 *  - the ERROR CLASS, when the step is a bare gate name.
 *
 * So the diagnostic slot is the kind when the step has a colon, and the error
 * class otherwise — and a signature is diagnostic only when that slot names
 * something. `code/unclassified` and `verify/unclassified` are the two most
 * generic buckets in the system: a bare gate name plus "we could not classify
 * this". They share nothing but the gate they died in, so streaking them
 * together trips the breaker on noise and pauses dispatch until a human
 * notices. Same for `unknown/unclassified`, `/unclassified`, `code/unknown`
 * and `recovery_exhausted:/unclassified/unclassified` (an empty kind slot).
 *
 * That is not hypothetical — a daemon restart emits a burst of reconcile
 * artifacts (orphaned origins, dirty-main parks) that all classify into these
 * generic buckets, so routine restarts silently wedged the queue.
 *
 * Signatures with a real kind (`setup:origin-worktree-missing/unclassified`,
 * `merge:vcs-supervisor-aborted/rebase-dirty-worktree`) still streak normally
 * even though their CLASS is unclassified — the kind is the diagnostic part.
 * So do bare-gate signatures with a real class (`verify/no-commits-ahead`) —
 * there the class is the diagnostic part.
 */
export const isDiagnosticSignature = (signature: string): boolean => {
  const slash = signature.indexOf('/')
  const failingStep = slash === -1 ? signature : signature.slice(0, slash)
  // The error class is the first segment after the step; a signature with no
  // slash (e.g. `setup:origin-worktree-missing`) has no class at all.
  const errorClass = slash === -1 ? '' : signature.slice(slash + 1).split('/')[0] ?? ''
  const colon = failingStep.lastIndexOf(':')
  // A colon means the step declares a kind slot — that slot is then the only
  // diagnostic part, even when it is empty (an empty slot is a placeholder).
  const diagnosticSlot = colon === -1 ? errorClass : failingStep.slice(colon + 1)
  return !NON_DIAGNOSTIC_SEGMENTS.has(diagnosticSlot)
}

/** Durable state of the signature-storm circuit breaker. */
export interface SignatureStormState {
  /** True while the breaker is tripped (dispatch is expected to be paused). */
  tripped: boolean
  /** The signature the breaker tripped on, or null when it never tripped. */
  signature: string | null
  /** The streak count at the moment of the read. */
  streak: number
  /** The last task id observed for the current signature. */
  lastTaskId: string | null
}

/**
 * Read the durable breaker state. The daemon calls this at startup so the
 * in-memory pause state and the persisted `tripped` flag cannot drift apart:
 * a daemon that comes up with `tripped=true` comes up paused, with `storm`
 * recorded as the pause reason.
 */
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

export const recordFailureSignature = async (
  client: MonitorDb,
  taskId: string,
  signature: string,
): Promise<RecordFailureSignatureResult> => {
  // A dirty integration branch is an operator-owned condition with its own
  // action-queue row. Several committers encountering it are not a systemic
  // task failure, so never let it pause dispatch globally.
  if (isSignatureStormExempt(signature)) {
    return { streak: 0, tripped: false, alreadyTripped: false }
  }
  // A placeholder signature groups unrelated failures; never streak on it.
  if (!isDiagnosticSignature(signature)) {
    return { streak: 0, tripped: false, alreadyTripped: false }
  }
  const row = await readStreakRow(client)
  // Same failure, possibly a coarser/finer step id — see the module docblock.
  const sameFailure =
    row.current_signature !== null && isSameFailureFamily(row.current_signature, signature)

  // If already tripped for THIS failure, return idempotent result.
  if (row.tripped && sameFailure) {
    // Still advance last_task_id so the row stays fresh, but do NOT
    // bump streak_count (it's beyond the threshold; capping prevents overflow).
    await writeStreakRow(client, {
      ...row,
      last_task_id: taskId !== row.last_task_id ? taskId : row.last_task_id,
    })
    return { streak: row.streak_count, tripped: true, alreadyTripped: true }
  }

  let streak: number
  let lastTaskId: string

  if (!sameFailure) {
    // A different failure family (or the first ever) → fresh streak.
    streak = 1
    lastTaskId = taskId
  } else if (row.last_task_id === taskId) {
    // Same signature, same task — does not count as a new task. Streak holds.
    streak = row.streak_count
    lastTaskId = row.last_task_id ?? taskId
  } else {
    // Same signature, different task → advance.
    streak = row.streak_count + 1
    lastTaskId = taskId
  }

  const crossing = streak >= SIGNATURE_STORM_TRIP_THRESHOLD
  const nowTripped = crossing

  await writeStreakRow(client, {
    current_signature: signature,
    streak_count: streak,
    last_task_id: lastTaskId,
    tripped: nowTripped,
  })

  if (nowTripped) {
    // Raise exactly one action-queue row on the first trip. Best-effort:
    // a DB hiccup must not break the recovery path (the streak is already
    // persisted above; only the notification fails).
    try {
      await raiseSignatureStormRow(signature, streak)
    } catch {
      // Non-fatal: action-queue raise failure does not undo the persisted trip.
    }
    return { streak, tripped: true, alreadyTripped: false }
  }

  return { streak, tripped: false, alreadyTripped: false }
}

/**
 * Reset the failure-signature streak. Call on any successful task completion
 * so the storm episode ends and a future storm (different signature or the
 * same one after a fix) can trip independently.
 *
 * Does NOT itself resume the queue — the daemon owns the pause state and
 * clears it alongside this flag (Steward success, fallback timer, or
 * the operator clears the pause).
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
  // If no row existed yet there is nothing to reset — that is fine.
}

/**
 * Raise the one level-triggered `signature-storm` action-queue row for a
 * tripped episode. Modelled on the daemon's `provider-rate-limited` row:
 * the dedup signature is stable per failure-signature so a burst of identical
 * failures bumps `seen_count` instead of inserting siblings.
 */
const raiseSignatureStormRow = async (
  signature: string,
  streak: number,
): Promise<void> => {
  await raiseActionQueueItem({
    kind: SIGNATURE_STORM_ACTION_QUEUE_KIND,
    category: 'daemon',
    priority: 'urgent',
    title: `Signature storm detected — ${signature} failed ${streak} times in a row; queue PAUSED`,
    body:
      `The failure signature '${signature}' has appeared on ${streak} consecutive tasks across ` +
      `different task ids. This is the signature of a systemic / environmental failure ` +
      `(e.g. disk full, network partition, broken CI infra) rather than a per-task regression. ` +
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
