/**
 * Dependency-free primitives shared by the blocker-resolution cascade and the
 * Arc aggregate (ADR-0101).
 *
 * Why this module exists: `core/arc.ts` needs the worktree-reset helper, the
 * `worktree-ahead` refusal sentinel, and the failure-reason / action-queue-kind
 * vocabulary that used to live in `core/blocker-resolution.ts`. That file also
 * imports `getTask` from `core/queue.ts` and `raiseRecoveryExhaustedActionQueue`
 * from `core/queue-retry.ts`, both of which lead back to `arc.ts` — so importing
 * it from the aggregate closed an `arc -> blocker-resolution -> queue -> arc`
 * cycle.
 *
 * Everything here is pure data, a pure composer, or a filesystem/git side effect
 * with no domain reads. It imports nothing from `arc.ts`, `queue.ts`,
 * `queue-retry.ts` or `store/task-store.ts`, and must stay that way — the
 * extraction is only worth anything while this module is a genuine leaf.
 */
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { promisify } from 'node:util'
import type { ActionQueueKind } from './action-queue-kinds'
import { ORIGIN_RECOVERY_FAILED_PREFIX } from './failure-signature'
import { raiseActionQueueItem } from './action-queue'
import { WORKTREE_AHEAD_FAILURE_REASON as _WORKTREE_AHEAD_FAILURE_REASON } from './worktree-ahead-payload'
import { readIntegrationBranch } from '../daemon/config'

const execFileP = promisify(execFile)

export const CANCELLED_CASCADE_ACTION_QUEUE_KIND: ActionQueueKind = 'cancelled-blocker-cascade'
export const CANCELLED_FAILURE_REASON = 'cancelled'
export const CANCELLED_CASCADE_FAILURE_REASON = 'cancelled-blocker-cascade'
export { WORKTREE_AHEAD_FAILURE_REASON } from './worktree-ahead-payload'
export const WORKTREE_AHEAD_ACTION_QUEUE_KIND: ActionQueueKind = 'worktree-ahead'

/**
 * Resolve the integration branch name for this repo.
 *
 * Override priority (first wins):
 *   1. `INTEGRATION_BRANCH` env var (per-invocation override)
 *   2. `integrationBranch` key in `.mars/daemon.json` (persisted by `mars init` / `mars operator set`)
 *   3. `'main'` (built-in default)
 */
export const integrationBranchName = (): string =>
  process.env.INTEGRATION_BRANCH ?? readIntegrationBranch() ?? 'main'

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
 * Raise a stored `worktree-ahead` action-queue item for a dependent whose
 * worktree branch has commits ahead of the integration branch at re-dispatch
 * time.  The payload carries the full list of unique commits so the operator
 * can decide whether to `mars purge` (branch already on main — lean PURGE)
 * or `mars restart` (branch diverged — lean RESTART).  When the worktree path
 * is missing on disk the item is still raised with `onMainLean='unknown'` and
 * an empty `commitsAhead` list.
 */
export const raiseWorktreeAheadActionQueue = async (
  taskId: string,
  worktreePath: string,
  aheadCount: number,
  integrationBranch: string,
  _opts?: { leaseOwned?: boolean },
): Promise<void> => {
  let onMainLean: 'on-main' | 'not-on-main' | 'unknown' = 'unknown'
  let commitsAhead: Array<{ shortSha: string; subject: string }> = []

  if (await worktreeExists(worktreePath)) {
    try {
      // exit 0 iff HEAD is an ancestor of integrationBranch (tip already on main)
      await execFileP(
        'git',
        ['merge-base', '--is-ancestor', 'HEAD', integrationBranch],
        { cwd: worktreePath },
      )
      onMainLean = 'on-main'
    } catch {
      onMainLean = 'not-on-main'
    }

    try {
      const { stdout } = await execFileP(
        'git',
        ['log', '--format=%h %s', `${integrationBranch}..HEAD`],
        { cwd: worktreePath },
      )
      commitsAhead = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const spaceIdx = line.indexOf(' ')
          return {
            shortSha: spaceIdx > 0 ? line.slice(0, spaceIdx) : line,
            subject: spaceIdx > 0 ? line.slice(spaceIdx + 1) : '',
          }
        })
    } catch {
      commitsAhead = []
    }
  }

  const leanLine =
    onMainLean === 'on-main'
      ? '\n\nlean PURGE — branch tip is already reachable from the integration branch; use `mars purge`.'
      : onMainLean === 'not-on-main'
        ? '\n\nlean RESTART — branch tip is NOT reachable from the integration branch; use `mars restart`.'
        : ''

  const body =
    `Worktree for task ${taskId} is ${aheadCount} commit(s) ahead of ${integrationBranch}; ` +
    `refused to reset. Resolve the divergence manually before re-dispatching.${leanLine}`

  await raiseActionQueueItem({
    kind: WORKTREE_AHEAD_ACTION_QUEUE_KIND,
    category: 'orchestrator',
    priority: 'high',
    title: `Unblock ${taskId}: worktree is ${aheadCount} commit(s) ahead of ${integrationBranch}`,
    body,
    payload: {
      taskId,
      branch: null,
      worktreePath,
      integrationBranch,
      commitsAhead,
      onMainLean,
      leaseOwned: false,
      failureReason: _WORKTREE_AHEAD_FAILURE_REASON,
    },
    context: {},
    raisedBy: 'orchestrator:blocker-resolution',
    signature: taskId,
    originTaskId: taskId,
  })
}

export const PREREQUISITE_FAILED_ACTION_QUEUE_KIND: ActionQueueKind = 'prerequisite-failed'

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
export { ORIGIN_RECOVERY_FAILED_PREFIX } from './failure-signature'

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

/**
 * No-op: `orphaned-origin` is now a derived kind (ADR-0057). The task is set
 * to `status='failed'` before this is called, so it appears in the derived
 * `failed` rows automatically. Kept as a stub so callers compile without change.
 */
export const raiseOrphanedOriginActionQueue = async (
  _taskId: string,
  _originId: string,
): Promise<void> => {
  // orphaned-origin is derived from tasks.status='failed'; no stored row needed.
}
