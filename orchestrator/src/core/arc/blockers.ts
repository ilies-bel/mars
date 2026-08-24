/**
 * Blocker-edge management — the `task_blockers` concern, extracted from the
 * `Arc` aggregate in `core/arc.ts` (ADR-0052 sole-writer, ADR-0040 leaf-node
 * guard).
 *
 * This module owns every write whose *purpose* is a blocker edge: adding,
 * removing and clearing edges, the Linker's pending-review rows, the ADR-0015
 * proposal→task edge transfer, and the `mars unblock <id>` phantom-recovery
 * escape hatch. Together with `core/arc.ts` it forms the allowlisted pair of
 * `task_blockers` writers policed by `core/__tests__/arc-sole-writer.test.ts`.
 *
 * NOT here (deliberately): the cascade/lifecycle methods that touch
 * `task_blockers` incidentally while doing something else — `Arc.drop`,
 * `Arc.spawnRecovery`, `Arc.unblockByCompletion`, `Arc.blockByTaskFailure`,
 * `Arc.cascadeCancellation`, `Arc.recoverBlocked`. Those read and settle edges
 * as part of task-lifecycle transitions and remain on the aggregate.
 *
 * Every function takes its store/ids explicitly rather than reading them off an
 * `Arc` instance, so the concern is testable without constructing an aggregate.
 */
import { type DbStatement } from '../lib/db'
// ADR-0101 item 1: the raw client + schema guarantee come from the
// dependency-free leaf `lib/queue-client`, NOT from the `../queue` facade.
// `../queue` imports the `Arc` aggregate for its facade verbs, so a value
// import from it here closed an `arc/blockers.ts -> queue.ts` cycle. Only the
// `UnblockTaskResult` type still comes from the facade, and a type-only edge
// vanishes at compile time (dependency-cruiser's `no-circular` excludes it).
import { ensureQueueSchema, resolveQueueClient } from '../lib/queue-client'
import type { UnblockTaskResult } from '../queue'
import type { DomainTaskStore } from '../store/task-store'
import { buildEventInsert, withWriteTx } from '../lib/outbox'
import { assertNotRecoveryEdge } from '../lib/blocker-invariant'
import { maybeAssertArcInvariant } from './invariant'

/**
 * Shared front half of {@link addBlockerEdges} and
 * {@link addPendingReviewBlockerEdges}: existence-check the dependent task and
 * every blocker id, dedupe (dropping self-blocks and repeats), then run the
 * ADR-0040 leaf-node guard on both endpoints of every surviving edge.
 *
 * Returns the blocker ids that should be written. An empty array means there is
 * nothing to insert.
 */
const resolveEdgeTargets = async (
  store: DomainTaskStore,
  taskId: string,
  blockerIds: readonly string[],
): Promise<string[]> => {
  const taskRow = await store.execute({
    sql: `SELECT 1 FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (taskRow.rows.length === 0) {
    throw new Error(`task ${taskId} not found`)
  }
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of blockerIds) {
    if (id === taskId) continue
    if (seen.has(id)) continue
    seen.add(id)
    const r = await store.execute({
      sql: `SELECT 1 FROM tasks WHERE id = ?`,
      args: [id],
    })
    if (r.rows.length === 0) {
      throw new Error(`blocker ${id} not found`)
    }
    unique.push(id)
  }
  if (unique.length === 0) return []
  // ADR-0040 leaf-node guard: recovery (fix) tasks cannot be either endpoint of
  // a task_blockers edge. Probe both sides before the batch — the fix-task spawn
  // path (`Arc.spawnRecovery`) is the one legitimate origin → fix writer and
  // bypasses this entry point by reaching `task_blockers` directly.
  for (const blockerId of unique) {
    await assertNotRecoveryEdge(taskId, blockerId, { client: store })
  }
  return unique
}

/**
 * Add user-facing blocker edges in `state='confirmed'`.
 *
 * The recovery-spawn path (`Arc.spawnRecovery`/`Arc.attachToRecovery`) is the
 * one legitimate origin → fix edge writer and bypasses this function by
 * reaching `task_blockers` directly — the ADR-0040 guard does not apply there.
 */
export const addBlockerEdges = async (
  store: DomainTaskStore,
  taskId: string,
  blockerIds: readonly string[],
  options?: { provenance?: 'file-overlap' | 'inferred' },
): Promise<void> => {
  if (blockerIds.length === 0) return
  await ensureQueueSchema()

  const unique = await resolveEdgeTargets(store, taskId, blockerIds)
  if (unique.length === 0) return

  const now = Date.now()
  const provenance = options?.provenance ?? 'inferred'
  // Causal writers default to 'confirmed' state. The Linker writes
  // 'pending-review' rows via a separate entry point. provenance tags
  // whether the edge was forced by file overlap ('file-overlap') or
  // proposed by an LLM ('inferred').
  const stmts = unique.map((blockerId) => ({
    sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, provenance, created_at) VALUES (?, ?, 'confirmed', ?, ?) ON CONFLICT DO NOTHING`,
    args: [taskId, blockerId, provenance, now],
  }))
  await store.batch(stmts, 'write')
  await maybeAssertArcInvariant(taskId, store)
}

/**
 * Write Linker-candidate blocker rows in `'pending-review'` state (ADR-0052,
 * ADR-0006). The Linker is the sole *deriver* of lexical-overlap edges; this
 * module is the sole *writer*. Mirrors {@link addBlockerEdges} but stamps
 * `state='pending-review'` so the dispatcher gates on the row before the
 * operator confirms it.
 */
export const addPendingReviewBlockerEdges = async (
  store: DomainTaskStore,
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  if (blockerIds.length === 0) return
  await ensureQueueSchema()

  // ADR-0040 leaf-node guard applies here too: even pending-review Linker rows
  // are subject to the recovery leaf rule. A recovery task is never the
  // candidate of a keyword-overlap edge.
  const unique = await resolveEdgeTargets(store, taskId, blockerIds)
  if (unique.length === 0) return

  const now = Date.now()
  const stmts = unique.map((blockerId) => ({
    sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'pending-review', ?) ON CONFLICT DO NOTHING`,
    args: [taskId, blockerId, now],
  }))
  await store.batch(stmts, 'write')
}

/**
 * Remove a single blocker edge (ADR-0052); status is unchanged. Reports
 * `{ removed: true }` when a row was deleted, `false` otherwise.
 */
export const removeBlockerEdge = async (
  store: DomainTaskStore,
  taskId: string,
  blockerId: string,
): Promise<{ removed: boolean }> => {
  await ensureQueueSchema()
  const r = await store.execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
    args: [taskId, blockerId],
  })
  return { removed: r.rowsAffected > 0 }
}

/**
 * Remove all outbound blocker edges for `taskId` (ADR-0052). Used by
 * terminal-transition paths (`markTaskDropped`, `markTaskFailed`) to clear the
 * task's dependent edges before or after the status flip. Status is unchanged;
 * callers update status separately via `updateTask`.
 */
export const clearBlockerEdges = async (
  store: DomainTaskStore,
  taskId: string,
): Promise<void> => {
  await ensureQueueSchema()
  await store.execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
}

/**
 * ADR-0015 promote-transfer, executed as a single write batch (ADR-0052).
 * For every task in `dependents` blocked by `proposalId` in
 * `task_proposal_blockers`, atomically deletes that proposal-blocker row and
 * inserts a `'confirmed'` `task_blockers` row pointing at `newBlockerTaskId`,
 * preserving the never-observably-zero-blockers invariant via
 * insert-before-delete ordering within the batch.
 *
 * Spans multiple task IDs, so no single Arc instance owns it — but like every
 * other writer in this module it takes its store explicitly (ADR-0101 item 1:
 * reaching for `getDefaultDomainTaskStore()` here was the last value-level
 * import of `store/task-store.ts`, which imports `Arc`, so it closed an
 * `arc/blockers.ts -> store/task-store.ts` cycle). The caller supplies the
 * process-wide default store.
 */
export const transferProposalBlockerEdges = async (
  store: DomainTaskStore,
  dependents: string[],
  newBlockerTaskId: string,
  proposalId: string,
): Promise<{ transferred: string[] }> => {
  if (dependents.length === 0) return { transferred: [] }
  // ADR-0040 leaf-node guard: refuse the transfer if any endpoint is a
  // recovery task. dependents are tasks waiting on a proposal — they are
  // origin work by construction, so practical violations are unlikely, but
  // the guard runs anyway so the bottleneck sits at every task_blockers writer.
  for (const taskId of dependents) {
    if (taskId === newBlockerTaskId) continue
    await assertNotRecoveryEdge(taskId, newBlockerTaskId, { client: store })
  }
  const now = Date.now()
  const stmts: DbStatement[] = []
  for (const taskId of dependents) {
    // Insert the task_blockers row BEFORE deleting the task_proposal_blockers
    // row so statement ordering inside the batch also preserves the
    // never-observably-zero-blockers invariant. Self-edges are skipped,
    // mirroring addBlockerEdges.
    if (taskId !== newBlockerTaskId) {
      stmts.push({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [taskId, newBlockerTaskId, now],
      })
    }
    stmts.push({
      sql: `DELETE FROM task_proposal_blockers WHERE task_id = ? AND proposal_id = ?`,
      args: [taskId, proposalId],
    })
  }
  await store.batch(stmts, 'write')
  return { transferred: dependents }
}

/**
 * Manual unblock escape hatch (ADR-0052 sole-writer). Flips a
 * `blocked`-or-`queued` task to `failed`, clears its `task_blockers` rows, and
 * emits `task.failed` + `task.terminal` — all in ONE write transaction
 * (ADR-0030) so the status write is never a silent bypass of the event
 * substrate. Used by `mars unblock <id>` so users do not reach for raw SQL when
 * a row has slipped into an inconsistent state.
 *
 * PARITY (preserved bit-for-bit from the historic `unblockTask`):
 *   - `'queued'` is accepted alongside `'blocked'` (drop a not-yet-dispatched
 *     row); any other status returns `{ outcome: 'noop' }`;
 *   - the guarded UPDATE uses the `updated_at`-first SET ordering;
 *   - the terminal event fires with reason `'failed'`; per ADR-0028 the
 *     Invalidator deliberately does NOT close action-queue rows on `failed`.
 */
export const failAndClearBlockerEdges = async (
  taskId: string,
): Promise<UnblockTaskResult> => {
  await ensureQueueSchema()
  // TODO(mars-8a44f22d): this drives a write transaction via the raw client.
  // Thread a `store?: DomainTaskStore` parameter and use
  // `store.atomic(scope => ...)` for the UPDATE + event inserts so that this
  // can retire its resolveQueueClient() usage.
  const c = resolveQueueClient()
  const before = await c.execute({
    sql: `SELECT status FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (before.rows.length === 0) {
    throw new Error(`task ${taskId} not found`)
  }
  const previousStatus = (before.rows[0] as unknown as { status: string }).status
  if (previousStatus !== 'blocked' && previousStatus !== 'queued') {
    return { taskId, outcome: 'noop', previousStatus }
  }
  const now = new Date().toISOString()
  await withWriteTx(c, async (tx) => {
    await tx.execute({
      // updated_at first — conditional WHERE; events published atomically below.
      sql: `UPDATE tasks
               SET updated_at = ?,
                   status = 'failed'
             WHERE id = ? AND status IN ('blocked', 'queued')`,
      args: [now, taskId],
    })
    await tx.execute({
      sql: `DELETE FROM task_blockers WHERE task_id = ?`,
      args: [taskId],
    })
    await tx.execute(
      buildEventInsert('task.failed', {
        taskId,
        error: 'unblocked via mars unblock',
      }),
    )
    await tx.execute(
      buildEventInsert('task.terminal', { taskId, reason: 'failed' }),
    )
  })
  return { taskId, outcome: 'unblocked', previousStatus }
}
