import { getClient, initQueue } from '../queue'

export const resolveOriginIdForTask = async (
  taskId: string,
): Promise<string> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT origin_id, id FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return taskId
  const row = r.rows[0] as unknown as { origin_id: string | null; id: string }
  return row.origin_id ?? row.id
}
