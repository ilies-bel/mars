import { getClient, initQueue } from './queue'

export const DEFAULT_RETRY_BUDGET = 1

export const getRetryBudget = (): number => {
  const raw = process.env.MARS_FIX_RETRY_BUDGET
  if (!raw) return DEFAULT_RETRY_BUDGET
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETRY_BUDGET
  return Math.floor(n)
}

export const markTaskDropped = async (
  taskId: string,
  reason: string,
): Promise<void> => {
  await initQueue()
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `UPDATE tasks SET status = 'dropped', drop_reason = ?, updated_at = ? WHERE id = ?`,
    args: [reason, now, taskId],
  })
  await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
}
