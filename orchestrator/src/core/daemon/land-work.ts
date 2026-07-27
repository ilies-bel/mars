/**
 * land-work — operator-triggered merge/cherry-pick handler for worktree-ahead
 * action queue rows.
 *
 * Strategy:
 *   1. Try a fast-forward merge of the task branch onto the integration branch.
 *   2. If fast-forward fails (histories diverged), cherry-pick the ahead commits
 *      oldest-first (listUniqueCommitsAhead returns newest-first, so we reverse).
 *   3. Resolve all open action-queue rows keyed to the task.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getTask } from '../queue'
import { listUniqueCommitsAhead } from '../lib/sweep'
import { integrationBranchName } from '../blocker-resolution'
import { getRepoRoot } from '../context'
import { resolveAllRowsForTask } from '../lib/action-queue'

const exec = promisify(execFile)

export const landWorkForTask = async (id: string): Promise<void> => {
  const task = await getTask(id)
  if (!task) {
    throw Object.assign(new Error(`Task '${id}' not found`), {
      code: 'NOT_FOUND' as const,
    })
  }

  const branch = task.branch ?? `task/${id}`
  const repoRoot = getRepoRoot()
  const integrationBranch = integrationBranchName()

  // Try fast-forward merge first; fall back to cherry-pick if it fails.
  try {
    await exec('git', ['merge', '--ff-only', branch], { cwd: repoRoot })
  } catch {
    const commits = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
    if (commits.length === 0) {
      throw Object.assign(
        new Error(`Branch '${branch}' has no commits ahead of '${integrationBranch}'`),
        { code: 'NO_COMMITS_AHEAD' as const },
      )
    }
    // cherry-pick oldest-first (listUniqueCommitsAhead returns newest-first)
    for (const c of [...commits].reverse()) {
      await exec('git', ['cherry-pick', c.shortSha], { cwd: repoRoot })
    }
  }

  await resolveAllRowsForTask(id)
}
