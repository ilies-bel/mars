import { existsSync } from 'node:fs'
import { getTask, updateTask } from '../queue'
import { coreRestartTask } from './restart-task'

export interface ContinueResult {
  /**
   * True when the failure was upstream of worktree creation so there is
   * nothing on disk to preserve. In this case continue silently degrades
   * to restart behaviour: the workflow re-enters from setup.
   */
  degradedToRestart: boolean
  /**
   * Human-readable explanation when `degradedToRestart` is true. The CLI
   * surfaces this so the operator understands why their `mars continue`
   * behaved identically to `mars restart`.
   */
  note?: string
}

/**
 * Core continue mechanics shared by the UDS RPC handler.
 *
 * Happy path: the task failed in a resumable phase ('verify' or 'merge'),
 * the worktree exists on disk, and the task is re-queued with `resumeFrom`
 * set so the workflow skips back into the failed step.
 *
 * Degraded path: the failure occurred upstream of worktree creation (e.g. a
 * dirty-main guard at setup). There is nothing on disk worth preserving, so
 * continue silently delegates to {@link coreRestartTask} and returns
 * `degradedToRestart: true` with a `note` for the CLI to display.
 *
 * Intentionally has no dependency on the daemon's event bus — the caller is
 * responsible for emitting `task.queued` after this resolves.
 *
 * @throws if the task does not exist or is not in `'failed'` status.
 */
export const coreContinueTask = async (id: string): Promise<ContinueResult> => {
  const task = await getTask(id)
  if (!task) throw new Error(`task ${id} not found`)
  if (task.status !== 'failed') {
    throw new Error(
      `task ${id} is ${task.status}; only failed tasks can be continued (use 'mars restart' instead)`,
    )
  }

  // A pre-setup failure leaves no worktree worth preserving. Indicators:
  //   - failedPhase null  → failure before any phase was recorded (e.g. dirty-main guard)
  //   - failedPhase 'code' → sentinel for non-resumable setup-time failures
  //   - no branch/worktreePath on the row → worktree was never created
  //   - worktree path missing on disk → worktree was created but is gone
  const isPreSetup =
    task.failedPhase === null ||
    task.failedPhase === 'code' ||
    !task.branch ||
    !task.worktreePath ||
    !existsSync(task.worktreePath)

  if (isPreSetup) {
    await coreRestartTask(id, new Set(['failed']))
    return {
      degradedToRestart: true,
      note: `failure was pre-setup (no worktree to preserve); continue is equivalent to restart here`,
    }
  }

  await updateTask(id, {
    status: 'queued',
    error: null,
    resumeFrom: task.failedPhase,
  })
  return { degradedToRestart: false }
}
