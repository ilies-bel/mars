/**
 * Payload contracts for the task-lifecycle action-queue kind family.
 *
 * Covers the six kinds that fire when a task's arc ends in an operator-visible
 * lifecycle event: a cancelled-blocker cascade, a failed prerequisite, an
 * abandoned recovery, an arc superseded on main, a task marked done but not
 * merged, and an inconclusive diagnose chore.
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

/**
 * A blocker was cancelled by the user and the cancellation cascaded to this
 * dependent task.
 *
 * Raised by `Arc.cascadeCancellation` in `src/core/arc.ts`.
 */
export interface CancelledBlockerCascadePayload {
  /** The dependent task that was cancelled as a cascade. */
  dependentTaskId: string
  /** The blocker task that was explicitly cancelled by the user. */
  cancelledBlockerTaskId: string
  /** Always `'cancelled-blocker-cascade'`. */
  failureReason: string
}

/**
 * A prerequisite (blocker) task failed and the dependent was moved to
 * `blocked` rather than dispatched.
 *
 * Raised by `Arc.blockDependentsByFailedBlocker` in `src/core/arc.ts`.
 */
export interface PrerequisiteFailedPayload {
  /** The dependent task that is now blocked. */
  dependentTaskId: string
  /** The prerequisite task that failed. */
  failedBlockerTaskId: string
}

/**
 * A fix (recovery) task was manually dropped before the automated recovery
 * ran to completion. The origin's single recovery slot is forfeited.
 *
 * Raised by `drainRecoveryAbandoned` in
 * `src/outbox/subscribers/recovery-abandoned.ts`.
 */
export interface RecoveryAbandonedPayload {
  /** The fix task that was manually dropped. */
  fixTaskId: string
  /** The origin task that the fix was created for. */
  originTaskId: string
  /** Git branch the origin task was on at raise time. */
  branch: string | null
  /** Worktree path of the origin task at raise time. */
  worktreePath: string | null
  /**
   * Number of commits on the origin branch ahead of the integration branch
   * at the time the row was raised. `null` when the git probe failed or the
   * branch was not set.
   */
  commitsAhead: number | null
  /**
   * True when `mars continue` would accept the origin task: the origin has a
   * branch, a worktree path, and its `failure_reason` does not carry the
   * `recovery_exhausted:` or `recovery_disabled:` prefix.
   */
  continuable: boolean
  /**
   * Cause key for action-queue grouping. Set to `'recovery-abandoned:no-commits'`
   * when the branch has no commits ahead (all such rows describe the same
   * situation: wipe and restart). Set to `null` when there are commits ahead so
   * each such row stays separate — the branch name and commit count differ and
   * the operator must evaluate each one individually.
   */
  failureReasonCode: string | null
}

/**
 * An arc's intent was detected as already implemented on the integration
 * branch; the origin was dropped and no rescue was spawned.
 *
 * Raised by `maybeSpawnRescueOperator` in `src/core/rescue-operator-spawn.ts`.
 */
export interface ArcSupersededOnMainPayload {
  /** The Arc's origin task id. */
  originId: string
  /** The commit SHA on main that satisfies the arc's intent. */
  supersededBySha: string
}

/**
 * A task was transitioned to `done` but its branch still had commits ahead
 * of the integration branch — the merge step did not complete.
 *
 * Raised by the done-implies-merged guard in `src/core/arc.ts`.
 */
export interface DoneWithUnmergedCommitsPayload {
  /** The task id whose done transition was blocked. */
  taskId: string
  /**
   * The task branch that has unmerged commits. Typed as `string | null`
   * because `taskBranch` in `arc.ts` is `string | null` — the narrowing that
   * guarantees non-null when `doneWithUnmergedCommits` is true is not tracked
   * by TypeScript across the flag assignment.
   */
  branch: string | null
  /** The integration branch name (e.g. `'main'`). */
  integration: string
}

/**
 * A diagnose chore returned an inconclusive or no-verdict result; the parent
 * task was failed and the operator must investigate manually.
 *
 * Raised by `handleDiagnoseFollowup` in `src/core/lib/diagnose-followup.ts`.
 *
 * `originTaskId`, `choreId`, and `verdictKind` are optional because rows
 * raised before the fix at commit 8eda7f21 only carry `parentTaskId` — the
 * alert-dismisser regression test mirrors this pre-fix shape. New raises
 * (current `diagnose-followup.ts`) always set all four fields.
 */
export interface DiagnoseInconclusivePayload {
  /** The task that the diagnose chore was created for. */
  parentTaskId: string
  /**
   * Same as `parentTaskId`. Kept for UI entity resolution
   * (`extractEntityId` in `view/action-queue.ts`). Optional on legacy rows.
   */
  originTaskId?: string
  /** The diagnose chore task id. Optional on legacy rows. */
  choreId?: string
  /** The verdict kind: `'inconclusive'` or `'no-verdict'`. Optional on legacy rows. */
  verdictKind?: string
}

// ── Map and registry ──────────────────────────────────────────────────────────

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface LifecycleContracts {
  'cancelled-blocker-cascade': CancelledBlockerCascadePayload
  'prerequisite-failed': PrerequisiteFailedPayload
  'recovery-abandoned': RecoveryAbandonedPayload
  'arc-superseded-on-main': ArcSupersededOnMainPayload
  'done-with-unmerged-commits': DoneWithUnmergedCommitsPayload
  'diagnose-inconclusive': DiagnoseInconclusivePayload
}

/** Representative fixtures for the payload-contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<keyof LifecycleContracts, Record<string, unknown>> = {
  'cancelled-blocker-cascade': {
    dependentTaskId: 'mars-1',
    cancelledBlockerTaskId: 'mars-2',
    failureReason: 'cancelled-blocker-cascade',
  },
  'prerequisite-failed': {
    dependentTaskId: 'mars-3',
    failedBlockerTaskId: 'mars-4',
  },
  'recovery-abandoned': {
    fixTaskId: 'fix-5',
    originTaskId: 'mars-6',
    branch: 'task/mars-6',
    worktreePath: '/path/to/worktree',
    commitsAhead: 0,
    continuable: true,
    failureReasonCode: 'recovery-abandoned:no-commits',
  },
  'arc-superseded-on-main': {
    originId: 'mars-7',
    supersededBySha: 'abc1234def',
  },
  'done-with-unmerged-commits': {
    taskId: 'mars-8',
    branch: 'task/mars-8',
    integration: 'main',
  },
  'diagnose-inconclusive': {
    parentTaskId: 'mars-9',
    originTaskId: 'mars-9',
    choreId: 'mars-10',
    verdictKind: 'inconclusive',
  },
}
