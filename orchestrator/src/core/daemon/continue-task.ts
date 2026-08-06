import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getTask, updateTask } from '../queue'
import { getDefaultTaskStore } from '../store/task-store'
import { raiseActionQueueItem } from '../lib/action-queue'
import { computeFailureSignature } from '../lib/failure-signature'
import { coreRestartTask } from './restart-task'
import { createQueueWorkflowStore } from '../../workflows/queue-workflow-store'

/**
 * Injectable supervisor function for the base-refresh conflict handler.
 * When provided, `coreContinueTask` calls this instead of spawning the real
 * vcs-supervisor — enabling deterministic unit tests without a claude binary.
 *
 * The function must either complete the git merge in `worktreePath` (by
 * resolving conflict markers, staging, and committing) or return without
 * doing so. The caller checks `MERGE_HEAD` after the call to decide whether
 * the conflict was resolved — not the return value.
 */
export type ContinueSupervisorFn = (
  branch: string,
  integrationBranch: string,
  worktreePath: string,
) => Promise<unknown>

export interface ContinueResult {
  /**
   * True when the failure was upstream of worktree creation so there is
   * nothing on disk to preserve. In this case continue silently degrades
   * to restart behaviour: the workflow re-enters from setup.
   */
  degradedToRestart: boolean
  /**
   * True when continue rewound the workflow to its coder step while keeping
   * the existing worktree and branch. This covers both an interrupted coder
   * and a verify failure whose fix belongs in the task's own diff.
   */
  coderResume?: boolean
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
 * Verify-phase resume path: the worktree and branch already contain the
 * worker's commits, but the code checkpoint is completed. Continue clears
 * that checkpoint (and its downstream checkpoints), so the same runId
 * re-enters at the coder rather than deterministically retrying verify. The
 * daemon supplies the prior verify output in the coder prompt.
 *
 * Code-phase resume path: the task failed in the code phase
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
 *   - task is not in `'failed'` status
 *   - in-flight recovery exists     — wait for it to complete first
 *
 * Degraded-to-restart set:
 *   - `failedPhase === null`        — failure before any phase was recorded
 *   - no branch / worktreePath      — worktree was never created
 *   - worktree path missing on disk — worktree was created but is gone
 *
 * Intentionally has no dependency on the daemon's event bus — the caller is
 * responsible for emitting `task.queued` after this resolves.
 *
 * @throws if the task does not exist or is not in `'failed'` status.
 */
export const coreContinueTask = async (
  id: string,
  opts: { supervisorFn?: ContinueSupervisorFn } = {},
): Promise<ContinueResult> => {
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

  // `failed` is terminal and general queue updates intentionally cannot leave
  // a terminal state. Continue is an explicit operator action, so reopen it
  // through the audited store seam before applying resume metadata below.
  await store.reopenTerminalTask(id, 'mars continue')

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

    // Fall through to the common base refresh below before re-queuing. A
    // salvage commit is committed work and must be preserved in that merge.
  }

  // A checkpoint-resume skips setup, so it would otherwise run the failed
  // phase against the exact stale branch that failed before main advanced.
  // Merge rather than rebase: worker commits retain their object ids and a
  // conflict leaves no rewritten history for an operator to untangle.
  const integrationBranch = process.env.INTEGRATION_BRANCH ?? 'main'
  try {
    execFileSync('git', ['merge', '--no-edit', integrationBranch], {
      cwd: task.worktreePath as string,
      encoding: 'utf-8',
    })
  } catch (mergeErr) {
    const gitError = mergeErr as Error & { stdout?: string; stderr?: string }
    const output = [gitError.message, gitError.stdout, gitError.stderr]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n')

    if (!/\bCONFLICT\b|Automatic merge failed/i.test(output)) {
      throw new Error(
        `mars continue could not refresh ${task.branch} from ${integrationBranch}: ${output}`,
      )
    }

    // ── Collect conflicted files while the merge is still in progress ────────
    const conflictedFiles: string[] = (() => {
      try {
        const raw = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
          cwd: task.worktreePath as string,
          encoding: 'utf-8',
          stdio: 'pipe',
        }).trim()
        return raw ? raw.split('\n').filter(Boolean) : []
      } catch {
        return []
      }
    })()

    // ── Route to vcs-supervisor (Vega) to reconcile the conflict ─────────────
    // Per CLAUDE.md, conflicts go to vcs-supervisor. Pass an injectable
    // supervisorFn so tests can drive this path without a claude binary.
    const supervisorFn =
      opts.supervisorFn ??
      (async (branch: string, intBranch: string, cwd: string): Promise<unknown> => {
        const { invokeVcsSupervisor, VCS_SUPERVISOR_TIMEOUT_MS } = await import('../lib/git/merge')
        return invokeVcsSupervisor(branch, intBranch, cwd, VCS_SUPERVISOR_TIMEOUT_MS).catch(
          () => null,
        )
      })

    await supervisorFn(
      task.branch as string,
      integrationBranch,
      task.worktreePath as string,
    ).catch((err: unknown) => {
      console.error(`[continue] task ${id}: vcs-supervisor error:`, err)
    })

    // ── Verify by checking git state, not the supervisor's return value ───────
    // MERGE_HEAD exists  → merge still in progress → supervisor did not finish
    // MERGE_HEAD absent  → merge commit landed      → supervisor resolved it
    let mergeHeadExists = true
    try {
      execFileSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], {
        cwd: task.worktreePath as string,
        stdio: 'pipe',
        encoding: 'utf-8',
      })
    } catch {
      // rev-parse exits non-zero when the ref does not exist
      mergeHeadExists = false
    }

    if (!mergeHeadExists) {
      // Supervisor resolved the conflict — fall through to re-queue normally.
      console.log(
        `[continue] task ${id}: vcs-supervisor resolved base-refresh conflict in ${task.worktreePath}`,
      )
    } else {
      // ── Supervisor unavailable or failed — abort and surface an actionable error
      // The worktree must be left clean so the operator can retry or restart.
      try {
        execFileSync('git', ['merge', '--abort'], {
          cwd: task.worktreePath as string,
          encoding: 'utf-8',
          stdio: 'pipe',
        })
      } catch {
        // abort is best-effort; the named failure below is the useful signal
      }

      const conflictsStr =
        conflictedFiles.length > 0
          ? `Conflicting files:\n${conflictedFiles.map((f) => `  - ${f}`).join('\n')}\n\n`
          : ''

      const failureReason = 'continue:base-refresh-conflict'
      const summary =
        `Cannot continue task ${id}: merging ${integrationBranch} into ${task.branch} ` +
        `conflicted in ${task.worktreePath}. The merge was aborted; worker commits remain intact.\n\n` +
        `${conflictsStr}` +
        `To resolve manually:\n` +
        `  cd ${task.worktreePath as string}\n` +
        `  git merge ${integrationBranch}    # re-attempt the merge\n` +
        `  # resolve conflict markers, then: git add <files> && git commit\n` +
        `  mars continue ${id}               # re-queue after resolving\n\n` +
        `Or discard the worker's commits entirely:\n` +
        `  mars restart ${id}`
      await updateTask(
        id,
        {
          status: 'failed',
          error: summary.slice(0, 2000),
          failedPhase: task.failedPhase,
          failureReason,
          failureReasonCode: failureReason,
          failureSignature: computeFailureSignature(failureReason, summary),
        },
        store,
      )
      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Task ${id}: base refresh conflicts with ${integrationBranch}`,
        body:
          `mars continue could not merge ${integrationBranch} into ${task.branch as string}. ` +
          `Worktree: ${task.worktreePath as string}. Branch: ${task.branch as string}.\n\n` +
          conflictsStr +
          `To resolve manually:\n` +
          `  cd ${task.worktreePath as string}\n` +
          `  git merge ${integrationBranch}\n` +
          `  # resolve conflict markers, git add, git commit\n` +
          `  mars continue ${id}\n\n` +
          `Or discard the worker's commits:\n` +
          `  mars restart ${id}`,
        payload: {
          taskId: id,
          branch: task.branch,
          worktreePath: task.worktreePath,
          integrationBranch,
          conflictedFiles,
          failureReason,
        },
        context: {},
        raisedBy: 'continue-task',
        signature: failureReason,
        originTaskId: id,
      })
      throw new Error(summary)
    }
  }

  if (task.failedPhase === 'verify') {
    // A verify failure normally has a completed coder checkpoint, so merely
    // re-queuing would skip code and repeat the same verify inputs forever.
    // Rewind from the standard coder step while preserving setup and every git
    // commit in the worktree. A missing checkpoint is harmless: the engine
    // will execute a step it cannot find on the next dispatch.
    const { clearStepsFromCheckpoint } = await import('../../workflows/queue-workflow-store')
    // The built-in pipeline calls its coder checkpoint `run-claude-code`,
    // while the workflow scaffold documents the equivalent user-authored
    // checkpoint as `code`. Rewind whichever checkpoint this run recorded;
    // otherwise a custom workflow silently skips the coder and just repeats
    // the failed verification.
    const cleared = await clearStepsFromCheckpoint(id, 'run-claude-code')
    if (cleared === null) await clearStepsFromCheckpoint(id, 'code')
  }

  if (task.failedPhase === 'code' || task.failedPhase === 'verify') {
    // Set requeueAnchorMs to now so the poll-fallback ceiling measures elapsed
    // time from this operator-initiated resume, not from the original run's
    // first step (which may be hours or days old — the journal is preserved
    // by design for checkpoint-resume).
    await updateTask(id, {
      status: 'queued',
      error: null,
      requeueAnchorMs: Date.now(),
      requeueDispatchUptimeMs: null,
    }, store)
    return { degradedToRestart: false, coderResume: true }
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
  }, store)
  return { degradedToRestart: false }
}
