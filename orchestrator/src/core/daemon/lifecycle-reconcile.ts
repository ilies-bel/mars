import type { Client } from '@libsql/client'
import {
  initActionQueue,
  resolveAllRowsForTask,
  supersedeActionQueueItemsForOrigin,
} from '../lib/action-queue'
import type { SupersedeReason } from '../lib/action-queue'

/**
 * Kinds whose `origin_task_id` points to a row in `proposals`, not `tasks`.
 * Extend this list when a new proposal-origin kind is added; the orphan checks
 * below automatically route to the correct origin table.
 */
const PROPOSAL_ORIGIN_KINDS = ['draft-proposal'] as const

/**
 * Boot-time reconciliation: closes Action-queue rows left open while the
 * daemon was down.
 *
 * (a) For each task in ('done', 'dropped') that still has an open
 *     action_queue_items row: runs the same resolve path as the Invalidator
 *     (ADR-0027/0028). Closes the gap when the daemon crashed between the
 *     terminal-status write and the Invalidator draining its cursor.
 *
 * (b) Kind-aware orphan sweep. Two scoped queries — one per origin-table:
 *
 *   b-task: Open rows for task-origin kinds (every kind except
 *     PROPOSAL_ORIGIN_KINDS) whose origin_task_id is absent from `tasks`
 *     entirely. Covers purged tasks that pre-date the lifecycle-event plumbing.
 *
 *   b-proposal: Open rows for proposal-origin kinds (currently 'draft-proposal')
 *     whose origin_task_id is absent from `proposals`. Correctly sweeps rows
 *     for proposals that were deleted while the daemon was down, while leaving
 *     rows for still-live draft proposals untouched.
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

  const proposalKindList = PROPOSAL_ORIGIN_KINDS.map(k => `'${k}'`).join(', ')

  // (b-task) Open rows for task-origin kinds whose origin_task_id is absent
  //          from tasks entirely — purged tasks without a lifecycle event.
  const taskOriginOrphans = await client.execute(`
    SELECT DISTINCT origin_task_id
    FROM action_queue_items
    WHERE state = 'open'
      AND kind NOT IN (${proposalKindList})
      AND origin_task_id IS NOT NULL
      AND origin_task_id NOT IN (SELECT id FROM tasks)
  `)

  for (const row of taskOriginOrphans.rows) {
    const taskId = (row as unknown as { origin_task_id: string }).origin_task_id
    await resolveAllRowsForTask(taskId)
    rowsResolved++
  }

  // (b-proposal) Open rows for proposal-origin kinds whose origin_task_id is
  //              absent from proposals — proposals deleted while the daemon was
  //              down. A still-live proposal's row is left open.
  const proposalOriginOrphans = await client.execute(`
    SELECT DISTINCT origin_task_id
    FROM action_queue_items
    WHERE state = 'open'
      AND kind IN (${proposalKindList})
      AND origin_task_id IS NOT NULL
      AND origin_task_id NOT IN (SELECT id FROM proposals)
  `)

  for (const row of proposalOriginOrphans.rows) {
    const originId = (row as unknown as { origin_task_id: string }).origin_task_id
    await resolveAllRowsForTask(originId)
    rowsResolved++
  }

  // (c) Stranded 'failed' rows for sliced tasks whose arc-root (origin_task_id)
  //     is a PRD task that is still live — so leg (a)'s JOIN misses them — but
  //     whose actual failing task (stored in payload.taskId) is now terminal.
  //
  //     Typical scenario:
  //       • PRD task is still 'queued' (other slices pending)           → not in leg (a)
  //       • PRD task IS in the tasks table                              → not in leg (b-task)
  //       • but payload.taskId task is 'done' / 'dropped'              → caught here
  //
  //     supersedeActionQueueItemsForOrigin arc-resolves the payload task id so
  //     it computes the same fingerprint that raiseActionQueueItem stored.
  //     Rows already closed by legs (a) / (b) are excluded by the `state='open'`
  //     filter; the call is idempotent if a row was already closed.
  const strandedByPayload = await client.execute(`
    SELECT DISTINCT json_extract(i.payload, '$.taskId') AS task_id, t.status
    FROM action_queue_items i
    JOIN tasks t ON t.id = json_extract(i.payload, '$.taskId')
    WHERE i.state = 'open'
      AND i.kind = 'failed'
      AND t.status IN ('done', 'dropped')
  `)

  for (const row of strandedByPayload.rows) {
    const taskId = (row as unknown as { task_id: string; status: string }).task_id
    const status = (row as unknown as { task_id: string; status: string }).status
    const reason: SupersedeReason = status === 'done' ? 'origin-done' : 'origin-dropped'
    const closed = await supersedeActionQueueItemsForOrigin(taskId, reason, 'reconcile:payload-taskid')
    rowsResolved += closed.length
  }

  return { rowsResolved }
}
