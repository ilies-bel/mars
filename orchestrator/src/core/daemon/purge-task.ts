import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  getTask,
  dropTask,
  enqueueTask,
  type DropTaskResult,
} from '../queue'
import { Arc } from '../arc'
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
  /**
   * When true, skip the archive row insertion. Use when the caller (e.g.
   * `coreArcPurge`) handles archiving at the arc level to avoid inserting
   * duplicate rows.
   */
  archiveWritten?: boolean
  /** Internal lifecycle variants can widen the terminal status allow-list. */
  acceptedStatuses?: readonly ('failed' | 'done' | 'dropped' | 'blocked')[]
  /** Supersession has independently validated integration evidence. */
  skipCommitAheadGuard?: boolean
  /** A supersede must release its former dependents even when they share its origin. */
  releaseOrphanedDependents?: boolean
  /** Overrides the archive status while preserving the task's original status in memory. */
  archiveTerminalStatus?: string
  /** Evidence persisted for a superseded task. */
  supersededBy?: string | null
  supersedeNote?: string | null
  purgedBy?: 'purge' | 'supersede'
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
      mergeJobsDeleted: 0,
    }
  }
  const acceptedStatuses = opts?.acceptedStatuses ?? ['failed', 'done', 'dropped']
  // acceptedStatuses stays narrow so call sites can only name statuses purge
  // actually accepts; task.status is the full TaskStatus union, and Array
  // .includes() will not take a wider value than its element type. Widening
  // only at the membership test keeps the call-site guarantee intact.
  if (!(acceptedStatuses as readonly string[]).includes(task.status)) {
    throw new Error(
      `task ${id} is ${task.status}; '${opts?.purgedBy === 'supersede' ? 'supersede' : 'purge'}' only accepts ${acceptedStatuses.join('/')} tasks. Use 'mars drop ${id} --force' to delete a task in any status.`,
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
  if (!force && !opts?.skipCommitAheadGuard) {
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

  const dropResult = opts?.releaseOrphanedDependents
    ? await Arc.load(id).drop({ releaseOrphanedDependents: true })
    : await dropTask(id)

  // Compensation task: when force=true and the purged task had integrated work
  // (status='done') and is not a recovery leaf (kind!='fix'), create exactly one
  // cleanup task. The followup_dedup_key makes this idempotent — a repeated
  // force-purge (or a crash-retry) finds the existing task and returns its id.
  // Skip when the caller (e.g. coreArcPurge) handles compensation at arc scope.
  let compensationTaskId: string | undefined

  if (force && capturedStatus === 'done' && capturedKind !== 'fix' && !opts?.skipCompensation) {
    const dedupKey = `task-force-purge-compensation:${id}`
    const store = getDefaultDomainTaskStore()
    const existing = await store.execute({
      sql: `SELECT id FROM tasks WHERE followup_dedup_key = ?`,
      args: [dedupKey],
    })
    const existingRows = existing.rows as unknown as { id: string }[]
    if (existingRows.length > 0) {
      compensationTaskId = existingRows[0].id
    } else {
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
      compensationTaskId = compensationTask.id
    }
  }

  // Archive the purged task (evidence-only, best-effort). Skip when the caller
  // (e.g. coreArcPurge) handles archiving at arc scope to avoid duplicates.
  if (!opts?.archiveWritten) {
    try {
      const { insertPurgeArchiveRow } = await import('./purge-archive.js')
      await insertPurgeArchiveRow({
        id,
        originId: capturedOriginId ?? null,
        branch,
        worktreePath: task.worktreePath ?? null,
        terminalStatus: opts?.archiveTerminalStatus ?? capturedStatus,
        kind: capturedKind,
        prompt: task.prompt,
        intent: capturedIntent,
        integratedCommitsJson: JSON.stringify(evidence.commits),
        compensationTaskId: compensationTaskId ?? null,
        purgedBy: opts?.purgedBy ?? 'purge',
        forceFlag: force,
        supersededBy: opts?.supersededBy,
        supersedeNote: opts?.supersedeNote,
      })
    } catch (e) {
      console.error('[purge-archive] insert failed:', e)
    }
  }

  if (compensationTaskId !== undefined) {
    return { ...dropResult, compensationTaskId }
  }
  return dropResult
}

/**
 * Resolve a stale task whose intended work has already landed. The evidence is
 * checked before any branch, worktree, blocker, or queue mutation happens.
 */
export const coreSupersedeTask = async (
  id: string,
  by: string,
  note: string | undefined,
  integrationBranch: string,
  repoRoot: string,
): Promise<PurgeTaskResult> => {
  if (!by) throw new Error("'--by' is required and must name a landed commit or done task")

  const task = await getTask(id)
  if (!task) throw new Error(`task ${id} not found`)
  if (task.status !== 'failed' && task.status !== 'blocked' && task.status !== 'dropped') {
    throw new Error(
      `task ${id} is ${task.status}; 'supersede' only accepts failed/blocked/dropped tasks`,
    )
  }

  const evidenceTask = await getTask(by)
  if (evidenceTask) {
    if (evidenceTask.status !== 'done') {
      throw new Error(`task ${by} is ${evidenceTask.status}; --by task evidence must be done`)
    }
  } else {
    if (!/^[0-9a-fA-F]{7,64}$/.test(by)) {
      throw new Error(`--by '${by}' is neither a task id nor a commit sha`)
    }
    try {
      await exec('git', ['rev-parse', '--verify', `${by}^{commit}`], { cwd: repoRoot })
      await exec('git', ['merge-base', '--is-ancestor', by, integrationBranch], {
        cwd: repoRoot,
      })
    } catch {
      throw new Error(`commit ${by} is not reachable from integration branch ${integrationBranch}`)
    }
  }

  return corePurgeTask(id, false, integrationBranch, repoRoot, {
    acceptedStatuses: ['failed', 'blocked', 'dropped'],
    skipCommitAheadGuard: true,
    releaseOrphanedDependents: true,
    archiveTerminalStatus: 'superseded',
    supersededBy: by,
    supersedeNote: note ?? null,
    purgedBy: 'supersede',
  })
}
