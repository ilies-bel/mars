import { resolveQueueClient } from '../queue.js'
import { raiseActionQueueItem } from './action-queue.js'
import type { BudgetPressure } from './budget-pressure.js'
import type { DbClient } from './db.js'

export interface DeferralRow {
  taskId: string
  deferredAt: string
  reason: string
  targetWindowEnd: string | null
  pressure: BudgetPressure
}

export type UpsertDeferralInput = Omit<DeferralRow, 'deferredAt'> & {
  deferredAt?: string
}

/** Persist the current deferral decision for a task, replacing any older one. */
export const upsertDeferral = async (
  row: UpsertDeferralInput,
  client: DbClient = resolveQueueClient(),
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO deferrals
            (task_id, deferred_at, reason, target_window_end, pressure)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (task_id) DO UPDATE SET
            deferred_at = EXCLUDED.deferred_at,
            reason = EXCLUDED.reason,
            target_window_end = EXCLUDED.target_window_end,
            pressure = EXCLUDED.pressure`,
    args: [
      row.taskId,
      row.deferredAt ?? new Date().toISOString(),
      row.reason,
      row.targetWindowEnd,
      row.pressure,
    ],
  })
  await raiseActionQueueItem({
    kind: 'scheduling-decision',
    category: 'daemon',
    priority: 'normal',
    title: `Deferred task ${row.taskId}`,
    body: row.reason,
    payload: {
      taskId: row.taskId,
      decision: 'deferred',
      reason: row.reason,
      pressure: row.pressure,
      targetWindowEnd: row.targetWindowEnd,
      canRunNow: false,
    },
    context: {},
    raisedBy: 'usage-scheduler:deferral',
    signature: `${row.taskId}:deferred:${row.targetWindowEnd ?? 'null'}`,
  })
}

/** Remove a task's recorded deferral once a later scheduler slice releases it. */
export const deleteDeferral = async (
  taskId: string,
  client: DbClient = resolveQueueClient(),
): Promise<void> => {
  await client.execute({
    sql: 'DELETE FROM deferrals WHERE task_id = ?',
    args: [taskId],
  })
}

/** Return current deferrals in the order their latest decision was made. */
export const listDeferrals = async (
  client: DbClient = resolveQueueClient(),
): Promise<DeferralRow[]> => {
  const result = await client.execute(
    `SELECT task_id, deferred_at, reason, target_window_end, pressure
       FROM deferrals
      ORDER BY deferred_at ASC`,
  )
  return result.rows.map((row) => ({
    taskId: String(row.task_id),
    deferredAt: String(row.deferred_at),
    reason: String(row.reason),
    targetWindowEnd:
      row.target_window_end === null ? null : String(row.target_window_end),
    pressure: row.pressure as BudgetPressure,
  }))
}
