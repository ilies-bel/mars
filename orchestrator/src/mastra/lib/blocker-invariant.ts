import type { Client } from '@libsql/client'
import { getDefaultQueueClient } from './task-store'

/**
 * Invariant helper: a task should only be `status='blocked'` when there is at
 * least one row in `task_blockers` whose `task_id` is the parked task. If a
 * code path needs to park a task but cannot point at a concrete blocker to
 * wait on, the correct terminal is `'failed'` + an inbox item, NOT `'blocked'`
 * with zero edges.
 *
 * This module exposes the count/has primitives and an `assert` variant that
 * throws when the invariant would be violated. Call sites that transition a
 * task to `'blocked'` should call `assertHasBlockerEdge` inside the SAME
 * transaction that inserts the edge — that way a missing edge surfaces
 * immediately instead of silently parking a task with no recovery path.
 *
 * See ADR-0002 + the orchestrator audit (task mars-88a4e657) for the call-site
 * inventory. Both previously identified violations have been resolved:
 *
 *  - `implement-workflow.ts` dirty-main preflight routes through
 *    `handleTaskFailureWithFixTask`, which inserts a real `task_blockers` edge.
 *  - `queue-fix-tasks.ts` no-recipe investigator path now sets `status='failed'`
 *    instead of `status='blocked'`, eliminating the edgeless-blocked state.
 *
 * The `AUDIT (mars-88a4e657): safe site` annotation in `queue-fix-tasks.ts`
 * near the fix-fail-loop cap remains valid — that path re-stamps 'blocked' after
 * at least one prior `upsertFixTask` call inserted an edge.
 */

export interface BlockerInvariantOptions {
  /**
   * Optional client/transaction handle to count against. When provided, the
   * caller is responsible for ensuring the count happens in the same
   * transaction as the status write — that closes the obvious race where
   * the edge is inserted, the count runs, then the edge is rolled back.
   *
   * When omitted, the count runs against the default queue client.
   */
  client?: Pick<Client, 'execute'>
}

/**
 * Count `task_blockers` rows whose `task_id` matches `taskId`. Returns 0 when
 * the task has no edges (the violation case).
 */
export const countBlockerEdges = async (
  taskId: string,
  opts: BlockerInvariantOptions = {},
): Promise<number> => {
  const c = opts.client ?? (await getDefaultQueueClient())
  const r = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return 0
  const n = (r.rows[0] as unknown as { n: number | bigint }).n
  return typeof n === 'bigint' ? Number(n) : n
}

/**
 * Convenience predicate over {@link countBlockerEdges}.
 */
export const hasBlockerEdge = async (
  taskId: string,
  opts: BlockerInvariantOptions = {},
): Promise<boolean> => {
  return (await countBlockerEdges(taskId, opts)) > 0
}

/**
 * Throw {@link BlockerInvariantViolation} when `taskId` has zero edges.
 *
 * Call this immediately before a `UPDATE tasks SET status = 'blocked'` write,
 * inside the same transaction that inserted the edge. A throw rolls the
 * transaction back so the task does not silently enter the bad state.
 */
export const assertHasBlockerEdge = async (
  taskId: string,
  opts: BlockerInvariantOptions = {},
): Promise<void> => {
  const n = await countBlockerEdges(taskId, opts)
  if (n === 0) {
    throw new BlockerInvariantViolation(taskId)
  }
}

export class BlockerInvariantViolation extends Error {
  readonly taskId: string

  constructor(taskId: string) {
    super(
      `task ${taskId} cannot transition to status='blocked': zero rows in task_blockers — ` +
        `a blocked task must point at a concrete blocker to wait on. Route to 'failed' + inbox item instead.`,
    )
    this.name = 'BlockerInvariantViolation'
    this.taskId = taskId
  }
}
