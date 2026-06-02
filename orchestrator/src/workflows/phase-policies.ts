import type { FailedPhase } from '../core/queue'

// ---------------------------------------------------------------------------
// Per-phase resume/retry policy table.
//
// Each FailedPhase declares exactly HOW `mars continue` resumes it and HOW
// recovery/retry is handled — colocated in the `workflows/` directory next
// to the step definitions that produce each phase value.
//
// This file is intentionally lean (imports only the FailedPhase type from
// queue.ts) so that continue-task.ts can import the policy table without
// pulling in the full implement-workflow.ts module chain.
// ---------------------------------------------------------------------------

export type ContinuePolicy =
  /** Wipe worktree + branch, restart from setup. Only valid when there is
   *  genuinely no work on disk (setup-phase failures). */
  | 'restart-from-setup'
  /** Assess the existing worktree, store context in recoveryPayload, re-queue.
   *  The engine's checkpoint-resume re-runs run-claude-code in the same
   *  worktree. NEVER called when a worktree is ahead of main — that work is
   *  always preserved. */
  | 'coder-on-existing-worktree'
  /** Re-queue as-is; the @mars/workflow engine's checkpoint-resume short-
   *  circuits already-completed steps (setup + code) and re-enters the
   *  failed step (verify or merge) directly. No LLM dispatch needed. */
  | 'engine-resume'

export type RetryPolicy =
  /** Spawn a fix-task via handleTaskFailureWithFixTask. */
  | 'recovery-task'
  /** No automatic recovery task is spawned (operator resolves via action queue
   *  or mars restart). */
  | 'none'

export interface PhasePolicy {
  /** How `mars continue` resumes this phase. */
  continue: ContinuePolicy
  /** How recovery/retry is handled when this phase fails. */
  retry: RetryPolicy
}

/**
 * Per-phase policy table — single source of truth for continue + retry
 * behaviour per FailedPhase value. Exported so continue-task.ts and tests
 * can consume it without duplicating the decision logic.
 *
 * implement-workflow.ts re-exports this table under the same name so callers
 * that prefer the workflow import path still work.
 */
export const PHASE_POLICIES: Record<FailedPhase, PhasePolicy> = {
  /**
   * True pre-coding failure: frozen-lockfile install error or similar.
   * The coding step was never entered; there are no commits to preserve.
   * Restarting from setup is safe.
   */
  setup: { continue: 'restart-from-setup', retry: 'recovery-task' },
  /**
   * Coder step failure: context-exhausted, exploration-loop, or any other
   * run-claude-code exit. The worktree MAY hold commits ahead of main.
   * Never wipe — re-dispatch the coder onto the SAME worktree.
   */
  code: { continue: 'coder-on-existing-worktree', retry: 'none' },
  /**
   * Verify step failure. No coder needed; engine checkpoint-resume re-runs
   * the verify step without touching the worktree or the code.
   */
  verify: { continue: 'engine-resume', retry: 'recovery-task' },
  /**
   * Merge step failure. Engine checkpoint-resume re-runs the merge step.
   * No coder needed.
   */
  merge: { continue: 'engine-resume', retry: 'recovery-task' },
}
