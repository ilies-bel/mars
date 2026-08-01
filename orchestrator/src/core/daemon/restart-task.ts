import type { WorkflowStore } from '@mars/workflow'
import { getTask, hasIncompleteBlockers, removeBlocker, TERMINAL_TASK_STATUSES, updateTask } from '../queue'
import { supersedeActionQueueItemsForOrigin } from '../lib/action-queue'
import { getDefaultTaskStore } from '../store/task-store'
import { getDefaultMergeJobStore } from '../store/merge-job-store'

export type RestartErrorCode = 'NOT_FOUND' | 'WRONG_STATUS'

/**
 * The result returned by {@link coreRestartTask}. `status` is the actual
 * status the task landed in after the restart write. Callers that emit
 * `task.queued` events must check this value — only `'queued'` tasks should
 * trigger dispatch.
 */
export interface RestartResult {
  /** The status the task was written to: either `'queued'` or `'blocked'`. */
  status: 'queued' | 'blocked'
}

/**
 * Typed error thrown by {@link coreRestartTask} when the task is not found
 * or is not in an allowed status. Callers (UDS handler, HTTP handler) map
 * the `code` to the appropriate response payload.
 */
export class RestartTaskError extends Error {
  readonly code: RestartErrorCode

  constructor(message: string, code: RestartErrorCode) {
    super(message)
    this.name = 'RestartTaskError'
    this.code = code
  }
}

/**
 * Options for {@link coreRestartTask}.
 *
 * `force`: when `true`, allow restarting a task that is nominally in an
 * in-flight status (`running`, `verifying`) provided its latest durable
 * workflow run is terminal `'failed'`. This handles the stale-verifier
 * scenario: the daemon restarted while a task was verifying, the workflow run
 * recorded a failure (e.g. "working directory no longer exists"), but the task
 * row is stuck in `verifying` because it is not in `allowedStatuses`. Without
 * `--force`, the operator has no supported path to restart the task; with it,
 * the stale run journal is cleared and setup creates a fresh worktree.
 *
 * Note: `merging` and `vega-reconciling` are now included in the normal
 * `allowedStatuses` set by the caller (server.ts `handleRestart` and the
 * HTTP endpoint), so `--force` is not required for those statuses any more.
 *
 * `force` is NOT a bypass for tasks whose workflow run is still active — if
 * `getRun` returns `status='running'` or no run exists at all, the request
 * is refused with `WRONG_STATUS` so active worktrees are never torn down.
 */
export interface RestartOptions {
  /** Allow restart of in-flight tasks whose latest workflow run is failed. */
  force?: boolean
}

/**
 * In-flight statuses that the `force` override covers. These are the states
 * a prior-daemon task can be stranded in with a terminal-failed run record.
 */
const FORCE_ELIGIBLE_STATUSES = new Set([
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
])

/**
 * The row columns that must be cleared for a task to replay from `setup`.
 * Returned by {@link resetForSetupReplay} so the caller can fold them into its
 * own single `updateTask` alongside the status write.
 */
export interface SetupReplayPatch {
  branch: null
  worktreePath: null
  claudeSessionId: null
  requeueAnchorMs: null
  requeueDispatchUptimeMs: null
}

/**
 * Restart-from-setup mechanics, shared by `mars restart` ({@link coreRestartTask})
 * and the environmental auto-restart path in `queue-fix-tasks.ts`.
 *
 * Two halves, and BOTH are required for the next dispatch to actually rebuild a
 * worktree:
 *
 *  1. `deleteRun` discards the durable run journal. Without it the engine
 *     resumes: a `setup` step recorded as `'completed'` short-circuits, so the
 *     only step that can create a worktree never runs again.
 *  2. The returned patch nulls the stale pointers. `branch`/`worktreePath` name
 *     a tree that no longer exists; `requeueAnchorMs`/`requeueDispatchUptimeMs`
 *     anchor the requeue ceiling to a previous episode.
 *
 * This exists as one function precisely because the two halves drifted apart
 * once already: the environmental re-queue cleared the failure markers and set
 * `status='queued'` but did neither of these, so "the worktree is missing" was
 * retried by a dispatch that structurally could not rebuild a worktree —
 * skip setup, fail verify on the same absent directory, repeat.
 *
 * Note `claudeSessionId` is nulled but the `task_claude_sessions` history rows
 * are not: the replay is a fresh coder run, while the history is an audit trail.
 */
export const resetForSetupReplay = async (
  id: string,
  workflowStore: WorkflowStore,
): Promise<SetupReplayPatch> => {
  await workflowStore.deleteRun(id)
  return {
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    requeueAnchorMs: null,
    requeueDispatchUptimeMs: null,
  }
}

/**
 * Core restart mechanics shared by both the UDS RPC handler (`mars restart`)
 * and the HTTP endpoint. Validates the task exists and is in an allowed
 * status, then wipes the worktree/branch, clears the workflow run journal,
 * and re-queues the DB row.
 *
 * The `workflowStore` is used to delete the prior run's checkpoint records
 * so the next dispatch starts from step 0 rather than resuming a stale run.
 * When `options.force` is `true`, it is also used to check whether the latest
 * run is terminal failed before allowing the override.
 *
 * Intentionally has no dependency on the daemon's event bus — the caller
 * is responsible for emitting `task.queued` after this resolves so either
 * transport (socket or HTTP) can wire the dispatch signal itself.
 *
 * @throws {RestartTaskError} with code `'NOT_FOUND'` if the task does not exist
 * @throws {RestartTaskError} with code `'WRONG_STATUS'` if the task's status is
 *   not in `allowedStatuses` (or, with `force`, if the workflow run is not
 *   terminal failed)
 */
export const coreRestartTask = async (
  id: string,
  allowedStatuses: ReadonlySet<string>,
  workflowStore: WorkflowStore,
  options?: RestartOptions,
): Promise<RestartResult> => {
  const { force = false } = options ?? {}
  const task = await getTask(id)
  if (!task) {
    // Resolve any orphaned action-queue row before surfacing the 404 so the
    // card clears from the UI rather than being permanently stuck.
    await supersedeActionQueueItemsForOrigin(id, 'origin-purged', 'restart:task-already-gone')
    throw new RestartTaskError(`task ${id} not found`, 'NOT_FOUND')
  }
  if (!allowedStatuses.has(task.status)) {
    // force=true: allow restart of in-flight tasks whose latest workflow run
    // is terminal failed. This is the recovery path for stale verifier tasks
    // stranded after a daemon restart (e.g. status=verifying, run failed with
    // "working directory no longer exists"). Without this override the operator
    // has no supported path to restart them via `mars restart`.
    if (force && FORCE_ELIGIBLE_STATUSES.has(task.status)) {
      const run = await workflowStore.getRun(id)
      if (run?.status !== 'failed') {
        // Run is still active or no durable run exists — refuse to tear down.
        const runStatus = run?.status ?? 'no-run'
        throw new RestartTaskError(
          `task ${id} is ${task.status} with a non-failed workflow run (status=${runStatus}); ` +
            `--force only applies when the latest workflow run is terminal failed`,
          'WRONG_STATUS',
        )
      }
      // Run is terminal failed — the force override is permitted; proceed.
    } else {
      const allowed = [...allowedStatuses].join('/')
      throw new RestartTaskError(
        `task ${id} is ${task.status}; only ${allowed} tasks can be restarted`,
        'WRONG_STATUS',
      )
    }
  }

  // Guard: refuse if an in-flight recovery (fix-task) is currently active for
  // this task. `mars restart` wipes the worktree and branch, so it would tear
  // down the fix task's worktree from underneath it — corrupting the recovery
  // and leaving the fix task's commits dangling. The operator should wait for
  // the in-flight recovery to complete, then decide whether the result is
  // satisfactory or whether a restart is still needed.
  const taskStore = await getDefaultTaskStore()
  const inflightRows = await taskStore.query({
    sql: `SELECT id FROM tasks
           WHERE fix_for_task_id = ?
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [id],
  })
  if (inflightRows.rows.length > 0) {
    const recoveryId = (inflightRows.rows[0] as unknown as { id: string }).id
    throw new RestartTaskError(
      `task ${id} has an in-flight recovery task ${recoveryId}; wait for the recovery to complete before restarting (or use 'mars continue' to resume once it finishes)`,
      'WRONG_STATUS',
    )
  }

  // Guard: refuse if an active merge job (queued/claimed/running) exists for
  // this task. Restarting would wipe the worktree that the merge worker is
  // operating on, corrupting the merge and leaving the branch in an unknown
  // state. Cancel the merge job first with `mars merge cancel <jobId>`.
  const activeMergeJob = await getDefaultMergeJobStore().getActiveMergeJob(id)
  if (activeMergeJob !== null) {
    throw new RestartTaskError(
      `task ${id} has an active merge job ${activeMergeJob.id}; cancel it with mars merge cancel ${activeMergeJob.id} first`,
      'WRONG_STATUS',
    )
  }

  const { existsSync: exists } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const { removeWorktree } = await import('../lib/git/worktree')
  const { getRepoRoot } = await import('../context')
  const { listUniqueCommitsAhead } = await import('../lib/sweep')
  const { integrationBranchName } = await import('../blocker-resolution')
  const { raiseActionQueueItem } = await import('../lib/action-queue')

  const branch = task.branch ?? `task/${task.id}`
  const repoRoot = getRepoRoot()

  // Worktree directory may be removed — it can be recreated. But the branch
  // ref must survive if it carries unmerged committed work.
  // keepBranch=true: do NOT let removeWorktree delete the branch — the guard
  // below is the sole decision-maker on whether the ref is preserved or removed.
  // Before this fix, keepBranch defaulted to false, so removeWorktree would run
  // `git branch -D` unconditionally; by the time the commits-ahead guard ran the
  // branch was already gone and the guard's preservation path was dead code.
  if (task.worktreePath && exists(task.worktreePath)) {
    await removeWorktree({ path: task.worktreePath, branch }, true, true).catch(
      (err: unknown) => {
        console.warn(
          `[restart-cleanup] worktree remove failed for task ${id} at ${task.worktreePath}: ${String(err)}`,
        )
      },
    )
  }

  // Guard: refuse to delete a branch whose tip is not an ancestor of the
  // integration branch. Commits ahead = work product. Delete the worktree if
  // needed (done above), but preserve the ref; log loudly and raise an
  // action-queue row so the operator can decide what to do.
  const integrationBranch = integrationBranchName()
  const commitsAhead = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
  if (commitsAhead.length > 0) {
    console.warn(
      `[restart-cleanup] PRESERVING branch ${branch} for task ${id}: ` +
        `${commitsAhead.length} unmerged commit(s) ahead of ${integrationBranch} — ` +
        `branch NOT deleted. Use 'mars purge --force ${id}' to remove explicitly.`,
    )
    const { WorktreeAheadPayloadSchema, WORKTREE_AHEAD_FAILURE_REASON: WAF } = await import(
      '../lib/worktree-ahead-payload'
    )
    const typedPayload = WorktreeAheadPayloadSchema.parse({
      taskId: id,
      branch,
      worktreePath: task.worktreePath ?? null,
      integrationBranch,
      commitsAhead,
      onMainLean: 'unknown',
      leaseOwned: Boolean(task.leaseOwner),
      failureReason: WAF,
    })
    await raiseActionQueueItem({
      kind: 'worktree-ahead',
      category: 'orchestrator',
      priority: 'high',
      title: `Branch ${branch} has ${commitsAhead.length} unmerged commit(s) — preserved by restart cleanup`,
      body:
        `Task ${id} was restarted and its branch ${branch} would have been deleted, ` +
        `but it has ${commitsAhead.length} commit(s) ahead of ${integrationBranch}. ` +
        `The branch has been preserved to avoid losing committed work.\n\n` +
        `Resolve manually: inspect the commits and either cherry-pick them onto ` +
        `${integrationBranch} or remove with 'mars purge --force ${id}'.\n\n` +
        `Commits:\n` +
        commitsAhead.map((c) => `  ${c.shortSha} ${c.subject}`).join('\n'),
      payload: typedPayload,
      context: { repoRoot },
      raisedBy: 'restart-cleanup',
      signature: `restart-ahead:${id}`,
      originTaskId: id,
    }).catch(() => {}) // best-effort: action-queue failure must not block the restart
  } else {
    await exec('git', ['branch', '-D', branch], { cwd: repoRoot }).catch(() => {})
  }

  // Discard the prior workflow run journal and collect the pointer-clearing
  // patch so the next dispatch starts from step 0 instead of resuming stale
  // 'completed' step records. Without this, the engine skips setup-worktree and
  // run-claude-code, then fails verify because the worktree no longer exists.
  const setupReplayPatch = await resetForSetupReplay(id, workflowStore)

  // Clear blocker edges that point at failed recovery tasks — these are
  // permanently unsatisfiable. Recovery tasks (kind='fix', fix_for_task_id IS
  // NOT NULL) are non-recoverable leaf nodes by design (ADR-0040/ADR-0060):
  // once they reach 'failed' they can never reach 'done'. A blocker edge on a
  // failed recovery task would strand the origin in 'blocked' forever. Clearing
  // these dead edges before the blocker check lets the origin reach 'queued'
  // without requiring an extra manual `mars unblock` command.
  const deadEdgeRows = await taskStore.query({
    sql: `SELECT b.blocker_task_id
            FROM task_blockers b
            JOIN tasks t ON t.id = b.blocker_task_id
           WHERE b.task_id = ?
             AND t.fix_for_task_id IS NOT NULL
             AND t.status = 'failed'
             AND b.state IN ('confirmed', 'pending-review')`,
    args: [id],
  })
  for (const row of deadEdgeRows.rows) {
    const blockerId = (row as unknown as { blocker_task_id: string }).blocker_task_id
    await removeBlocker(id, blockerId)
  }

  // Guard: if the task still has incomplete blockers, restore it to blocked
  // rather than queued. An operator may restart a failed task whose blockers
  // are themselves not yet done; queuing it would violate the blocker
  // invariant (status='queued' requires ALL blockers to be 'done').
  const hasBlockers = await hasIncompleteBlockers(id)
  const resultStatus: 'queued' | 'blocked' = hasBlockers ? 'blocked' : 'queued'
  // This is the only operator path that may leave a terminal task state.
  // The audited store seam creates the database-authorized transition; no
  // general update or ad-hoc transitional status can bypass the invariant.
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    await taskStore.reopenTerminalTask(id, 'mars restart')
  }
  // Clear all failure markers so a requeued task is never mistakenly tagged as
  // daemon-killed (or any other failure). A non-terminal task (queued/blocked)
  // must not carry a non-empty failureSignature — the daemon-killed sweep keys
  // off that field and would re-raise an orphaned action-queue row on the next
  // daemon start if this stale value were left behind.
  await updateTask(id, {
    status: resultStatus,
    // branch / worktreePath / claudeSessionId / requeueAnchorMs /
    // requeueDispatchUptimeMs all come from resetForSetupReplay. Clearing the
    // continue-set anchor makes the ceiling fall back to MIN(step.startedAt)
    // from the fresh journal entries created by this restart's first dispatch;
    // without it a stale requeueAnchorMs from a previous `mars continue` would
    // anchor the ceiling to the operator's continue time, not the run's start.
    ...setupReplayPatch,
    error: null,
    failedPhase: null,
    failureSignature: null,
    failureReasonCode: null,
    // When remerge set workflow to 'remerge' for routing purposes, a
    // subsequent restart must clear it so the next dispatch runs the full
    // pipeline (setup → code → verify → merge) rather than the remerge
    // shortcut. User-set custom workflow names (non-'remerge') are preserved
    // so live/custom tasks continue to use their intended pipeline.
    ...(task.workflow === 'remerge' ? { workflow: null } : {}),
  })
  return { status: resultStatus }
}
