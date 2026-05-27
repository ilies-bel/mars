import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { promisify } from 'node:util'
import { internalBus } from '../internal-bus'
import {
  getRetryBudget,
  markTaskFailed,
  raiseRetryBudgetExhaustedInbox,
} from './queue-retry'
import { getTask, updateTask } from './queue'
import { getDefaultQueueClient } from './lib/task-store'
import { type InboxKind, raiseInboxItem, supersedeInboxItemsForOrigin } from './lib/inbox'
import { publish } from './lib/outbox'

const execFileP = promisify(execFile)

export const CANCELLED_CASCADE_INBOX_KIND: InboxKind = 'cancelled-blocker-cascade'
export const CANCELLED_FAILURE_REASON = 'cancelled'
const CANCELLED_CASCADE_FAILURE_REASON = 'cancelled-blocker-cascade'
export const WORKTREE_AHEAD_FAILURE_REASON =
  'worktree_ahead_of_integration_at_unblock'
export const WORKTREE_AHEAD_INBOX_KIND: InboxKind = 'worktree-ahead'

const integrationBranchName = (): string =>
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

const raiseWorktreeAheadInbox = async (
  taskId: string,
  worktreePath: string,
  aheadCount: number,
  integrationBranch: string,
): Promise<void> => {
  try {
    await raiseInboxItem({
      kind: WORKTREE_AHEAD_INBOX_KIND,
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
    /* best-effort: inbox failure must not block the cascade */
  }
}

export const PREREQUISITE_FAILED_INBOX_KIND: InboxKind = 'prerequisite-failed'

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

interface BlockedDependentRow {
  id: string
  retry_count: number | null
}

const RETRY_BUDGET_FAILURE_REASON = 'retry_budget_exhausted_at_unblock'

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
 * Shared by both onBlockerTaskCompleted and recoverBlockedTasks so the
 * two paths stay in lock-step.
 */
const retryBudgetExhausted = (retryCount: number, budget: number): boolean =>
  retryCount > 0 && retryCount >= budget

const raiseInboxForBlockedTask = async (taskId: string): Promise<void> => {
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
  await raiseRetryBudgetExhaustedInbox({
    taskId,
    lastStep,
    retryCount: task.retryCount,
    lastErrorSignature: task.failureSignature,
    lastErrorSummary: lastErrorSummary || null,
    branch: task.branch,
    worktreePath: task.worktreePath,
  })
}

/**
 * When a task lands `done`, look up every task that has it listed as a
 * blocker in `task_blockers` and transition each from `blocked` -> `queued`
 * (or `dropped` if the retry budget is exhausted). A dependent only flips
 * if every one of its blockers resolves to a `done` task.
 *
 * Diagnose Chore intercept (PRD 06e677fb): when the completing task is a
 * diagnose Chore (kind='diagnose'), the generic unblock path is bypassed
 * entirely. Instead the verdict-driven branch fires via `runDiagnoseFollowup`,
 * which reads the structured verdict and either dispatches a fix (root-cause)
 * or escalates to the inbox (inconclusive / no-verdict). A diagnose Chore's
 * parent is NEVER re-queued blindly — the verdict owns that decision.
 */
export const onBlockerTaskCompleted = async (
  blockerTaskId: string,
): Promise<UnblockByTaskResult> => {
  // Diagnose Chore intercept — must run before the generic blocker loop so
  // the parent is never flipped to 'queued' through the ordinary path.
  const completingTask = await getTask(blockerTaskId)
  if (completingTask?.kind === 'diagnose') {
    // Dynamic import breaks the potential cycle with diagnose-followup.
    // Best-effort: a followup failure must not mask the Chore's done event.
    try {
      const { runDiagnoseFollowup } = await import('./lib/diagnose-followup')
      await runDiagnoseFollowup(blockerTaskId)
    } catch {
      /* best-effort: logged by caller */
    }
    return { blockerTaskId, outcomes: [] }
  }

  const c = await getDefaultQueueClient()
  const now = new Date().toISOString()

  const r = await c.execute({
    sql: `SELECT t.id AS id, t.retry_count AS retry_count
            FROM task_blockers b
            JOIN tasks t ON t.id = b.task_id
           WHERE b.blocker_task_id = ?
             AND t.status = 'blocked'`,
    args: [blockerTaskId],
  })

  const budget = getRetryBudget()
  const outcomes: UnblockOutcome[] = []
  const integrationBranch = integrationBranchName()

  for (const row of r.rows as unknown as BlockedDependentRow[]) {
    const retryCount = Number(row.retry_count ?? 0)
    if (retryBudgetExhausted(retryCount, budget)) {
      await raiseInboxForBlockedTask(row.id)
      await markTaskFailed(row.id, RETRY_BUDGET_FAILURE_REASON)
      outcomes.push({
        taskId: row.id,
        outcome: 'failed',
        retryCount,
        failureReason: RETRY_BUDGET_FAILURE_REASON,
      })
      continue
    }
    const incomplete = await c.execute({
      sql: `SELECT 1
              FROM task_blockers b
              JOIN tasks t ON t.id = b.blocker_task_id
             WHERE b.task_id = ? AND t.status != 'done'
               AND b.state IN ('confirmed', 'pending-review')
             LIMIT 1`,
      args: [row.id],
    })
    if (incomplete.rows.length > 0) {
      outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
      continue
    }
    // Reset the dependent's worktree to integration HEAD BEFORE flipping it
    // to 'queued' — if the reset is refused (commits ahead) the dependent must
    // never enter the dispatch queue.
    const dep = await getTask(row.id)
    try {
      await resetDependentWorktreeToIntegration(
        row.id,
        dep?.worktreePath ?? null,
        integrationBranch,
      )
    } catch (err: unknown) {
      if (err instanceof WorktreeAheadOfIntegrationError) {
        await raiseWorktreeAheadInbox(
          err.taskId,
          err.worktreePath,
          err.aheadCount,
          err.integrationBranch,
        )
        await markTaskFailed(row.id, WORKTREE_AHEAD_FAILURE_REASON)
        outcomes.push({
          taskId: row.id,
          outcome: 'failed',
          retryCount,
          failureReason: WORKTREE_AHEAD_FAILURE_REASON,
        })
        continue
      }
      throw err
    }
    const tx = await c.transaction('write')
    let flipped = false
    try {
      const upd = await tx.execute({
        sql: `UPDATE tasks
                 SET status = 'queued', updated_at = ?
               WHERE id = ? AND status = 'blocked'`,
        args: [now, row.id],
      })
      flipped = upd.rowsAffected > 0
      if (flipped) {
        await publish(tx, 'task.unblocked', {
          taskId: row.id,
          blockerTaskId,
        })
      }
      await tx.commit()
    } catch (error: unknown) {
      tx.close()
      throw error
    }
    if (flipped) {
      outcomes.push({ taskId: row.id, outcome: 'queued', retryCount })
      internalBus().emit('task.unblocked', {
        taskId: row.id,
        blockerTaskId,
      })
    } else {
      outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
    }
  }

  return { blockerTaskId, outcomes }
}

/**
 * When a task lands `failed` (any failure mode), look up every QUEUED
 * task that has a confirmed/pending-review task_blockers edge pointing
 * at the failed task and flip each from `queued` -> `blocked`. Raise a
 * single inbox item per affected downstream naming the failed
 * prerequisite so the operator can act.
 *
 * Tasks already in non-queued states (running, blocked, done, failed,
 * dropped, draft, ...) are untouched — the brief is "don't disturb
 * non-queued downstreams".
 *
 * Symmetric with {@link onBlockerTaskCompleted}: that path moves
 * `blocked` -> `queued` when a blocker reaches `done`; this path moves
 * `queued` -> `blocked` when a blocker reaches `failed`.
 *
 * Idempotent: a second invocation finds no `queued` dependents (they
 * are already `blocked`) and is a no-op. The inbox call dedupes on
 * `(originTaskId)` fingerprint, so re-raise bumps `seen_count`.
 */
export const onBlockerTaskFailed = async (
  failedBlockerTaskId: string,
): Promise<BlockByFailureResult> => {
  const c = await getDefaultQueueClient()
  const now = new Date().toISOString()

  const r = await c.execute({
    sql: `SELECT t.id AS id
            FROM task_blockers b
            JOIN tasks t ON t.id = b.task_id
           WHERE b.blocker_task_id = ?
             AND t.status = 'queued'
             AND b.state IN ('confirmed', 'pending-review')`,
    args: [failedBlockerTaskId],
  })

  const outcomes: BlockByFailureOutcome[] = []
  for (const row of r.rows as unknown as Array<{ id: string }>) {
    const tx = await c.transaction('write')
    let flipped = false
    try {
      const upd = await tx.execute({
        sql: `UPDATE tasks
                 SET status = 'blocked', updated_at = ?
               WHERE id = ? AND status = 'queued'`,
        args: [now, row.id],
      })
      flipped = upd.rowsAffected > 0
      await tx.commit()
    } catch (error: unknown) {
      tx.close()
      throw error
    }
    if (flipped) {
      try {
        await raiseInboxItem({
          kind: PREREQUISITE_FAILED_INBOX_KIND,
          category: 'orchestrator',
          priority: 'high',
          title: `Task ${row.id} blocked: prerequisite ${failedBlockerTaskId} failed`,
          body:
            `Task ${row.id} was queued waiting on prerequisite ${failedBlockerTaskId}.\n\n` +
            `The prerequisite failed, so this task has been moved from 'queued' to 'blocked' ` +
            `and will not dispatch into a broken tree.\n\n` +
            `Resolve the failed prerequisite (e.g. \`mars restart ${failedBlockerTaskId}\` or ` +
            `via the inbox item raised for it), or drop the blocker edge with ` +
            `\`mars unblock ${row.id} ${failedBlockerTaskId}\`.`,
          payload: {
            dependentTaskId: row.id,
            failedBlockerTaskId,
          },
          context: { repoRoot: process.env.MARS_REPO ?? null },
          raisedBy: 'agent:prerequisite-failed',
          signature: `${row.id}:${failedBlockerTaskId}`,
          originTaskId: row.id,
          occurrence: {
            at: new Date().toISOString(),
            failedBlockerTaskId,
          },
        })
      } catch {
        // best-effort: inbox failure must not block the cascade
      }
      outcomes.push({ taskId: row.id, outcome: 'blocked' })
    } else {
      outcomes.push({ taskId: row.id, outcome: 'noop' })
    }
  }

  return { failedBlockerTaskId, outcomes }
}

/**
 * PRD slice 2/4 (mars-9234e1b2): cancellation-cascade rule. When a
 * blocker reaches `failed` with `failure_reason = 'cancelled'`
 * (i.e. the user explicitly stopped it via the slice-1 stop-task RPC),
 * dependents waiting on it must NOT be recovered — they must fail too,
 * with their own `failure_reason = 'cancelled-blocker-cascade'`, and
 * an inbox item naming the cancelled blocker so the operator can see
 * why the dependent died.
 *
 * Symmetric with {@link onBlockerTaskCompleted}: that path fires when a
 * blocker reaches `done` and unblocks dependents; this path fires when
 * a blocker is cancelled and cascades the cancel down the dependency
 * chain instead.
 *
 * Blocker edges in `task_blockers` stay attached — they are
 * informational; the dependent row is dead and the edges merely record
 * the cause of death for forensics.
 */
export const onBlockerTaskCancelled = async (
  blockerTaskId: string,
): Promise<UnblockByTaskResult> => {
  const c = await getDefaultQueueClient()

  const r = await c.execute({
    sql: `SELECT t.id AS id, t.retry_count AS retry_count
            FROM task_blockers b
            JOIN tasks t ON t.id = b.task_id
           WHERE b.blocker_task_id = ?
             AND t.status = 'blocked'
             AND b.state IN ('confirmed', 'pending-review')`,
    args: [blockerTaskId],
  })

  const outcomes: UnblockOutcome[] = []
  for (const row of r.rows as unknown as BlockedDependentRow[]) {
    const retryCount = Number(row.retry_count ?? 0)
    await updateTask(row.id, {
      status: 'failed',
      error: `cancelled-blocker-cascade: blocker ${blockerTaskId} was cancelled by user`,
      failureReason: CANCELLED_CASCADE_FAILURE_REASON,
    })
    try {
      await raiseInboxItem({
        kind: CANCELLED_CASCADE_INBOX_KIND,
        category: 'orchestrator',
        priority: 'normal',
        title: `Dependent ${row.id} cancelled because blocker ${blockerTaskId} was cancelled`,
        body:
          `Task ${row.id} was waiting on blocker ${blockerTaskId}.\n\n` +
          `The blocker was cancelled by the user (stop-task RPC, failure_reason='cancelled'). ` +
          `Per the cancellation-cascade rule, this dependent has been marked failed ` +
          `with failure_reason='${CANCELLED_CASCADE_FAILURE_REASON}' instead of being unblocked.`,
        payload: {
          dependentTaskId: row.id,
          cancelledBlockerTaskId: blockerTaskId,
          failureReason: CANCELLED_CASCADE_FAILURE_REASON,
        },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'agent:blocker-cascade',
        signature: `${row.id}:${blockerTaskId}`,
        originTaskId: row.id,
        occurrence: {
          at: new Date().toISOString(),
          cancelledBlockerTaskId: blockerTaskId,
        },
      })
    } catch {
      // best-effort: inbox failure must not block the cascade
    }
    outcomes.push({
      taskId: row.id,
      outcome: 'failed',
      retryCount,
      failureReason: CANCELLED_CASCADE_FAILURE_REASON,
    })
  }

  return { blockerTaskId, outcomes }
}

/**
 * Daemon-startup recovery: any task left `blocked` whose every blocker is
 * already `done` should be unblocked. Catches the case where the daemon
 * died between a blocker task completing and the unblock running.
 */
export const recoverBlockedTasks = async (): Promise<UnblockByTaskResult[]> => {
  const c = await getDefaultQueueClient()
  const r = await c.execute(`
    SELECT t.id AS id, t.retry_count AS retry_count
      FROM tasks t
     WHERE t.status = 'blocked'
       AND EXISTS (SELECT 1 FROM task_blockers b WHERE b.task_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM task_blockers b
         JOIN tasks bt ON bt.id = b.blocker_task_id
         WHERE b.task_id = t.id AND bt.status != 'done'
           AND b.state IN ('confirmed', 'pending-review')
       )
  `)
  const results: UnblockByTaskResult[] = []
  const budget = getRetryBudget()
  const now = new Date().toISOString()
  const integrationBranch = integrationBranchName()
  for (const row of r.rows as unknown as BlockedDependentRow[]) {
    const retryCount = Number(row.retry_count ?? 0)
    const outcomes: UnblockOutcome[] = []
    if (retryBudgetExhausted(retryCount, budget)) {
      await raiseInboxForBlockedTask(row.id)
      await markTaskFailed(row.id, RETRY_BUDGET_FAILURE_REASON)
      outcomes.push({
        taskId: row.id,
        outcome: 'failed',
        retryCount,
        failureReason: RETRY_BUDGET_FAILURE_REASON,
      })
    } else {
      // Same reset-before-flip discipline as onBlockerTaskCompleted, so the
      // startup reconciler path stays in lock-step with the live path.
      const dep = await getTask(row.id)
      let refused = false
      try {
        await resetDependentWorktreeToIntegration(
          row.id,
          dep?.worktreePath ?? null,
          integrationBranch,
        )
      } catch (err: unknown) {
        if (err instanceof WorktreeAheadOfIntegrationError) {
          await raiseWorktreeAheadInbox(
            err.taskId,
            err.worktreePath,
            err.aheadCount,
            err.integrationBranch,
          )
          await markTaskFailed(row.id, WORKTREE_AHEAD_FAILURE_REASON)
          outcomes.push({
            taskId: row.id,
            outcome: 'failed',
            retryCount,
            failureReason: WORKTREE_AHEAD_FAILURE_REASON,
          })
          refused = true
        } else {
          throw err
        }
      }
      if (refused) {
        results.push({ blockerTaskId: '(recovered)', outcomes })
        continue
      }
      const tx = await c.transaction('write')
      let flipped = false
      try {
        const upd = await tx.execute({
          sql: `UPDATE tasks
                   SET status = 'queued', updated_at = ?
                 WHERE id = ? AND status = 'blocked'`,
          args: [now, row.id],
        })
        flipped = upd.rowsAffected > 0
        if (flipped) {
          await publish(tx, 'task.unblocked', {
            taskId: row.id,
            blockerTaskId: '(recovered)',
          })
        }
        await tx.commit()
      } catch (error: unknown) {
        tx.close()
        throw error
      }
      outcomes.push({
        taskId: row.id,
        outcome: flipped ? 'queued' : 'noop',
        retryCount,
      })
    }
    results.push({ blockerTaskId: '(recovered)', outcomes })
  }

  // Catch the crash-recovery scenario: a fix-task reached 'done' (its branch
  // merged into the integration branch) while the daemon was offline, but
  // markOriginDoneFromRecovery never fired because the daemon went down between
  // the fix-task's merge landing and the live completion handler running.
  //
  // Only 'done' fix-tasks qualify — a fix-task still in 'merging' (or any
  // earlier phase) has not yet landed and will be handled by the merge
  // reconciler that runs after this function during the startup sequence.
  //
  // Origins already in a terminal state ('done', 'failed', 'dropped') are
  // excluded by the JOIN filter; markOriginDoneFromRecovery is also idempotent
  // for terminal origins, so the guards compose safely.
  const fixDone = await c.execute(`
    SELECT DISTINCT f.fix_for_task_id AS origin_id
      FROM tasks f
      JOIN tasks o ON o.id = f.fix_for_task_id
     WHERE f.kind = 'fix'
       AND f.status = 'done'
       AND f.fix_for_task_id IS NOT NULL
       AND o.status NOT IN ('done', 'failed', 'dropped')
  `)
  for (const fixRow of fixDone.rows as unknown as Array<{ origin_id: string }>) {
    await markOriginDoneFromRecovery(fixRow.origin_id)
  }

  return results
}

export interface PropagateRecoveryDoneResult {
  originTaskId: string
  originFlipped: boolean
  unblock: UnblockByTaskResult | null
  inboxItemsClosed: number
}

/**
 * When a recovery task (kind='fix', non-null fixForTaskId) reaches
 * `done`, the work the operator was waiting on has shipped. Flip the
 * origin row to `done`, close inbox items keyed on the origin, and
 * propagate the unblock signal so dependents waiting on the origin
 * leave `blocked`.
 *
 * Idempotent: a no-op if the origin is already in a terminal state, or
 * if the recovery's fixForTaskId points at a missing/non-blocked row.
 *
 * CLAUDE.md contract: "a successful recovery counts as its origin
 * reaching done, so a recovered blocker unblocks the whole chain."
 */
export const markOriginDoneFromRecovery = async (
  originTaskId: string,
): Promise<PropagateRecoveryDoneResult> => {
  const origin = await getTask(originTaskId)

  // Close any inbox row keyed to the origin regardless of whether we
  // flip its status. The origin may be missing (purged, or the
  // recovery's fixForTaskId was a PRD slug rather than a task row),
  // or already terminal (the retry-budget guard parked it in
  // `failed` before the recovery finished). In either case the
  // operator no longer needs to see a stale "recovery-failed" row:
  // the recovery just succeeded, the underlying work shipped.
  let inboxItemsClosed = 0
  try {
    const closed = await supersedeInboxItemsForOrigin(originTaskId, 'origin-done')
    inboxItemsClosed = closed.length
  } catch {
    // best-effort: inbox closing must not block dependent unblock
  }

  if (!origin) {
    return {
      originTaskId,
      originFlipped: false,
      unblock: null,
      inboxItemsClosed,
    }
  }
  if (origin.status === 'done' || origin.status === 'failed' || origin.status === 'dropped') {
    return {
      originTaskId,
      originFlipped: false,
      unblock: null,
      inboxItemsClosed,
    }
  }
  const c = await getDefaultQueueClient()
  const now = new Date().toISOString()
  const tx = await c.transaction('write')
  let originFlipped = false
  try {
    const upd = await tx.execute({
      sql: `UPDATE tasks
               SET status = 'done', error = NULL, updated_at = ?
             WHERE id = ? AND status NOT IN ('done', 'failed', 'dropped')`,
      args: [now, originTaskId],
    })
    originFlipped = upd.rowsAffected > 0
    if (originFlipped) {
      await publish(tx, 'task.completed', {
        taskId: originTaskId,
        result: { via: 'recovery' },
      })
    }
    await tx.commit()
  } catch (error: unknown) {
    tx.close()
    throw error
  }
  if (!originFlipped) {
    return {
      originTaskId,
      originFlipped: false,
      unblock: null,
      inboxItemsClosed,
    }
  }
  const unblock = await onBlockerTaskCompleted(originTaskId)
  return {
    originTaskId,
    originFlipped: true,
    unblock,
    inboxItemsClosed,
  }
}
