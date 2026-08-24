/**
 * Result shapes for the blocker-resolution cascade.
 *
 * This module is types-only. The worktree/vocabulary primitives it used to own
 * moved to `lib/blocker-resolution-primitives.ts` so `core/arc.ts` can reach
 * them without importing this module (ADR-0101), and every consumer of the
 * shapes below imports them with `import type` — `no-circular` excludes
 * type-only edges because they vanish at compile time.
 *
 * Adding a runtime export here re-opens that edge. Put it in
 * `lib/blocker-resolution-primitives.ts` instead.
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
