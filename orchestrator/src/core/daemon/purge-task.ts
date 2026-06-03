import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { getTask, dropTask, type DropTaskResult } from '../queue'
import {
  listUniqueCommitsAhead,
  type OrphanCommit,
} from '../lib/sweep'

const exec = promisify(execFile)

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

/**
 * Core purge mechanics used by both the UDS RPC handler (`mars purge`) and
 * tests. Validates the task exists and is in a terminal status, checks for
 * unique commits ahead of the integration branch (unless `force=true`), then
 * removes the worktree on disk, force-deletes the branch, and deletes the
 * queue row via `dropTask` (which clears blocker edges atomically).
 *
 * @throws {Error} with message "task <id> not found" if the task does not exist
 * @throws {Error} if the task is not in a terminal status (failed/done)
 * @throws {PurgeAheadError} if `force=false` and the branch has unique commits
 */
export const corePurgeTask = async (
  id: string,
  force: boolean,
  integrationBranch: string,
  repoRoot: string,
): Promise<DropTaskResult> => {
  const task = await getTask(id)
  if (!task) throw new Error(`task ${id} not found`)
  if (task.status !== 'failed' && task.status !== 'done') {
    throw new Error(
      `task ${id} is ${task.status}; refuse to purge in-flight tasks`,
    )
  }

  const branch = task.branch ?? `task/${task.id}`

  // Commit-ahead guard: refuse unless the caller explicitly bypasses with force.
  if (!force) {
    const commits = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
    if (commits.length > 0) {
      throw new PurgeAheadError(id, branch, commits)
    }
  }

  const { removeWorktree } = await import('../lib/git/worktree')

  if (task.worktreePath && existsSync(task.worktreePath)) {
    await removeWorktree({ path: task.worktreePath, branch }, true).catch(() => {})
  }
  await exec('git', ['branch', '-D', branch], { cwd: repoRoot }).catch(() => {})

  return dropTask(id)
}
