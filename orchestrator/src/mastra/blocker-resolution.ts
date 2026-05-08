import { getRetryBudget, markTaskDropped } from './queue-fix-suggestions'
import { getClient, initQueue } from './queue'

export interface UnblockOutcome {
  taskId: string
  outcome: 'queued' | 'dropped' | 'noop'
  retryCount: number
  dropReason?: string
}

export interface ResolveBlockerResult {
  suggestionId: string
  acceptedNow: boolean
  outcomes: UnblockOutcome[]
}

interface BlockedRow {
  id: string
  status: string
  retry_count: number | null
}

interface SuggestionRow {
  id: string
  status: string
}

const RETRY_BUDGET_DROP_REASON = 'retry_budget_exhausted_at_unblock'

const fetchSuggestion = async (
  suggestionId: string,
): Promise<SuggestionRow | null> => {
  const r = await getClient().execute({
    sql: `SELECT id, status FROM task_suggestions WHERE id = ?`,
    args: [suggestionId],
  })
  if (r.rows.length === 0) return null
  return r.rows[0] as unknown as SuggestionRow
}

/**
 * Flip the suggestion to 'accepted' (if not already) and re-queue every task
 * blocked on it, respecting the retry budget. Idempotent: re-running on an
 * already-accepted suggestion produces no-ops for tasks past 'blocked'.
 */
export const resolveBlockerForSuggestion = async (
  suggestionId: string,
): Promise<ResolveBlockerResult> => {
  await initQueue()
  const c = getClient()
  const now = new Date().toISOString()

  const suggestion = await fetchSuggestion(suggestionId)
  if (!suggestion) {
    return { suggestionId, acceptedNow: false, outcomes: [] }
  }

  const acceptedNow = suggestion.status !== 'accepted'
  if (acceptedNow) {
    await c.execute({
      sql: `UPDATE task_suggestions SET status = 'accepted' WHERE id = ?`,
      args: [suggestionId],
    })
  }

  const blocked = await c.execute({
    sql: `SELECT id, status, retry_count FROM tasks
           WHERE blocker_id = ? AND status = 'blocked'`,
    args: [suggestionId],
  })

  const budget = getRetryBudget()
  const outcomes: UnblockOutcome[] = []

  for (const row of blocked.rows as unknown as BlockedRow[]) {
    const retryCount = Number(row.retry_count ?? 0)
    if (retryCount >= budget) {
      await markTaskDropped(row.id, RETRY_BUDGET_DROP_REASON)
      outcomes.push({
        taskId: row.id,
        outcome: 'dropped',
        retryCount,
        dropReason: RETRY_BUDGET_DROP_REASON,
      })
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
    } else {
      outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
    }
  }

  return { suggestionId, acceptedNow, outcomes }
}

interface SuggestionForChild {
  id: string
  status: string
}

/**
 * If the given task is the `created_task_id` of a fix suggestion, treat its
 * completion as the trigger to flip that suggestion to 'accepted' and unblock
 * dependents.
 */
export const onChildTaskCompleted = async (
  childTaskId: string,
): Promise<ResolveBlockerResult | null> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT id, status FROM task_suggestions
           WHERE created_task_id = ? AND kind = 'fix'
           LIMIT 1`,
    args: [childTaskId],
  })
  if (r.rows.length === 0) return null
  const sug = r.rows[0] as unknown as SuggestionForChild
  return resolveBlockerForSuggestion(sug.id)
}

interface BlockedDependentRow {
  id: string
  retry_count: number | null
}

export interface UnblockByTaskResult {
  blockerTaskId: string
  outcomes: UnblockOutcome[]
}

/**
 * When a task lands `done`, look up every task that has it listed as a
 * blocker in `task_blockers` and transition each from `blocked` -> `queued`
 * (or `dropped` if the retry budget is exhausted). This is the new
 * fix-task-direct path; it complements the legacy suggestion-based path
 * (`onChildTaskCompleted`) which is still used for kind='reflection' and
 * for any pre-existing kind='fix' suggestions.
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
    if (retryCount >= budget) {
      await markTaskDropped(row.id, RETRY_BUDGET_DROP_REASON)
      outcomes.push({
        taskId: row.id,
        outcome: 'dropped',
        retryCount,
        dropReason: RETRY_BUDGET_DROP_REASON,
      })
      continue
    }
    // Only flip to queued if all of this task's blockers are done.
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
    } else {
      outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
    }
  }

  return { blockerTaskId, outcomes }
}

/**
 * Daemon-startup recovery for task_blockers-based dependencies: any task
 * left `blocked` whose every blocker is already `done` should be unblocked.
 */
export const recoverBlockedTasksByBlockerTable = async (): Promise<
  UnblockByTaskResult[]
> => {
  await initQueue()
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT t.id AS id, t.retry_count AS retry_count
            FROM tasks t
           WHERE t.status = 'blocked'
             AND EXISTS (SELECT 1 FROM task_blockers b WHERE b.task_id = t.id)
             AND NOT EXISTS (
               SELECT 1 FROM task_blockers b
               JOIN tasks bt ON bt.id = b.blocker_task_id
               WHERE b.task_id = t.id AND bt.status != 'done'
             )`,
  })
  const results: UnblockByTaskResult[] = []
  const budget = getRetryBudget()
  const now = new Date().toISOString()
  for (const row of r.rows as unknown as BlockedDependentRow[]) {
    const retryCount = Number(row.retry_count ?? 0)
    const outcomes: UnblockOutcome[] = []
    if (retryCount >= budget) {
      await markTaskDropped(row.id, RETRY_BUDGET_DROP_REASON)
      outcomes.push({
        taskId: row.id,
        outcome: 'dropped',
        retryCount,
        dropReason: RETRY_BUDGET_DROP_REASON,
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

/**
 * On daemon startup, detect any tasks that were left in 'blocked' state with
 * a blocker that has already resolved (e.g., the daemon died between the
 * child task completing and the unblock running) and resolve them.
 */
export const recoverBlockedTasks = async (): Promise<ResolveBlockerResult[]> => {
  await initQueue()
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT DISTINCT t.blocker_id AS suggestion_id
            FROM tasks t
            JOIN task_suggestions s ON s.id = t.blocker_id
       LEFT JOIN tasks ct ON ct.id = s.created_task_id
           WHERE t.status = 'blocked'
             AND t.blocker_id IS NOT NULL
             AND (
               s.status = 'accepted'
               OR (s.created_task_id IS NOT NULL AND ct.status = 'done')
             )`,
  })
  const results: ResolveBlockerResult[] = []
  for (const row of r.rows) {
    const suggestionId = (row as unknown as { suggestion_id: string }).suggestion_id
    if (!suggestionId) continue
    const result = await resolveBlockerForSuggestion(suggestionId)
    results.push(result)
  }
  return results
}
