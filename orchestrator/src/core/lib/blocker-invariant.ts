import type { DbStatement, DbResultSet } from './db.js'
import { getDefaultTaskStore } from '../store/task-store'

/**
 * Minimal statement-runner the invariant checks depend on. Satisfied by the
 * TaskStore (`store.query`/`store.execute`), the {@link Scope} passed inside an
 * `atomic` callback, and a raw DB client/transaction executor — so callers can
 * run the probe in the same transaction that inserts the edge without the raw
 * handle crossing the seam.
 */
export interface StatementRunner {
  execute(stmt: DbStatement): Promise<DbResultSet>
}

/**
 * Two invariants share this module because they both gate `task_blockers`:
 *
 *  1. The edgeless-blocked guard (`assertHasBlockerEdge` / `countBlockerEdges`):
 *     a task should only be `status='blocked'` when there is at least one row
 *     in `task_blockers` whose `task_id` is the parked task. If a code path
 *     needs to park a task but cannot point at a concrete blocker to wait on,
 *     the correct terminal is `'failed'` + an actionQueue item, NOT `'blocked'` with
 *     zero edges. See ADR-0002 + the orchestrator audit (task mars-88a4e657)
 *     for the call-site inventory.
 *
 *  2. The recovery-leaf guard (`isRecoveryTask` / `assertNotRecoveryEdge` /
 *     `RecoveryTaskBlockerError`): per ADR-0040 recovery tasks are leaf nodes
 *     in the task graph — they cannot have blockers, cannot be blocked by
 *     anything, and cannot themselves be recovered. Every user-facing edge
 *     writer (`addBlockers`, `addPendingReviewBlockers`,
 *     `transferProposalBlockerToTask`, the slice-workflow direct INSERTs)
 *     calls `assertNotRecoveryEdge` before inserting so the guard sits at
 *     the bottleneck regardless of caller. The recovery-spawn path
 *     (`upsertFixTask`) is the one legitimate origin → fix edge writer and
 *     bypasses the guard — "fix is leaf" still holds because the recovery
 *     dispatcher refuses to spawn a fix for a task that is itself a fix
 *     (`handleTaskFailureWithFixTask`, ADR-0002 / ADR-0040).
 *
 * Call sites that transition a task to `'blocked'` should call
 * `assertHasBlockerEdge` inside the SAME transaction that inserts the edge —
 * that way a missing edge surfaces immediately instead of silently parking a
 * task with no recovery path.
 *
 * Two previously identified edgeless-blocked violations have been resolved:
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
   * Optional statement runner (a TaskStore `Scope` inside an `atomic`
   * callback, or the store itself) to count against. When provided, the
   * caller is responsible for ensuring the count happens in the same
   * transaction as the status write — that closes the obvious race where
   * the edge is inserted, the count runs, then the edge is rolled back.
   *
   * When omitted, the count runs against the default TaskStore.
   */
  client?: StatementRunner
}

/**
 * Count `task_blockers` rows whose `task_id` matches `taskId`. Returns 0 when
 * the task has no edges (the violation case).
 */
export const countBlockerEdges = async (
  taskId: string,
  opts: BlockerInvariantOptions = {},
): Promise<number> => {
  const c = opts.client ?? (await getDefaultTaskStore())
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
        `a blocked task must point at a concrete blocker to wait on. Route to 'failed' + actionQueue item instead.`,
    )
    this.name = 'BlockerInvariantViolation'
    this.taskId = taskId
  }
}

/**
 * Minimal task shape this module probes for the leaf-node predicate. Kept
 * structural so callers can pass the full `Task` from `queue.ts` or a slim
 * row-projection without an extra import cycle.
 */
export interface RecoveryTaskProbe {
  kind?: string | null
  fixForTaskId?: string | null
}

/**
 * Canonical predicate for "is this a recovery task?". A recovery (fix) task is
 * identified by `kind === 'fix'`. The `fix_for_task_id` pointer must be
 * non-null on every such row (enforced by `assertTaskKindInvariant` in
 * `queue.ts`); we accept the pointer alone as a fallback so the predicate
 * stays robust against rows fetched before the `kind` column was populated.
 * Both signals are equivalent — see ADR-0040.
 */
export const isRecoveryTask = (probe: RecoveryTaskProbe): boolean => {
  if (probe.kind === 'fix') return true
  if (probe.fixForTaskId != null && probe.fixForTaskId !== '') return true
  return false
}

/**
 * Thrown when a caller tries to insert a `task_blockers` edge whose either
 * endpoint is a recovery (fix) task. `role` names which side of the edge
 * the recovery task occupies so the operator can tell whether they tried
 * to block a recovery task or block on one.
 */
export class RecoveryTaskBlockerError extends Error {
  readonly taskId: string
  readonly role: 'task' | 'blocker'

  constructor(taskId: string, role: 'task' | 'blocker') {
    super(
      `Recovery task ${taskId} cannot be the ${role} of a blocker edge (ADR-0040).`,
    )
    this.name = 'RecoveryTaskBlockerError'
    this.taskId = taskId
    this.role = role
  }
}

/**
 * Look up the recovery-marker columns for one task id. Returns `null` when the
 * row is missing — callers expect the caller's existence check to surface that
 * (this helper is for the leaf-node probe only, not row existence).
 */
const probeRecoveryMarker = async (
  client: StatementRunner,
  taskId: string,
): Promise<RecoveryTaskProbe | null> => {
  const r = await client.execute({
    sql: `SELECT kind, fix_for_task_id FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as {
    kind: string | null
    fix_for_task_id: string | null
  }
  return { kind: row.kind, fixForTaskId: row.fix_for_task_id }
}

/**
 * Throw {@link RecoveryTaskBlockerError} when either endpoint of the proposed
 * edge `(taskId, blockerTaskId)` is a recovery (fix) task. Sites that batch
 * the edge INSERT inside an atomic write transaction MUST pass that
 * transaction's client handle so the probe runs in the same unit of work and
 * a row created mid-transaction cannot evade the check.
 *
 * No-op when either row is missing — existence checks belong upstream
 * (`addBlockers` rejects unknown ids with a distinct message).
 */
export const assertNotRecoveryEdge = async (
  taskId: string,
  blockerTaskId: string,
  opts: BlockerInvariantOptions = {},
): Promise<void> => {
  const c = opts.client ?? (await getDefaultTaskStore())
  const task = await probeRecoveryMarker(c, taskId)
  if (task && isRecoveryTask(task)) {
    throw new RecoveryTaskBlockerError(taskId, 'task')
  }
  const blocker = await probeRecoveryMarker(c, blockerTaskId)
  if (blocker && isRecoveryTask(blocker)) {
    throw new RecoveryTaskBlockerError(blockerTaskId, 'blocker')
  }
}

/**
 * Result of {@link scanRecoveryBlockerEdges}. Each entry names one offending
 * `task_blockers` row plus the role(s) the recovery task occupies on that
 * edge. Reported by the daemon startup backfill check.
 */
export interface RecoveryEdgeViolation {
  taskId: string
  blockerTaskId: string
  /** True when `taskId` is itself a recovery task. */
  taskIsRecovery: boolean
  /** True when `blockerTaskId` is itself a recovery task. */
  blockerIsRecovery: boolean
}

/**
 * Read-only scan of `task_blockers` for rows that violate ADR-0040, EXCLUDING
 * two legitimate classes of recovery-blocker edge:
 *
 *  1. The origin→recovery edge written by `upsertFixTask` (where the blocker is
 *     a fix task whose `fix_for_task_id` equals the dependent `task_id`).
 *  2. Shared `main-commiter` edges: a `main-commiter` recovery is a branch-keyed
 *     SHARED recovery that legitimately blocks its whole cohort of dependents
 *     (via `attachToExistingFixTask`, the documented ADR-0040 exemption), so
 *     `blocker_fix_for` only points at ONE of them. Flagging the rest as
 *     violations is a false positive — they are correct while the committer is
 *     active; after success they are released by the missed-success repair,
 *     while a failure leaves them for `reparentStrandedDependentsOntoNewCommitter`.
 *
 * Returns the remaining offending edges so the daemon startup hook can log a
 * one-shot warning for the operator. Never mutates the DB — cleanup is
 * operator-driven via `mars unblock <id>`.
 */
export const scanRecoveryBlockerEdges = async (
  opts: BlockerInvariantOptions = {},
): Promise<RecoveryEdgeViolation[]> => {
  const c = opts.client ?? (await getDefaultTaskStore())
  const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
    './main-dirty.js'
  )
  const r = await c.execute({
    sql: `SELECT b.task_id AS task_id,
                 b.blocker_task_id AS blocker_task_id,
                 t.kind AS task_kind,
                 t.fix_for_task_id AS task_fix_for,
                 bk.kind AS blocker_kind,
                 bk.fix_for_task_id AS blocker_fix_for,
                 bk.recovery_payload AS blocker_recovery_payload
            FROM task_blockers b
            LEFT JOIN tasks t  ON t.id  = b.task_id
            LEFT JOIN tasks bk ON bk.id = b.blocker_task_id`,
    args: [],
  })
  const violations: RecoveryEdgeViolation[] = []
  for (const row of r.rows as unknown as Array<{
    task_id: string
    blocker_task_id: string
    task_kind: string | null
    task_fix_for: string | null
    blocker_kind: string | null
    blocker_fix_for: string | null
    blocker_recovery_payload: string | null
  }>) {
    const taskIsRecovery = isRecoveryTask({
      kind: row.task_kind,
      fixForTaskId: row.task_fix_for,
    })
    const blockerIsRecovery = isRecoveryTask({
      kind: row.blocker_kind,
      fixForTaskId: row.blocker_fix_for,
    })
    const isLegitOriginToRecovery =
      blockerIsRecovery &&
      !taskIsRecovery &&
      row.blocker_fix_for != null &&
      row.blocker_fix_for === row.task_id
    // A shared main-commiter recovery legitimately blocks its whole cohort;
    // every such edge is valid, not just the single origin edge.
    const isLegitSharedCommitterEdge =
      blockerIsRecovery &&
      !taskIsRecovery &&
      parseMainCommiterPayload(row.blocker_recovery_payload)?.recipe ===
        MAIN_COMMITER_RECIPE
    if (
      (taskIsRecovery || blockerIsRecovery) &&
      !isLegitOriginToRecovery &&
      !isLegitSharedCommitterEdge
    ) {
      violations.push({
        taskId: row.task_id,
        blockerTaskId: row.blocker_task_id,
        taskIsRecovery,
        blockerIsRecovery,
      })
    }
  }
  return violations
}
