import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { promisify } from 'node:util'
import {
  raiseRecoveryExhaustedActionQueue,
} from './queue-retry'
import { getTask } from './queue'
import { type ActionQueueKind, raiseActionQueueItem } from './lib/action-queue'
import {
  WORKTREE_AHEAD_FAILURE_REASON,
  WorktreeAheadPayloadSchema,
  type WorktreeAheadPayload,
} from './lib/worktree-ahead-payload'
import { type OrphanCommit, listUniqueCommitsAhead } from './lib/sweep'
import { ORIGIN_RECOVERY_FAILED_PREFIX } from './lib/failure-signature'

const execFileP = promisify(execFile)

export const CANCELLED_CASCADE_ACTION_QUEUE_KIND: ActionQueueKind = 'cancelled-blocker-cascade'
export const CANCELLED_FAILURE_REASON = 'cancelled'
export const CANCELLED_CASCADE_FAILURE_REASON = 'cancelled-blocker-cascade'
export { WORKTREE_AHEAD_FAILURE_REASON } from './lib/worktree-ahead-payload'
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

/**
 * Best-effort check: is the worktree's current HEAD commit reachable from the
 * integration branch (i.e. already landed on main)?
 *
 * Returns:
 *  - 'on-main'     — HEAD is an ancestor of integrationBranch (git exit 0)
 *  - 'not-on-main' — HEAD is NOT an ancestor (git exit 1)
 *  - 'unknown'     — worktree missing, rev-parse failed, or unexpected git error
 *
 * Never throws. Fetch failure is silently swallowed (same as
 * resetDependentWorktreeToIntegration) so local-only test repos work.
 */
const computeOnMainLean = async (
  worktreePath: string,
  integrationBranch: string,
): Promise<'on-main' | 'not-on-main' | 'unknown'> => {
  try {
    if (!(await worktreeExists(worktreePath))) return 'unknown'
    try {
      await execFileP('git', ['fetch', 'origin', integrationBranch], { cwd: worktreePath })
    } catch {
      /* local-only repo / transient remote error — proceed with local ref */
    }
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
    const tipSha = stdout.trim()
    try {
      await execFileP(
        'git',
        ['merge-base', '--is-ancestor', tipSha, integrationBranch],
        { cwd: worktreePath },
      )
      return 'on-main'
    } catch (err) {
      // exit 1 → definitive "not an ancestor"; anything else is an error
      if ((err as { code?: unknown }).code === 1) return 'not-on-main'
      return 'unknown'
    }
  } catch {
    return 'unknown'
  }
}

export const raiseWorktreeAheadActionQueue = async (
  taskId: string,
  worktreePath: string,
  aheadCount: number,
  integrationBranch: string,
  opts?: { leaseOwned?: boolean },
): Promise<void> => {
  const lean = await computeOnMainLean(worktreePath, integrationBranch)
  const leanLine =
    lean === 'on-main'
      ? '\n\nThis work appears to already be on main — lean PURGE.'
      : lean === 'not-on-main'
        ? '\n\nThis work is NOT on main — lean RESTART.'
        : ''

  const repoRoot = process.env.MARS_REPO ?? process.cwd()
  const branch = `task/${taskId}`
  const commitsAhead = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot).catch(
    () => [] as OrphanCommit[],
  )

  const payload: WorktreeAheadPayload = WorktreeAheadPayloadSchema.parse({
    taskId,
    branch,
    worktreePath,
    integrationBranch,
    commitsAhead,
    onMainLean: lean,
    leaseOwned: opts?.leaseOwned ?? false,
    failureReason: WORKTREE_AHEAD_FAILURE_REASON,
  })

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
        `those commits before retrying.` +
        leanLine,
      payload,
      context: { repoRoot },
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

export interface FailStrandedOriginOutcome {
  originTaskId: string
  recoveryTaskId: string
  outcome: 'failed' | 'noop'
}

export interface FailStrandedOriginResult {
  recoveryTaskId: string
  outcomes: FailStrandedOriginOutcome[]
}

/**
 * The `failure_reason` prefix stamped on an ORIGIN that was failed because its
 * own (leaf, one-shot) recovery Chore failed — ADR-0040 / CLAUDE.md § Blockers:
 * "if [the recovery] fails for any reason … the origin goes to `failed` with one
 * actionable action queue item and the operator resolves it explicitly".
 *
 * Composed form: `origin_recovery_failed:<recoveryTaskId>`.
 *
 * The prefix is load-bearing, not cosmetic: it is one entry in
 * `TERMINAL_VERDICT_PREFIXES`, the vocabulary the recovery-spawner consults to
 * recognise that a row's automated options are already spent and it must NOT be
 * re-driven into a second recovery (which would violate the exactly-one-recovery
 * rule and re-open the strand loop from the other side).
 *
 * The constant itself lives in `lib/failure-signature.ts` alongside its sibling
 * prefixes, so there is exactly one place to look for the full vocabulary; it is
 * re-exported here for the callers that reason about this specific verdict.
 */
export { ORIGIN_RECOVERY_FAILED_PREFIX } from './lib/failure-signature'

/** Compose the origin's failure reason for a dead recovery. */
export const composeOriginRecoveryFailedReason = (recoveryTaskId: string): string =>
  `${ORIGIN_RECOVERY_FAILED_PREFIX}${recoveryTaskId}`

// `RECOVERY_EXHAUSTED_FAILURE_REASON = 'recovery_exhausted_at_unblock'` was
// deleted here. The gate that wrote it was removed in mars-3d63fe52, leaving an
// exported constant nothing wrote — a name one letter away from the live
// `recovery_exhausted:` prefix, sitting in the file the vocabulary guards read.
// Exactly the kind of near-miss that makes a maintainer add a second literal.

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
  await raiseRecoveryExhaustedActionQueue({
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
