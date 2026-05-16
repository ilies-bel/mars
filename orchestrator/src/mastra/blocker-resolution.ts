import { internalBus } from '../internal-bus'
import {
  getRetryBudget,
  markTaskFailed,
  raiseRetryBudgetExhaustedInbox,
} from './queue-retry'
import { getClient, getTask, initQueue } from './queue'

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
  const colon = error.indexOf(':')
  const lastStep = colon > 0 ? error.slice(0, colon).trim() : 'unblock'
  const lastErrorSummary = colon > 0 ? error.slice(colon + 1).trim() : error
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
 */
export const onBlockerTaskCompleted = async (
  blockerTaskId: string,
): Promise<UnblockByTaskResult> => {
  await initQueue()
  const c = getClient()
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
             LIMIT 1`,
      args: [row.id],
    })
    if (incomplete.rows.length > 0) {
      outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
      continue
    }
    const upd = await c.execute({
      sql: `UPDATE tasks
               SET status = 'queued', updated_at = ?
             WHERE id = ? AND status = 'blocked'`,
      args: [now, row.id],
    })
    if (upd.rowsAffected > 0) {
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
 * Daemon-startup recovery: any task left `blocked` whose every blocker is
 * already `done` should be unblocked. Catches the case where the daemon
 * died between a blocker task completing and the unblock running.
 */
export const recoverBlockedTasks = async (): Promise<UnblockByTaskResult[]> => {
  await initQueue()
  const c = getClient()
  const r = await c.execute(`
    SELECT t.id AS id, t.retry_count AS retry_count
      FROM tasks t
     WHERE t.status = 'blocked'
       AND EXISTS (SELECT 1 FROM task_blockers b WHERE b.task_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM task_blockers b
         JOIN tasks bt ON bt.id = b.blocker_task_id
         WHERE b.task_id = t.id AND bt.status != 'done'
       )
  `)
  const results: UnblockByTaskResult[] = []
  const budget = getRetryBudget()
  const now = new Date().toISOString()
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
      const upd = await c.execute({
        sql: `UPDATE tasks
                 SET status = 'queued', updated_at = ?
               WHERE id = ? AND status = 'blocked'`,
        args: [now, row.id],
      })
      outcomes.push({
        taskId: row.id,
        outcome: upd.rowsAffected > 0 ? 'queued' : 'noop',
        retryCount,
      })
    }
    results.push({ blockerTaskId: '(recovered)', outcomes })
  }
  return results
}
