import type { DbClient } from '../lib/db.js'
import { resolveStateClient } from '../store/state-client.js'

export interface ChatThreadTask {
  threadId: string
  taskId: string
  createdAt: string
}

/** Record the task created by a chat thread. Repeated tool-output replay is idempotent. */
export const linkTaskToThread = async (
  threadId: string,
  taskId: string,
  client: Pick<DbClient, 'execute'> = resolveStateClient(),
): Promise<void> => {
  await client.execute({
    sql: `INSERT INTO chat_thread_tasks (thread_id, task_id, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT (thread_id, task_id) DO NOTHING`,
    args: [threadId, taskId, new Date().toISOString()],
  })
}

/** List a thread's created tasks in the order their links were persisted. */
export const listTasksForThread = async (
  threadId: string,
  client: Pick<DbClient, 'execute'> = resolveStateClient(),
): Promise<ChatThreadTask[]> => {
  const result = await client.execute({
    sql: `SELECT thread_id, task_id, created_at
          FROM chat_thread_tasks
          WHERE thread_id = ?
          ORDER BY created_at ASC, task_id ASC`,
    args: [threadId],
  })
  return result.rows.map((row) => ({
    threadId: String(row.thread_id),
    taskId: String(row.task_id),
    createdAt: String(row.created_at),
  }))
}
