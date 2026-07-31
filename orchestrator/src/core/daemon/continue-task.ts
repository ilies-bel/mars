import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getTask, updateTask } from '../queue'
import { getDefaultTaskStore } from '../store/task-store'
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
   * True when the task failed in the code phase and its worktree was
   * preserved on disk. The workflow re-enters at the code step — the
   * resuming coder picks up where the previous one stopped.
   */
  codePhaseResume?: boolean
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
 * Happy path — resumable phase ('verify' or 'merge'): the task failed in a
 * resumable phase and its worktree still exists on disk. We re-queue it
 * as-is (`status:'queued'`, `error:null`) — WITHOUT any `resumeFrom` hint.
 * Resume is engine-driven: the daemon dispatches
 * `runWorkflow(..., { runId: task.id })`, so the re-dispatch re-enters the
 * implement workflow with the same runId and the @mars/workflow engine
 * short-circuits every step whose checkpoint record is already `'completed'`,
 * picking up exactly where the prior run failed. `failedPhase` stays on the
 * row: it still records which phase failed and drives the
 * degraded-vs-resume decision below and the operator display.
 *
 * Code-phase resume path (NEW): the task failed in the code phase
 * (`failedPhase === 'code'`) but its worktree exists on disk. This happens
 * when the coder was killed mid-implementation (context-exhausted, watchdog,
 * crash) with uncommitted work sitting in the worktree. Before re-queuing,
 * any dangling diff is auto-committed as a wip/salvage checkpoint so the
 * resuming coder starts on a clean base and the partial work survives a
 * re-crash. The daemon detects `failedPhase === 'code'` at dispatch time
 * and injects a resume banner into the coder prompt.
 *
 * Degraded path: the failure occurred upstream of worktree creation (e.g. a
 * dirty-main guard at setup, or the worktree has since been deleted). There
 * is nothing on disk worth preserving, so continue silently delegates to
 * {@link coreRestartTask} and returns `degradedToRestart: true` with a
 * `note` for the CLI to display.
 *
 * Refusal set:
 *   - `failedPhase === null`        — failure before any phase was recorded
 *   - no branch / worktreePath      — worktree was never created
 *   - worktree path missing on disk — worktree was created but is gone
 *   - in-flight recovery exists     — wait for it to complete first
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
  //   - no branch/worktreePath on the row → worktree was never created
  //   - worktree path missing on disk → worktree was created but is gone
  // Note: failedPhase === 'code' is intentionally NOT in this set. A code-
  // phase failure can come from either a setup-time install failure or a
  // coder kill (context-exhausted, watchdog). When the worktree exists, both
  // cases are worth attempting to resume — the engine's checkpoint-resume
  // handles which step to re-enter (setup if that step's checkpoint is
  // missing, code if setup completed).
  const worktreeMissingOnDisk =
    !!task.branch && !!task.worktreePath && !existsSync(task.worktreePath)

  const isPreSetup =
    task.failedPhase === null ||
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

  // Code-phase resume: the coder was killed mid-implementation with the
  // worktree intact. Auto-commit any dangling diff as a wip/salvage
  // checkpoint so the resuming coder starts on a clean base and the partial
  // work survives a re-crash.
  if (task.failedPhase === 'code') {
    // task.worktreePath is non-null here: isPreSetup above guards !task.worktreePath
    const worktreePath = task.worktreePath as string
    try {
      const gitStatus = execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf-8',
      }).trim()
      if (gitStatus.length > 0) {
        execFileSync('git', ['add', '-A'], { cwd: worktreePath })
        execFileSync(
          'git',
          [
            '-c', 'user.email=mars@orchestrator',
            '-c', 'user.name=Mars Orchestrator',
            'commit',
            '-m', 'wip: salvage checkpoint before mars continue resume\n\nAuto-committed by mars continue to preserve in-progress work before code-phase resume.',
          ],
          { cwd: worktreePath },
        )
      }
    } catch (salvageErr) {
      // Auto-commit is best-effort. If git identity is not configured or the
      // commit fails for any reason, log and proceed — the resuming coder can
      // handle an unclean worktree.
      console.error(`[continue] auto-commit failed for ${id}:`, salvageErr)
    }

    // Set requeueAnchorMs to now so the poll-fallback ceiling measures elapsed
    // time from this operator-initiated resume, not from the original run's
    // first step (which may be hours or days old — the journal is preserved
    // by design for checkpoint-resume).
    await updateTask(id, {
      status: 'queued',
      error: null,
      requeueAnchorMs: Date.now(),
      requeueDispatchUptimeMs: null,
    })
    return { degradedToRestart: false, codePhaseResume: true }
  }

  // Re-queue as-is. No `resumeFrom`: engine checkpoint-resume (runId=task.id)
  // is the single source of truth for which step the re-dispatch skips into.
  // Set requeueAnchorMs to now for the same reason as the code-phase path
  // above: the preserved journal contains step timestamps from the prior run;
  // the ceiling must not use those as the anchor for the current episode.
  await updateTask(id, {
    status: 'queued',
    error: null,
    requeueAnchorMs: Date.now(),
    requeueDispatchUptimeMs: null,
  })
  return { degradedToRestart: false }
}
