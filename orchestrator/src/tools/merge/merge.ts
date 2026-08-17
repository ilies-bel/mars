/**
 * Shared contract for bound merge supervision (PRD bf7bbd39).
 *
 * Four consumer slices all modify code that touches the merge step:
 *   - "Emit periodic merge progress heartbeat"
 *   - "Bound merge step with a hard wall-clock timeout"
 *   - "Idempotent short-circuit when task is already terminal"
 *   - "Wedged vcs-supervisor releases merge lock with actionable failure"
 *
 * This module defines the types, interfaces, constants, and error classes
 * they share so each consumer can branch off a `main` that already has the
 * contract. No runtime logic lives here — pure types, constants, and one error
 * class. This module has no imports from other orchestrator modules to avoid
 * circular dependencies.
 */

// ── Periodic merge heartbeat ──────────────────────────────────────────────────

/**
 * Data emitted by the periodic merge-step heartbeat. The merge primitive and
 * merge worker emit this on a fixed interval so the phantom-task watchdog can
 * distinguish a legitimately long merge from a silently wedged one.
 *
 * Consumer: "Emit periodic merge progress heartbeat"
 */
export interface MergeHeartbeat {
  /** Task currently being merged. */
  taskId: string
  /** Wall-clock milliseconds since the merge step started. */
  elapsedMs: number
  /**
   * Most-recent sub-phase inside `mergeBranch`
   * (e.g. `'acquire-lock'`, `'rebase'`, `'vega'`, `'fast-forward'`,
   * `'integration-gate'`).
   */
  phase: string
  /** `Date.now()` value at emission time (ms since Unix epoch). */
  at: number
}

/**
 * Callback invoked on each heartbeat tick. A returned rejected Promise is
 * silently swallowed — a reporting failure must never abort or slow a merge.
 *
 * Consumer: "Emit periodic merge progress heartbeat"
 */
export type MergeHeartbeatFn = (heartbeat: MergeHeartbeat) => void | Promise<void>

/**
 * Default interval between heartbeat emissions (milliseconds). Override with
 * `MARS_MERGE_HEARTBEAT_INTERVAL_MS`.
 *
 * Consumer: "Emit periodic merge progress heartbeat"
 */
export const DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS = 15_000 // 15 s

// ── Hard step-level wall-clock timeout ───────────────────────────────────────

/**
 * Hard wall-clock ceiling (milliseconds) for the merge STEP, measured from the
 * moment the merge primitive delegates to `enqueueMergeJobAndAwait`.
 *
 * Distinguished from `DEFAULT_WATCHDOG_MS` (the git-level watchdog inside
 * `mergeBranch` that bounds the git work): the step timeout fires when the
 * merge WORKER itself is wedged — it claimed the job but never called
 * `resolveMergeJob`. That scenario is not covered by the internal per-job
 * watchdog.
 *
 * Sized as the sum of the internal per-job watchdog (35 min =
 * `VCS_SUPERVISOR_TIMEOUT_MS` 30 min + `MERGE_GIT_BUDGET_MS` 5 min) and the
 * outer grace window (10 min = `DEFAULT_OUTER_WATCHDOG_GRACE_MS`). This
 * mirrors the existing outer timeout in `enqueueMergeJobAndAwait` so the two
 * timeout values are derived from the same constant and cannot drift apart.
 *
 * Override with `MARS_MERGE_STEP_TIMEOUT_MS`.
 *
 * Consumer: "Bound merge step with a hard wall-clock timeout"
 */
export const DEFAULT_MERGE_STEP_TIMEOUT_MS = 45 * 60_000 // 45 min

/**
 * Failure reason code (and action-queue title fragment) stamped when the
 * step-level hard timeout fires and the merge step is aborted.
 *
 * Consumer: "Bound merge step with a hard wall-clock timeout"
 */
export const MERGE_STEP_TIMEOUT_FAILURE_REASON = 'merge:step-timeout' as const

// ── Idempotent terminal short-circuit ─────────────────────────────────────────

/**
 * Task statuses that mean the merge step is a safe no-op. When the merge
 * primitive observes one of these statuses at entry time, it short-circuits
 * and returns without enqueueing a new merge job.
 *
 * Rationale: a `mars continue` re-entry of a task that already reached a
 * terminal state (e.g. because `resolveMergeJob` ran on a prior attempt but
 * the step-completion record was lost to a daemon restart) would otherwise
 * re-run the full merge and produce a double-done or a dirty-tree error.
 *
 * The set mirrors `TERMINAL_TASK_STATUSES` from `core/queue.ts` (`done`,
 * `failed`, `dropped`). It is redefined here to keep this module
 * dependency-free; a runtime assertion in the test suite guarantees the two
 * sets agree.
 *
 * Consumer: "Idempotent short-circuit when task is already terminal"
 */
export const MERGE_IDEMPOTENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'dropped',
])

/**
 * Failure reason code logged (at debug level — this is not a real failure)
 * when the merge step short-circuits on an already-terminal task.
 *
 * Consumer: "Idempotent short-circuit when task is already terminal"
 */
export const MERGE_ALREADY_TERMINAL_REASON = 'merge:already-terminal' as const

// ── Wedged vcs-supervisor ─────────────────────────────────────────────────────

/**
 * Thrown when the vcs-supervisor holds the merge lock longer than
 * `DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS` without emitting a recorded
 * progress event, indicating it is permanently stuck.
 *
 * The merge primitive catches this error, releases the merge lock, raises an
 * actionable `failed` action-queue item (kind `failed`, signature
 * `merge:wedged-vcs-supervisor`), and stamps the task `failed`. The operator
 * can then inspect the worktree (the vcs-supervisor session and any rebase
 * state are preserved) and `mars continue` the task once the blockage is
 * resolved.
 *
 * Consumer: "Wedged vcs-supervisor releases merge lock with actionable failure"
 */
export class WedgedVcsSupervisorError extends Error {
  readonly taskId: string
  readonly lockHeldMs: number
  readonly lastPhase: string

  constructor(taskId: string, lockHeldMs: number, lastPhase: string) {
    super(
      `merge:wedged-vcs-supervisor — task ${taskId}: vcs-supervisor held the merge lock ` +
        `for ${Math.round(lockHeldMs / 1_000)}s without progress (last phase: ${lastPhase}); ` +
        `lock released, actionable failure raised`,
    )
    this.name = 'WedgedVcsSupervisorError'
    this.taskId = taskId
    this.lockHeldMs = lockHeldMs
    this.lastPhase = lastPhase
  }
}

/**
 * How long (milliseconds) the vcs-supervisor may hold the merge lock without
 * emitting a progress event before the merge step declares it wedged and
 * throws `WedgedVcsSupervisorError`. Override with
 * `MARS_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS`.
 *
 * Must be generous enough to allow the supervisor to finish a complex
 * multi-file conflict resolution (typical: 5–15 min) while staying well below
 * the 30-minute `VCS_SUPERVISOR_TIMEOUT_MS` so a truly wedged session is
 * detected before the supervisor's own wall-clock budget fires.
 *
 * Consumer: "Wedged vcs-supervisor releases merge lock with actionable failure"
 */
export const DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS = 20 * 60_000 // 20 min

/**
 * Failure reason code stamped when the wedged-supervisor heuristic fires.
 *
 * Consumer: "Wedged vcs-supervisor releases merge lock with actionable failure"
 */
export const MERGE_WEDGED_VCS_SUPERVISOR_REASON = 'merge:wedged-vcs-supervisor' as const
