import type { Client } from '@libsql/client'
import { initActionQueue, resolveAllRowsForTask } from '../lib/action-queue'
import {
  clearDismissalForEntity,
  initActionQueueDismissals,
} from '../lib/action-queue-dismissals'

/**
 * Boot-time reconciliation: closes Action-queue rows and dismissals left open
 * while the daemon was down.
 *
 * (a) For each task in ('done', 'dropped') that still has an open
 *     action_queue_items row: runs the same resolve+clear path as the
 *     Invalidator (ADR-0027/0028). Closes the gap when the daemon crashed
 *     between the terminal-status write and the Invalidator draining its
 *     cursor.
 *
 * (b) For each row in action_queue_dismissals keyed to a task entity_id that
 *     no longer exists in the tasks table: drops the orphaned dismissal. This
 *     handles tasks that were purged while the daemon was down.
 *
 * (c) For each open action_queue_items row whose origin_task_id is not present
 *     in tasks at all (task was purged without an event): resolves the row.
 *     Covers historical residue from purges that pre-date the lifecycle-event
 *     plumbing.
 *
 * Idempotent — safe to call on every daemon start. Returns counts for logging.
 */
export async function reconcileTerminalTasks(
  client: Client,
): Promise<{ rowsResolved: number; dismissalsCleared: number }> {
  // Ensure both tables exist before querying them (each init is idempotent).
  await initActionQueue()
  await initActionQueueDismissals()

  // (a) Terminal tasks with at least one open action-queue row.
  const terminalRows = await client.execute(`
    SELECT DISTINCT t.id
    FROM tasks t
    JOIN action_queue_items i ON i.origin_task_id = t.id
    WHERE t.status IN ('done', 'dropped')
      AND i.state = 'open'
  `)

  let rowsResolved = 0
  for (const row of terminalRows.rows) {
    const taskId = (row as unknown as { id: string }).id
    await resolveAllRowsForTask(taskId)
    await clearDismissalForEntity('task', taskId)
    rowsResolved++
  }

  // (b) Dismissals for tasks that no longer exist in the tasks table.
  const orphanDismissalRows = await client.execute(`
    SELECT entity_id
    FROM action_queue_dismissals
    WHERE entity_kind = 'task'
      AND entity_id NOT IN (SELECT id FROM tasks)
  `)

  let dismissalsCleared = 0
  for (const row of orphanDismissalRows.rows) {
    const entityId = (row as unknown as { entity_id: string }).entity_id
    await clearDismissalForEntity('task', entityId)
    dismissalsCleared++
  }

  // (c) Open action-queue rows whose origin_task_id is absent from tasks
  //     entirely — covers purged tasks that never emitted a lifecycle event.
  const purgedTaskRows = await client.execute(`
    SELECT DISTINCT origin_task_id
    FROM action_queue_items
    WHERE state = 'open'
      AND origin_task_id IS NOT NULL
      AND origin_task_id NOT IN (SELECT id FROM tasks)
  `)

  for (const row of purgedTaskRows.rows) {
    const taskId = (row as unknown as { origin_task_id: string }).origin_task_id
    await resolveAllRowsForTask(taskId)
    rowsResolved++
  }

  return { rowsResolved, dismissalsCleared }
}
