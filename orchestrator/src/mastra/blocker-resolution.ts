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
