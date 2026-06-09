import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { promisify } from 'node:util'
import {
  raiseRetryBudgetExhaustedActionQueue,
} from './queue-retry'
import { getTask } from './queue'
import { type ActionQueueKind, raiseActionQueueItem } from './lib/action-queue'

const execFileP = promisify(execFile)

export const CANCELLED_CASCADE_ACTION_QUEUE_KIND: ActionQueueKind = 'cancelled-blocker-cascade'
export const CANCELLED_FAILURE_REASON = 'cancelled'
export const CANCELLED_CASCADE_FAILURE_REASON = 'cancelled-blocker-cascade'
export const WORKTREE_AHEAD_FAILURE_REASON =
  'worktree_ahead_of_integration_at_unblock'
export const WORKTREE_AHEAD_ACTION_QUEUE_KIND: ActionQueueKind = 'worktree-ahead'

export const integrationBranchName = (): string =>
  process.env.INTEGRATION_BRANCH ?? 'main'

/**
 * Refusal sentinel: a dependent's worktree branch has commits ahead of the
 * integration branch at re-dispatch time. Per the slice contract we never
 * auto-rebase — the operator must resolve manually.
 */
export class WorktreeAheadOfIntegrationError extends Error {
  readonly taskId: string
  readonly worktreePath: string
  readonly aheadCount: number
  readonly integrationBranch: string
  constructor(
    taskId: string,
    worktreePath: string,
    aheadCount: number,
    integrationBranch: string,
  ) {
    super(
      `worktree for task ${taskId} at ${worktreePath} is ${aheadCount} commit(s) ahead of ${integrationBranch}; refusing to reset`,
    )
    this.taskId = taskId
    this.worktreePath = worktreePath
    this.aheadCount = aheadCount
    this.integrationBranch = integrationBranch
    this.name = 'WorktreeAheadOfIntegrationError'
  }
}

const worktreeExists = async (worktreePath: string): Promise<boolean> => {
  try {
    await access(worktreePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Hard-reset a dependent's worktree branch to the current integration HEAD
 * before re-dispatching it, so the dispatched implementor observes a tree
 * that already contains its blocker's landed commits.
 *
 * No-op when the worktree row has no path yet, or the path is missing on
 * disk — the implement workflow's setup step will create a fresh worktree
 * off the integration branch in that case.
 *
 * Refuses (throws WorktreeAheadOfIntegrationError) if the dependent branch
 * has its own commits ahead of the integration branch. We never auto-rebase
 * here; the operator must resolve the divergence explicitly.
 *
 * Best-effort `git fetch origin <integration>` first so a tracked remote
 * advances the local ref; in the orchestrator's local-only test repos the
 * fetch is expected to fail and is silently ignored.
 */
export const resetDependentWorktreeToIntegration = async (
  taskId: string,
  worktreePath: string | null,
  integrationBranch: string,
): Promise<{ reset: boolean; reason: 'no-worktree' | 'worktree-missing' | 'reset' }> => {
  if (!worktreePath) return { reset: false, reason: 'no-worktree' }
  if (!(await worktreeExists(worktreePath))) {
    return { reset: false, reason: 'worktree-missing' }
  }
  try {
    await execFileP('git', ['fetch', 'origin', integrationBranch], {
      cwd: worktreePath,
    })
  } catch {
    /* local-only repo / transient remote error — proceed with local ref */
  }
  const ahead = await execFileP(
    'git',
    ['rev-list', '--count', `${integrationBranch}..HEAD`],
    { cwd: worktreePath },
  )
  const aheadCount = Number(ahead.stdout.trim())
  if (aheadCount > 0) {
    throw new WorktreeAheadOfIntegrationError(
      taskId,
      worktreePath,
      aheadCount,
      integrationBranch,
    )
  }
  await execFileP('git', ['reset', '--hard', integrationBranch], {
    cwd: worktreePath,
  })
  return { reset: true, reason: 'reset' }
}

export const raiseWorktreeAheadActionQueue = async (
  taskId: string,
  worktreePath: string,
  aheadCount: number,
  integrationBranch: string,
): Promise<void> => {
  try {
    await raiseActionQueueItem({
      kind: WORKTREE_AHEAD_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${taskId} worktree is ahead of ${integrationBranch} at unblock`,
      body:
        `Task ${taskId} was about to be re-dispatched after its blocker(s) resolved, ` +
        `but its worktree at ${worktreePath} is ${aheadCount} commit(s) ahead of ` +
        `${integrationBranch}. Mars refuses to auto-rebase a dependent that has ` +
        `its own work on the branch.\n\n` +
        `Resolve manually: inspect the worktree and decide whether to land or drop ` +
        `those commits before retrying.`,
      payload: {
        taskId,
        worktreePath,
        aheadCount,
        integrationBranch,
        failureReason: WORKTREE_AHEAD_FAILURE_REASON,
      },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: 'agent:blocker-resolution',
      signature: `${taskId}:worktree-ahead`,
      originTaskId: taskId,
      occurrence: {
        at: new Date().toISOString(),
        aheadCount,
      },
    })
  } catch {
    /* best-effort: actionQueue failure must not block the cascade */
  }
}

export const PREREQUISITE_FAILED_ACTION_QUEUE_KIND: ActionQueueKind = 'prerequisite-failed'

export interface BlockByFailureOutcome {
  taskId: string
  outcome: 'blocked' | 'noop'
}

export interface BlockByFailureResult {
  failedBlockerTaskId: string
  outcomes: BlockByFailureOutcome[]
}

export interface UnblockOutcome {
  taskId: string
  outcome: 'queued' | 'failed' | 'noop'
  retryCount: number
  failureReason?: string
}

export interface UnblockByTaskResult {
  blockerTaskId: string
  outcomes: UnblockOutcome[]
}

export interface BlockedDependentRow {
  id: string
  retry_count: number | null
}

export const RETRY_BUDGET_FAILURE_REASON = 'retry_budget_exhausted_at_unblock'

export const ORPHANED_ORIGIN_FAILURE_REASON = 'orphaned_origin_at_unblock'
export const ORPHANED_ORIGIN_ACTION_QUEUE_KIND: ActionQueueKind = 'orphaned-origin'

export const raiseOrphanedOriginActionQueue = async (
  taskId: string,
  originId: string,
): Promise<void> => {
  try {
    await raiseActionQueueItem({
      kind: ORPHANED_ORIGIN_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'normal',
      title: `Task ${taskId} unblocked but its origin ${originId} no longer exists`,
      body:
        `Task ${taskId} was about to be re-dispatched after its blocker(s) resolved, ` +
        `but its origin_id points at ${originId} which no longer exists in the tasks table. ` +
        `The dependent has been failed to prevent running a coder against a vanished target.\n\n` +
        `Resolve manually: decide whether to drop the task or restart it with a valid origin.`,
      payload: {
        taskId,
        originId,
        failureReason: ORPHANED_ORIGIN_FAILURE_REASON,
      },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: 'agent:blocker-resolution',
      signature: `${taskId}:orphaned-origin`,
      originTaskId: taskId,
      occurrence: {
        at: new Date().toISOString(),
        originId,
      },
    })
  } catch {
    /* best-effort: actionQueue failure must not block the cascade */
  }
}

/**
 * A blocked dependent is failed at unblock time only when its retry
 * budget is actually spent: it has burned at least one retry
 * (retryCount > 0) AND has no remaining budget (retryCount >= budget).
 *
 * DEFAULT_RETRY_BUDGET is 0, so a fresh, never-run dependent has
 * retryCount=0/budget=0 and must still pass through to `queued` — a
 * blanket `>=` would fail every fresh dependent (0 >= 0). The
 * `retryCount > 0` clause preserves that fresh case while still failing
 * a dependent that burned a retry under the default budget=0
 * (retryCount=1, budget=0) and one that exhausted an explicit budget
 * (retryCount=1, budget=1 — the old `>` let this slip to `queued`).
 *
 * Used by Arc.unblockByCompletion (the live path driven by the outbox subscriber).
 */
export const retryBudgetExhausted = (retryCount: number, budget: number): boolean =>
  retryCount > 0 && retryCount >= budget

export const raiseActionQueueForBlockedTask = async (taskId: string): Promise<void> => {
  const task = await getTask(taskId)
  if (!task) return
  const error = task.error ?? ''
  // Step names can be compound (e.g. "verify:test"), so split on ": " (colon-space)
  // rather than just ":" to get the full step name including sub-step.
  const colonSpace = error.indexOf(': ')
  const lastStep =
    colonSpace > 0 ? error.slice(0, colonSpace).trim() : 'blocked-dependent'
  const lastErrorSummary =
    colonSpace > 0 ? error.slice(colonSpace + 2).trim() : error
  await raiseRetryBudgetExhaustedActionQueue({
    taskId,
    lastStep,
    retryCount: task.retryCount,
    lastErrorSignature: task.failureSignature,
    lastErrorSummary: lastErrorSummary || null,
    branch: task.branch,
    worktreePath: task.worktreePath,
  })
}

export interface PropagateRecoveryDoneResult {
  originTaskId: string
  originFlipped: boolean
  unblock: UnblockByTaskResult | null
  actionQueueItemsClosed: number
}

export interface RecoverBlockedTaskOutcome {
  taskId: string
  outcome: 'queued' | 'noop' | 'failed' | 'not-blocked'
  retryCount: number
  failureReason?: string
}

export interface RecoverAllBlockedTasksResult {
  outcomes: RecoverBlockedTaskOutcome[]
}
