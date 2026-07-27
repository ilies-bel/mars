import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  getTask,
  dropTask,
  enqueueTask,
  type DropTaskResult,
} from '../queue'
import { teardownDeploymentsForTask } from '../lib/deployment/teardown'
import { getDefaultDomainTaskStore } from '../store/task-store'
import { getDefaultMergeJobStore } from '../store/merge-job-store'
import {
  listUniqueCommitsAhead,
  type OrphanCommit,
} from '../lib/sweep'
import { supersedeActionQueueItemsForOrigin, resolveAllRowsForTask } from '../lib/action-queue'
import { collectIntegrationEvidence, type IntegrationEvidence } from '../lib/collect-integration-evidence'
import { buildCompensationPrompt } from './compensation-prompt'

const exec = promisify(execFile)

/**
 * Return type of {@link corePurgeTask}. Extends {@link DropTaskResult} with an
 * optional `compensationTaskId` field that is populated when a force-purge of a
 * 'done', non-fix task creates (or finds an existing) cleanup/compensation task.
 */
export interface PurgeTaskResult extends DropTaskResult {
  /**
   * Id of the compensation/cleanup task created when `force=true` and the
   * purged task's `status` was `'done'` and its `kind` was not `'fix'`. Absent
   * (undefined) when no compensation task was needed or applicable.
   */
  compensationTaskId?: string
}

/**
 * Error thrown by {@link corePurgeTask} when the branch has unique commits
 * and the caller did not pass `force=true`. The `commits` field lists each
 * unique commit so the caller can surface them in a human-readable refusal.
 */
export class PurgeAheadError extends Error {
  readonly taskId: string
  readonly branch: string
  readonly commits: OrphanCommit[]

  constructor(taskId: string, branch: string, commits: OrphanCommit[]) {
    const lines = commits
      .map((c) => `  ${c.shortSha} ${c.subject}`)
      .join('\n')
    super(
      `task ${taskId} branch ${branch} has ${commits.length} unique commit(s) ahead of the integration branch:\n${lines}\nPass --force to delete anyway.`,
    )
    this.name = 'PurgeAheadError'
    this.taskId = taskId
    this.branch = branch
    this.commits = commits
  }
}

export interface CorePurgeTaskOptions {
  /**
   * When true, skip the single-task compensation task creation even if
   * `force=true` and the task was `'done'`. Use this when the caller (e.g.
   * `coreArcPurge`) will handle compensation at a higher level (arc-scope).
   */
  skipCompensation?: boolean
}

/**
 * Core purge mechanics used by both the UDS RPC handler (`mars purge`) and
 * tests. Validates the task exists and is in a terminal status, checks for
 * unique commits ahead of the integration branch (unless `force=true`), then
 * removes the worktree on disk, force-deletes the branch, and deletes the
 * queue row via `dropTask` (which clears blocker edges atomically).
 *
 * @throws {Error} with message "task <id> not found" if the task does not exist
 * @throws {Error} if the task is not in a terminal status (failed/done/dropped)
 * @throws {PurgeAheadError} if `force=false` and the branch has unique commits
 */
export const corePurgeTask = async (
  id: string,
  force: boolean,
  integrationBranch: string,
  repoRoot: string,
  opts?: CorePurgeTaskOptions,
): Promise<PurgeTaskResult> => {
  const task = await getTask(id)
  if (!task) {
    // Task is already gone — the purge goal is already achieved. Resolve any
    // still-open action-queue rows so orphaned cards don't get stuck, then
    // return a synthetic success result. Do NOT call dropTask (no row to drop).
    await supersedeActionQueueItemsForOrigin(id, 'origin-purged', 'purge:task-already-gone')
    return {
      taskId: id,
      previousStatus: 'failed',
      edgesRemoved: { incoming: 0, outgoing: 0 },
      cascadedFixTaskIds: [],
    }
  }
  if (task.status !== 'failed' && task.status !== 'done' && task.status !== 'dropped') {
    throw new Error(
      `task ${id} is ${task.status}; refuse to purge in-flight tasks`,
    )
  }

  // Best-effort: tear down any preview deployments for this task before the row
  // is deleted (ON DELETE CASCADE would also remove the deployment rows, but we
  // want to actually decommission the remote environment first). Errors are
  // caught and logged inside teardownDeploymentsForTask — never rethrown.
  await teardownDeploymentsForTask(id)

  // Capture task metadata BEFORE deletion — needed for compensation task creation.
  const capturedStatus = task.status
  const capturedKind = task.kind ?? 'task'
  const capturedOriginId = task.originId
  const capturedIntent = task.intent || task.prompt.split('\n')[0]

  const branch = task.branch ?? `task/${task.id}`

  // Commit-ahead guard: refuse unless the caller explicitly bypasses with force.
  if (!force) {
    const commits = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
    if (commits.length > 0) {
      throw new PurgeAheadError(id, branch, commits)
    }
  }

  // Guard: refuse if an active merge job (queued/claimed/running) exists for
  // this task. Purging would wipe the worktree under an in-flight merge,
  // corrupting the merge operation and leaving the branch in an unknown state.
  // Cancel the merge job first with `mars merge cancel <jobId>`.
  const activeMergeJob = await getDefaultMergeJobStore().getActiveMergeJob(id)
  if (activeMergeJob !== null) {
    throw new Error(
      `task ${id} has an active merge job ${activeMergeJob.id}; cancel it with mars merge cancel ${activeMergeJob.id} first`,
    )
  }

  // Collect integration evidence BEFORE deleting the branch. This must run
  // while the branch still exists locally. Only collect when compensation
  // will actually be created (force + done + non-fix + no skipCompensation).
  let evidence: IntegrationEvidence = { commits: [], touchedFiles: [] }
  if (force && capturedStatus === 'done' && capturedKind !== 'fix' && !opts?.skipCompensation) {
    evidence = await collectIntegrationEvidence(branch, integrationBranch, repoRoot)
  }

  const { removeWorktree } = await import('../lib/git/worktree')

  if (task.worktreePath && existsSync(task.worktreePath)) {
    await removeWorktree({ path: task.worktreePath, branch }, true).catch(() => {})
  }
  await exec('git', ['branch', '-D', branch], { cwd: repoRoot }).catch(() => {})

  // Clean up git artifacts for every cascade fix task before the DB drop.
  // dropTask will delete the fix task rows atomically; we handle the on-disk
  // cleanup here, mirroring the worktree+branch -D treatment above (ADR-0049).
  const fixTasks = await getDefaultDomainTaskStore().listFixTasksByOrigin(id)
  for (const r of fixTasks) {
    const fixBranch = r.branch ?? `task/${r.id}`
    if (r.worktreePath && existsSync(r.worktreePath)) {
      await removeWorktree({ path: r.worktreePath, branch: fixBranch }, true).catch(() => {})
    }
    await exec('git', ['branch', '-D', fixBranch], { cwd: repoRoot }).catch(() => {})
  }

  // Belt-and-suspenders: close action-queue rows for this task inline, before
  // the task row is deleted. The primary path is event-driven:
  // dropTask emits task.dropped{dropReason:'purged'} in the same atomic
  // transaction as DELETE FROM tasks, and both the Invalidator (alert-dismisser)
  // and the repopulator drain that event to resolve open rows. This inline call
  // is a synchronous backstop — it ensures stale cards clear immediately even if
  // the daemon's event drain has not run yet. Both calls are idempotent with the
  // event-based closures (a row already resolved is a silent no-op).
  await resolveAllRowsForTask(id)
  await supersedeActionQueueItemsForOrigin(id, 'origin-purged', 'purge:pre-delete')

  const dropResult = await dropTask(id)

  // Compensation task: when force=true and the purged task had integrated work
  // (status='done') and is not a recovery leaf (kind!='fix'), create exactly one
  // cleanup task. The followup_dedup_key makes this idempotent — a repeated
  // force-purge (or a crash-retry) finds the existing task and returns its id.
  // Skip when the caller (e.g. coreArcPurge) handles compensation at arc scope.
  if (!force || capturedStatus !== 'done' || capturedKind === 'fix' || opts?.skipCompensation) {
    return dropResult
  }

  const dedupKey = `task-force-purge-compensation:${id}`
  const store = getDefaultDomainTaskStore()
  const existing = await store.execute({
    sql: `SELECT id FROM tasks WHERE followup_dedup_key = ?`,
    args: [dedupKey],
  })
  const existingRows = existing.rows as unknown as { id: string }[]
  if (existingRows.length > 0) {
    return { ...dropResult, compensationTaskId: existingRows[0].id }
  }

  const prompt = buildCompensationPrompt({
    kind: 'task',
    originId: id,
    originTitle: capturedIntent,
    integrationBranch,
    entries: [{ memberId: id, branch, evidence }],
  })
  const compensationTask = await enqueueTask(
    prompt,
    undefined,
    {
      skipTriage: true,
      compensatesArcId: capturedOriginId,
      followupDedupKey: dedupKey,
      intent: `Compensate for force-purged task ${id}`,
    },
  )

  return { ...dropResult, compensationTaskId: compensationTask.id }
}
