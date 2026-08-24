/**
 * Blocker-resolution result types. The worktree/vocabulary primitives this
 * file used to own moved to `lib/blocker-resolution-primitives.ts` so
 * `core/arc.ts` can reach them without importing this module (ADR-0101).
 *
 * `raiseActionQueueForBlockedTask(taskId)` was also deleted here (ADR-0101
 * item 1). It had no caller anywhere in the tree — the live
 * recovery-exhausted raise is in `queue-fix-tasks.ts`, which calls
 * `raiseRecoveryExhaustedActionQueue` directly with the task it already
 * holds. That dead function's `getTask` import was the ONLY value-level
 * edge from this module to `core/queue.ts`, and `queue.ts` imports the
 * `Arc` aggregate for its facade verbs — so a dead read closed the
 * `arc.ts -> blocker-resolution.ts -> queue.ts -> arc.ts` cycle. If a
 * caller ever needs this again, take the already-loaded `Task` as a
 * parameter rather than re-importing `getTask` here.
 */

export interface BlockByFailureOutcome {
  taskId: string
  outcome: 'blocked' | 'noop'
}

export interface BlockByFailureResult {
  failedBlockerTaskId: string
  outcomes: BlockByFailureOutcome[]
}

export interface UnblockOutcome {
  taskId: string
  /**
   * - `'queued'`          — dependent was re-queued normally.
   * - `'done-via-recovery'` — dependent was the recovery's origin; propagateRecoveryDone
   *                          flipped it to done instead of re-queuing (mars-f2034bb9).
   * - `'failed'`          — dependent failed at unblock time (orphaned origin / worktree ahead).
   * - `'noop'`            — no state change (still has unsettled blockers, or already processed).
   */
  outcome: 'queued' | 'done-via-recovery' | 'failed' | 'noop'
  recoverySpawnedCount: number
  failureReason?: string
}

export interface UnblockByTaskResult {
  blockerTaskId: string
  outcomes: UnblockOutcome[]
  /**
   * Set when the completing task was a diagnose Chore that reached `done`
   * (PRD 06e677fb). The generic unblock loop is bypassed for such a Chore —
   * its parent is NEVER re-queued blindly, because the recorded verdict owns
   * that decision — so `outcomes` is empty and the caller must run the
   * verdict-driven branch (`runDiagnoseFollowup`) instead.
   *
   * The Arc aggregate reports the need rather than acting on it: dispatching
   * a fix task and raising action-queue rows is self-heal routing, not a task
   * lifecycle transition, and calling it from `arc.ts` closed an
   * `arc -> diagnose-followup -> arc` import cycle.
   */
  diagnoseVerdictPending?: boolean
}

export interface BlockedDependentRow {
  id: string
  recovery_spawned_count: number | null
}

export interface FailStrandedOriginOutcome {
  originTaskId: string
  recoveryTaskId: string
  outcome: 'failed' | 'noop'
}

export interface FailStrandedOriginResult {
  recoveryTaskId: string
  outcomes: FailStrandedOriginOutcome[]
}

export interface PropagateRecoveryDoneResult {
  originTaskId: string
  originFlipped: boolean
  unblock: UnblockByTaskResult | null
  actionQueueItemsClosed: number
}

export interface RecoverBlockedTaskOutcome {
  taskId: string
  outcome: 'queued' | 'noop' | 'failed' | 'not-blocked'
  recoverySpawnedCount: number
  failureReason?: string
  /**
   * Present when `outcome === 'noop'`: the status of each unsettled blocker
   * edge.  A status of `'MISSING'` means the blocker row has been deleted.
   * Live statuses (queued/running/blocked) mean normal waiting; `'failed'` or
   * `'MISSING'` mean the task is stranded and needs operator attention.
   */
  blockerStatuses?: Array<{ blockerId: string; status: string }>
}

export interface RecoverAllBlockedTasksResult {
  outcomes: RecoverBlockedTaskOutcome[]
}
