import { resolveStateClient } from '../store/state-client'

/**
 * Resolve the arc origin id for a task: its `origin_id`, or its own id when it
 * is itself the origin (or is not found).
 *
 * Reads through the state client rather than the task store. This is a
 * single-column read against a table that lives in the same Mars database
 * (ADR-0034 consolidation), and going through `store/task-store.ts` gave this
 * module — and therefore `lib/action-queue.ts`, its only consumer — an edge up
 * into `core/` that closed several import cycles in the architecture baseline.
 */
export const resolveOriginIdForTask = async (
  taskId: string,
): Promise<string> => {
  const r = await resolveStateClient().execute({
    sql: `SELECT origin_id, id FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return taskId
  const row = r.rows[0] as unknown as { origin_id: string | null; id: string }
  return row.origin_id ?? row.id
}
