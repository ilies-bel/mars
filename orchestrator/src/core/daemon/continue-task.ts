import { existsSync } from 'node:fs'
import { getTask, updateTask } from '../queue'
import { getDefaultTaskStore } from '../lib/task-store'
import { coreRestartTask } from './restart-task'
import { createQueueWorkflowStore } from '../../workflows/queue-workflow-store'

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
 * Happy path: the task failed in a resumable phase ('verify' or 'merge') and
 * its worktree still exists on disk. We re-queue it as-is (`status:'queued'`,
 * `error:null`) — WITHOUT any `resumeFrom` hint. Resume is engine-driven now:
 * the daemon dispatches `runWorkflow(..., { runId: task.id })`, so the
 * re-dispatch re-enters the implement workflow with the same runId and the
 * @mars/workflow engine short-circuits every step whose checkpoint record is
 * already `'completed'`, picking up exactly where the prior run failed.
 * `failedPhase` stays on the row: it still records which phase failed and
 * drives the degraded-vs-resume decision below and the operator display.
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

  // Guard: refuse if an in-flight recovery (fix-task) is already running for
  // this task. Checked before the status guard so the error names the recovery
  // id rather than giving the generic "only failed tasks" message.
  const store = await getDefaultTaskStore()
  const inflightRows = await store.query({
    sql: `SELECT id FROM tasks
           WHERE fix_for_task_id = ?
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [id],
  })
  if (inflightRows.rows.length > 0) {
    const recoveryId = (inflightRows.rows[0] as unknown as { id: string }).id
    throw new Error(
      `task ${id} already has an in-flight recovery ${recoveryId}; wait for it to complete or use 'mars restart' to discard and re-run`,
    )
  }

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
  const worktreeMissingOnDisk =
    !!task.branch && !!task.worktreePath && !existsSync(task.worktreePath)

  const isPreSetup =
    task.failedPhase === null ||
    task.failedPhase === 'code' ||
    !task.branch ||
    !task.worktreePath ||
    worktreeMissingOnDisk

  if (isPreSetup) {
    await coreRestartTask(id, new Set(['failed']), createQueueWorkflowStore())
    const note = worktreeMissingOnDisk
      ? `worktree at ${task.worktreePath} is missing from disk; cannot re-enter ${task.failedPhase} phase — restarting from setup`
      : `failure was pre-setup (no worktree to preserve); continue is equivalent to restart here`
    return { degradedToRestart: true, note }
  }

  // Re-queue as-is. No `resumeFrom`: engine checkpoint-resume (runId=task.id)
  // is the single source of truth for which step the re-dispatch skips into.
  await updateTask(id, {
    status: 'queued',
    error: null,
  })
  return { degradedToRestart: false }
}
