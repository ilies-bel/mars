/**
 * landTask — first-class operator gesture to land the commits of a
 * worktree-ahead task onto the integration branch.
 *
 * This is the recovery path for the `worktree-ahead` action-queue item raised
 * when `resetDependentWorktreeToIntegration` refuses to reset a worktree whose
 * branch has commits ahead of integration at unblock time.
 *
 * Sequencing:
 * 1. Validate task, branch, worktree, and ahead-count.
 * 2. Run the task's configured verify gate (DB-backed verify_gates table).
 * 3. Acquire the `.merge.lock` and confirm the branch is a clean fast-forward
 *    of the current integration tip; refuse non-destructively if not (conflict).
 * 4. Fast-forward integration to the task branch via `git update-ref`.
 * 5. Mark the task done, resolve all associated action-queue rows, and remove
 *    the worktree/branch (best-effort).
 *
 * Never auto-rebases. Never discards unique work. The branch is left intact on
 * any failure so the operator can resolve manually.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { access, constants as fsConstants, mkdir } from 'node:fs/promises'
import { integrationBranchName } from './blocker-resolution'
import {
  getTask,
  updateTask,
  resolveQueueClient,
  reopenTerminalTask,
  TERMINAL_TASK_STATUSES,
} from './queue'
import { getRepoRoot, getStateDir } from './context'
import { acquireLock } from './lib/git/lock'
import { resolveAllRowsForTask } from './lib/action-queue'
import {
  getChangedFiles,
  selectVerifySteps,
  verifyChanges,
} from './lib/git/verify'
import { loadVerifyGates } from './verify-gates'
import { removeWorktree } from './lib/git/worktree'
import { provisionWorktreeDeps } from './lib/worktree-deps'

const execFileP = promisify(execFile)

export type LandTaskOutcome =
  | 'landed'
  | 'verify-failed'
  | 'conflict'
  | 'not-ahead'
  | 'task-not-found'
  | 'no-worktree'

export interface LandTaskResult {
  outcome: LandTaskOutcome
  message: string
  aheadCount?: number
  verifyOutput?: string
}

/** Default merge-lock acquisition ceiling (60 s). */
const DEFAULT_LOCK_TIMEOUT_MS = 60_000

/**
 * Land the commits of task `taskId` onto the integration branch.
 *
 * @param taskId          The task to land.
 * @param lockTimeoutMs   How long to wait for `.merge.lock` (default 60 s).
 */
export const landTask = async (
  taskId: string,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<LandTaskResult> => {
  // ── 1. Load task ─────────────────────────────────────────────────────────
  const task = await getTask(taskId)
  if (!task) {
    return {
      outcome: 'task-not-found',
      message: `task ${taskId} not found`,
    }
  }

  const branch = task.branch ?? `task/${taskId}`
  const integrationBranch = integrationBranchName()
  const repoRoot = getRepoRoot()

  // ── 2. Count commits ahead ────────────────────────────────────────────────
  let aheadCount: number
  try {
    const { stdout } = await execFileP(
      'git',
      ['rev-list', '--count', `${integrationBranch}..${branch}`],
      { cwd: repoRoot },
    )
    aheadCount = Number(stdout.trim())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      outcome: 'not-ahead',
      message: `could not determine ahead-count for ${branch}: ${msg}`,
    }
  }

  if (aheadCount === 0) {
    return {
      outcome: 'not-ahead',
      message: `branch ${branch} has no commits ahead of ${integrationBranch} — nothing to land`,
    }
  }

  // ── 3. Restore worktree from the preserved branch when needed ────────────
  // A missing worktree is recoverable as long as the ahead branch still
  // exists. Never send the operator to `restart` here: restart intentionally
  // discards this branch's work in order to start a new implementation.
  const worktreePath = task.worktreePath ?? resolve(getStateDir(), 'worktrees', taskId)
  try {
    await access(worktreePath, fsConstants.F_OK)
  } catch {
    try {
      await mkdir(dirname(worktreePath), { recursive: true })
      await execFileP('git', ['worktree', 'add', '--force', worktreePath, branch], {
        cwd: repoRoot,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        outcome: 'no-worktree',
        message:
          `could not recreate missing worktree at ${worktreePath} from ${branch}: ${msg}. ` +
          `The branch was left intact; recreate it with \`git worktree add ${worktreePath} ${branch}\` and retry \`mars land ${taskId}\`.`,
      }
    }
  }
  await provisionWorktreeDeps({ worktreeRoot: worktreePath, sourceRoot: repoRoot })

  // ── 4. Run verify gate ────────────────────────────────────────────────────
  const client = resolveQueueClient()
  const scopes = await loadVerifyGates(client)
  const changedFiles = await getChangedFiles(worktreePath, integrationBranch, branch)
  const steps = selectVerifySteps(scopes, changedFiles)

  const verifyResult = await verifyChanges({
    cwd: worktreePath,
    steps,
    branch,
    integrationBranch,
    changedFiles,
  })

  if (!verifyResult.passed) {
    const verifyOutput = verifyResult.steps
      .map((s) => `${s.name}: ${s.passed ? 'PASS' : 'FAIL'}\n${s.output}`)
      .join('\n---\n')
    return {
      outcome: 'verify-failed',
      message: `verify gate failed — branch ${branch} left intact`,
      aheadCount,
      verifyOutput,
    }
  }

  // ── 5. Acquire merge lock and fast-forward ────────────────────────────────
  const release = await acquireLock(
    resolve(getStateDir(), '.merge.lock'),
    lockTimeoutMs,
  )
  let integrationSha: string
  let branchSha: string
  try {
    integrationSha = (
      await execFileP('git', ['rev-parse', integrationBranch], { cwd: repoRoot })
    ).stdout.trim()
    branchSha = (
      await execFileP('git', ['rev-parse', branch], { cwd: repoRoot })
    ).stdout.trim()

    // Confirm fast-forward: integration must be an ancestor of branch tip.
    // `git merge-base --is-ancestor` exits 0 when ancestor, 1 when not.
    try {
      await execFileP(
        'git',
        ['merge-base', '--is-ancestor', integrationSha, branchSha],
        { cwd: repoRoot },
      )
    } catch {
      // integration has advanced independently — refuse non-destructively.
      return {
        outcome: 'conflict',
        message:
          `cannot fast-forward ${integrationBranch} to ${branch}: ` +
          `the integration branch has commits that are not in ${branch}. ` +
          `Rebase ${branch} onto ${integrationBranch} locally, then retry 'mars land ${taskId}'.`,
        aheadCount,
      }
    }

    // Atomic CAS fast-forward — does not touch any working tree.
    await execFileP(
      'git',
      ['update-ref', `refs/heads/${integrationBranch}`, branchSha, integrationSha],
      { cwd: repoRoot },
    )
  } finally {
    await release()
  }

  // ── 6. Mark task done ─────────────────────────────────────────────────────
  // `landTask` is the operator gesture for a task that has ALREADY reached a
  // terminal status (typically 'failed') but whose worktree carries commits
  // worth keeping. Terminal statuses are absorbing, so the done transition
  // needs an audited reopen grant first — without it `updateTask` throws
  // IllegalTransitionError *after* step 5 already fast-forwarded the
  // integration branch, stranding the operator with landed commits, a task
  // still marked failed, unresolved action-queue rows and an uncleaned
  // worktree.
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    await reopenTerminalTask(taskId, 'operator landed worktree-ahead commits')
  }
  // `updateTask` with status='done' enforces the done-implies-merged invariant
  // (ADR-0052): it checks aheadCount again and redirects to 'failed' if the
  // branch still has commits. Since we just fast-forwarded integration to the
  // branch tip, the branch is now 0 commits ahead and the transition succeeds.
  await updateTask(taskId, { status: 'done' })

  // ── 7. Resolve action-queue rows ─────────────────────────────────────────
  await resolveAllRowsForTask(taskId)

  // ── 8. Clean up worktree/branch (best-effort) ─────────────────────────────
  try {
    await removeWorktree({ path: worktreePath, branch }, /* force */ true, /* keepBranch */ false)
  } catch {
    // Non-fatal: the land already succeeded; leave the cleanup for 'mars worktree clean'.
  }

  return {
    outcome: 'landed',
    message:
      `landed task ${taskId}: fast-forwarded ${integrationBranch} to ${branch} ` +
      `(${aheadCount} commit(s))`,
    aheadCount,
  }
}
