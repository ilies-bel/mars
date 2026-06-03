import type { WorkflowStore } from '@mars/workflow'
import { getTask, hasIncompleteBlockers, updateTask } from '../queue'

export type RestartErrorCode = 'NOT_FOUND' | 'WRONG_STATUS'

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
 * Core restart mechanics shared by both the UDS RPC handler (`mars restart`)
 * and the HTTP endpoint. Validates the task exists and is in an allowed
 * status, then wipes the worktree/branch, clears the workflow run journal,
 * and re-queues the DB row.
 *
 * The `workflowStore` is used to delete the prior run's checkpoint records
 * so the next dispatch starts from step 0 rather than resuming a stale run.
 *
 * Intentionally has no dependency on the daemon's event bus — the caller
 * is responsible for emitting `task.queued` after this resolves so either
 * transport (socket or HTTP) can wire the dispatch signal itself.
 *
 * @throws {RestartTaskError} with code `'NOT_FOUND'` if the task does not exist
 * @throws {RestartTaskError} with code `'WRONG_STATUS'` if the task's status is
 *   not in `allowedStatuses`
 */
export const coreRestartTask = async (
  id: string,
  allowedStatuses: ReadonlySet<string>,
  workflowStore: WorkflowStore,
): Promise<void> => {
  const task = await getTask(id)
  if (!task) {
    throw new RestartTaskError(`task ${id} not found`, 'NOT_FOUND')
  }
  if (!allowedStatuses.has(task.status)) {
    const allowed = [...allowedStatuses].join('/')
    throw new RestartTaskError(
      `task ${id} is ${task.status}; only ${allowed} tasks can be restarted`,
      'WRONG_STATUS',
    )
  }

  const { existsSync: exists } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const { removeWorktree } = await import('../lib/git/worktree')
  const { getRepoRoot } = await import('../context')

  const branch = task.branch ?? `task/${task.id}`
  if (task.worktreePath && exists(task.worktreePath)) {
    await removeWorktree({ path: task.worktreePath, branch }, true).catch(() => {})
  }
  await exec('git', ['branch', '-D', branch], { cwd: getRepoRoot() }).catch(() => {})

  // Discard the prior workflow run journal so the next dispatch starts from
  // step 0 instead of resuming stale 'completed' step records. Without this,
  // the engine skips setup-worktree and run-claude-code, then fails verify
  // because the worktree no longer exists.
  await workflowStore.deleteRun(id)

  // Guard: if the task still has incomplete blockers, restore it to blocked
  // rather than queued. An operator may restart a failed task whose blockers
  // are themselves not yet done; queuing it would violate the blocker
  // invariant (status='queued' requires ALL blockers to be 'done').
  const hasBlockers = await hasIncompleteBlockers(id)
  await updateTask(id, {
    status: hasBlockers ? 'blocked' : 'queued',
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    error: null,
    failedPhase: null,
  })
}
