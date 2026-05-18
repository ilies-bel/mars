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
 */

import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listTasks, updateTask } from '../queue'
import { removeWorktree } from '../lib/git'

const exec = promisify(execFile)

/**
 * Requeue every task that was `running` at the time the prior daemon process
 * died.
 *
 * For each such task:
 *  1. Remove the stale worktree directory if it still exists on disk.
 *  2. Delete the task branch from git (best-effort; ignored if already gone).
 *  3. Reset the task row to `queued` with all in-flight fields cleared —
 *     `branch`, `worktreePath`, `claudeSessionId`, `error`, `failedPhase`,
 *     `resumeFrom` — so the next dispatch starts a clean setup step.
 *  4. `retryCount` is intentionally NOT touched: the restart is not a fault
 *     and must not consume a retry-budget slot.
 *
 * Returns the IDs of every task that was requeued.
 */
export const requeueRunningTasksFromPriorDaemon = async (
  repoRoot: string,
): Promise<string[]> => {
  const running = await listTasks('running')
  const requeued: string[] = []

  for (const t of running) {
    const branch = t.branch ?? `task/${t.id}`

    // Best-effort cleanup: remove worktree dir and stale branch.
    if (t.worktreePath && existsSync(t.worktreePath)) {
      await removeWorktree({ path: t.worktreePath, branch }, true).catch(
        () => {},
      )
    }
    await exec('git', ['branch', '-D', branch], { cwd: repoRoot }).catch(
      () => {},
    )

    // Requeue from setup — do NOT increment retryCount.
    await updateTask(t.id, {
      status: 'queued',
      branch: null,
      worktreePath: null,
      claudeSessionId: null,
      error: null,
      failedPhase: null,
      resumeFrom: null,
    }).catch(() => {})

    requeued.push(t.id)
  }

  return requeued
}
