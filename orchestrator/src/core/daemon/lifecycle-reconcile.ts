import type { Client } from '@libsql/client'
import {
  initActionQueue,
  resolveAllRowsForTask,
  setActionQueueState,
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
 * Kinds whose `origin_task_id` points to a row in `scorers`, not `tasks`.
 * Same routing role as PROPOSAL_ORIGIN_KINDS for the scorer projection.
 */
const SCORER_ORIGIN_KINDS = ['scorer-suggested'] as const

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
  const scorerKindList = SCORER_ORIGIN_KINDS.map(k => `'${k}'`).join(', ')

  // (b-task) Open rows for task-origin kinds whose origin_task_id is absent
  //          from tasks entirely — purged tasks without a lifecycle event.
  const taskOriginOrphans = await client.execute(`
    SELECT DISTINCT origin_task_id
    FROM action_queue_items
    WHERE state = 'open'
      AND kind NOT IN (${proposalKindList}, ${scorerKindList})
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

  // (b-scorer) Open rows for scorer-origin kinds whose scorers row no longer
  //            sits in status='suggested' (or is gone entirely). The durable
  //            outbox normally evicts these via scorer.accepted/dismissed;
  //            this sweep is the belt-and-suspenders for rows stranded by
  //            manual DB surgery or a lost event. initScorers() guarantees
  //            the table exists before the subquery runs.
  const { initScorers } = await import('../scorers')
  await initScorers()
  const scorerOriginOrphans = await client.execute(`
    SELECT DISTINCT origin_task_id
    FROM action_queue_items
    WHERE state = 'open'
      AND kind IN (${scorerKindList})
      AND origin_task_id IS NOT NULL
      AND origin_task_id NOT IN (SELECT id FROM scorers WHERE status = 'suggested')
  `)

  for (const row of scorerOriginOrphans.rows) {
    const originId = (row as unknown as { origin_task_id: string }).origin_task_id
    await resolveAllRowsForTask(originId)
    rowsResolved++
  }

  // (b-null) Open rows for task-origin kinds whose origin_task_id is NULL but
  //          whose payload.originTaskId references a task absent from `tasks`
  //          entirely. Covers items raised before the origin_task_id column was
  //          added, or items from code paths that didn't populate it. These
  //          are orphans whose underlying task was purged.
  const nullOriginOrphans = await client.execute(`
    SELECT i.id
    FROM action_queue_items i
    WHERE i.state = 'open'
      AND i.kind NOT IN (${proposalKindList}, ${scorerKindList})
      AND i.origin_task_id IS NULL
      AND json_extract(i.payload, '$.originTaskId') IS NOT NULL
      AND json_extract(i.payload, '$.originTaskId') NOT IN (SELECT id FROM tasks)
  `)

  for (const row of nullOriginOrphans.rows) {
    const itemId = (row as unknown as { id: string }).id
    await setActionQueueState(itemId, 'resolved', {
      resolution: 'superseded',
      note: 'superseded: orphaned (origin_task_id NULL, payload.originTaskId absent from tasks)',
      by: 'reconcile:null-origin-orphan',
    })
    rowsResolved++
  }

  // (b-null-done) NULL origin_task_id, payload.originalTaskId points at a
  //              DONE/DROPPED task. Covers stale-worktree rows raised by a
  //              recovery run (payload key is 'originalTaskId', not
  //              'originTaskId') whose origin task reached a terminal status
  //              through another path while the action-queue row was never
  //              closed. These are NOT purged orphans — the task is still
  //              present in `tasks` — so leg (b-null) misses them.
  const nullOriginTerminal = await client.execute(`
    SELECT i.id
    FROM action_queue_items i
    JOIN tasks t ON t.id = json_extract(i.payload, '$.originalTaskId')
    WHERE i.state = 'open'
      AND i.kind NOT IN (${proposalKindList}, ${scorerKindList})
      AND i.origin_task_id IS NULL
      AND t.status IN ('done', 'dropped')
  `)

  for (const row of nullOriginTerminal.rows) {
    const itemId = (row as unknown as { id: string }).id
    await setActionQueueState(itemId, 'resolved', {
      resolution: 'superseded',
      note: 'superseded: origin task terminal (payload.originalTaskId done/dropped)',
      by: 'reconcile:null-origin-terminal',
    })
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
