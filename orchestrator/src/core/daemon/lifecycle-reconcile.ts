import type { Client } from '@libsql/client'
import { initActionQueue, resolveAllRowsForTask } from '../lib/action-queue'

/**
 * Boot-time reconciliation: closes Action-queue rows left open while the
 * daemon was down.
 *
 * (a) For each task in ('done', 'dropped') that still has an open
 *     action_queue_items row: runs the same resolve path as the Invalidator
 *     (ADR-0027/0028). Closes the gap when the daemon crashed between the
 *     terminal-status write and the Invalidator draining its cursor.
 *
 * (b) For each open action_queue_items row whose origin_task_id is not present
 *     in tasks at all (task was purged without an event): resolves the row.
 *     Covers historical residue from purges that pre-date the lifecycle-event
 *     plumbing.
 *
 * Idempotent — safe to call on every daemon start. Returns counts for logging.
 */
export async function reconcileTerminalTasks(
  client: Client,
): Promise<{ rowsResolved: number }> {
  // Ensure the table exists before querying it (idempotent).
  await initActionQueue()

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
    rowsResolved++
  }

  // (b) Open action-queue rows whose origin_task_id is absent from tasks
  //     entirely — covers purged tasks that never emitted a lifecycle event.
  //     Excludes 'draft-proposal' rows: their origin_task_id is a proposal id
  //     (lives in the proposals table, not tasks). Those rows are evicted by
  //     the per-event path in action-queue-repopulator (proposal.promoted /
  //     dismissed / deleted). Including them here would incorrectly sweep live
  //     draft proposals on every daemon restart.
  const purgedTaskRows = await client.execute(`
    SELECT DISTINCT origin_task_id
    FROM action_queue_items
    WHERE state = 'open'
      AND kind != 'draft-proposal'
      AND origin_task_id IS NOT NULL
      AND origin_task_id NOT IN (SELECT id FROM tasks)
  `)

  for (const row of purgedTaskRows.rows) {
    const taskId = (row as unknown as { origin_task_id: string }).origin_task_id
    await resolveAllRowsForTask(taskId)
    rowsResolved++
  }

  return { rowsResolved }
}
