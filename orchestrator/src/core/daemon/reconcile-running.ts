/**
 * Startup reconcile logic for tasks that were `running` when the previous
 * daemon died.
 *
 * A daemon restart is NOT a task fault. The old implementation hard-failed
 * every in-flight task and burned a retry-budget slot, leaving 12/64 tasks
 * in terminal `failed` state after a single daemon restart (see mars-1396badf).
 *
 * Correct behaviour: requeue the task from scratch (discard the stale
 * worktree + branch), preserving the retry count so the restart is invisible
 * to the budget logic.
 *
 * The actual scan→cleanup→requeue/block loop lives in the shared
 * `recoverPhase` module (`phase-recovery.ts`) alongside the verifying/merging
 * recoveries; this file is the `running`-phase entry point and keeps the
 * historical `(repoRoot) => Promise<string[]>` contract that the
 * `requeue-stale-running` reconciler depends on.
 */

import { EventEmitter } from 'node:events'
import { recoverPhase } from './phase-recovery'

/**
 * Requeue every task that was `running` at the time the prior daemon process
 * died.
 *
 * For each such task the shared `recoverPhase('running', …)` loop:
 *  1. Removes the stale worktree directory if it still exists on disk.
 *  2. Deletes the task branch from git (best-effort; ignored if already gone).
 *  3. Resets the task row to `queued` with all in-flight fields cleared —
 *     `branch`, `worktreePath`, `claudeSessionId`, `error`, `failedPhase` —
 *     so the next dispatch starts a clean setup step.
 *  4. `recoverySpawnedCount` is intentionally NOT touched: the restart is not a fault
 *     and must not consume a retry-budget slot.
 *  5. A task that still has incomplete blockers is restored to `blocked`
 *     rather than `queued`, and is omitted from the returned ids.
 *
 * The `running` phase emits no `task.queued` bus event from inside the loop —
 * the `requeue-stale-running` reconciler emits it per id at its call site
 * after this function returns — and runs the loop `silent`, since that
 * reconciler also logs each requeue itself. A throwaway `EventEmitter` is
 * passed because the policy never touches it for this phase.
 *
 * Returns the IDs of every task that was requeued.
 */
export const requeueRunningTasksFromPriorDaemon = async (
  repoRoot: string,
): Promise<string[]> => {
  const result = await recoverPhase('running', {
    log: () => {},
    bus: new EventEmitter(),
    repoRoot,
    silent: true,
  })
  return result.requeued
}
