import { type DbInValue } from './lib/db'
import { ensureQueueSchema, resolveQueueClient } from './lib/queue-client'
// `Arc` itself is deliberately NOT imported here: every Arc write below goes
// through the `getArcWriter()` port seam in `lib/queue-primitives.ts`. Only
// `updateTask` — which ADR-0101 relocated into arc.ts — is still imported
// directly, for the two local call sites and the back-compat re-export below.
import { updateTask } from './arc'
import {
  addBlockerEdges,
  addPendingReviewBlockerEdges,
  clearBlockerEdges,
  failAndClearBlockerEdges,
  removeBlockerEdge,
  transferProposalBlockerEdges,
} from './arc/blockers'
import { getDefaultDomainTaskStore } from './store/task-store'
import type { DomainTaskStore as TaskStore } from './store/task-store'

// ADR-0101: Pure types, validators, row mappers, and getTask extracted to
// the dependency-free leaf `queue-primitives.ts`. Re-exported here for
// backward compatibility with ~200 existing importers.
export {
  type TaskStatus,
  type TaskDropReason,
  type TaskKind,
  type TaskTag,
  type FailedPhase,
  type MergeMode,
  type TaskSpec,
  type TaskPlan,
  type QaReportCriterion,
  type QaReport,
  type Task,
  type EnqueueTaskOptions,
  type DropTaskResult,
  TERMINAL_TASK_STATUSES,
  UNSETTLED_BLOCKER_SQL,
  MIN_PRIORITY,
  MAX_PRIORITY,
  TASK_TAGS,
  MERGE_MODES,
  EMPTY_TASK_SPEC,
  isTaskTag,
  isMergeMode,
  validatePriority,
  deriveTaskKind,
  assertTaskKindInvariant,
  coerceToString,
  IllegalTransitionError,
  TASK_SEL,
  ORDINARY_TASK_SQL,
  rowToTask,
  getTask,
  // Arc writer port. Re-exported so `store/task-store.ts` and other existing
  // `from '../queue'` importers reach the seam without a new import boundary.
  type ArcWriterPort,
  registerArcWriter,
  getArcWriter,
} from './lib/queue-primitives'

// Local imports for functions that remain in this file
import {
  type TaskStatus,
  type Task,
  type TaskPlan,
  type EnqueueTaskOptions,
  type DropTaskResult,
  TERMINAL_TASK_STATUSES,
  UNSETTLED_BLOCKER_SQL,
  TASK_SEL,
  ORDINARY_TASK_SQL,
  rowToTask,
  getArcWriter,
} from './lib/queue-primitives'

/**
 * The statuses at which a recovery task (`fix_for_task_id IS NOT NULL`) counts
 * as IN FLIGHT — i.e. the arc already has a corrective action underway and a
 * second corrective action would collide with it.
 *
 * This is the single definition behind three guards that must agree:
 *  - `mars continue` (`daemon/continue-task.ts`) refuses to resume a task whose
 *    recovery is still in flight,
 *  - `mars restart` (`daemon/restart-task.ts`) refuses to wipe a worktree an
 *    in-flight recovery is working in,
 *  - `maybeSpawnRescueOperator` (`rescue-operator-spawn.ts`) refuses to spawn a
 *    rescue whose only permitted actions are the two verbs above — it could
 *    only ever no-op against them.
 *
 * NOT the complement of {@link TERMINAL_TASK_STATUSES}: the parked statuses
 * (`triaging`, `awaiting-validation`, `awaiting-human`, `under_investigation`)
 * are deliberately absent, since a recovery parked on a human is not a moving
 * corrective action and must not hold the guards shut indefinitely.
 *
 * Ordered, not a Set, because every consumer expands it into a SQL `IN (...)`
 * clause with one placeholder per member.
 */
export const IN_FLIGHT_RECOVERY_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
  'draft',
  'blocked',
]

/**
 * The statuses at which a blocker STOPS gating its dependents.
 *
 * - `done`    — the blocked-on work landed; the dependent's premise holds.
 * - `dropped` — the blocked-on work was explicitly called off (superseded,
 *   origin-succeeded, arc-rescued, resliced, …). It is terminal and will never
 *   reach `done`, so a dependent waiting for it waits forever. Dropping is a
 *   deliberate "this is not happening" decision, it raises no action-queue row
 *   to resolve (ADR-0028 treats `dropped` as a CLOSING terminal reason), and
 *   the row-deleting sibling gesture `mars drop` already releases dependents
 *   inline (see `Arc.drop`). Releasing here makes both drop shapes agree.
 *
 * `failed` is deliberately ABSENT. A failed blocker leaves its dependents
 * waiting in `blocked` for operator resolution via the action-queue row the
 * failure raises — the failure does not cascade down the chain (CLAUDE.md
 * § Blockers). The single carve-out is an origin waiting on its OWN failed
 * one-shot recovery, which `Arc.failStrandedOriginOnRecoveryFailure` fails
 * explicitly rather than releasing.
 */
export const SETTLED_BLOCKER_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'dropped',
])

/**
 * Transient lifecycle phase between a freshly-promoted task (draft → triaging)
 * and dispatch-eligible (`'queued'`). Triaging tasks are visible to readers
 * but the dispatcher MUST NOT dispatch them — they are awaiting deterministic
 * linker analysis that may attach `pending-review` Blocker rows. See PRD
 * 2be831da-replace-the-llm-based-triage-linker-with.
 */
export const NON_DISPATCHABLE_STATUSES: readonly TaskStatus[] = [
  'draft',
  'triaging',
  'blocked',
  'running',
  'verifying',
  // Parked at the preview gate; only an explicit operator Validate re-queues
  // the task for its merge continuation. The dispatcher must never pick it up.
  'awaiting-validation',
  // Parked for operator-owned interactive work; the dispatcher must never pick
  // it up — resumption is explicit (lease release → re-queue).
  'awaiting-human',
  'merging',
  'vega-reconciling',
  'done',
  'failed',
  'dropped',
  // Operator-triggered parking status: the worktree is under human investigation;
  // the task MUST NOT be re-dispatched until explicitly re-queued.
  'under_investigation',
] as const

export const isDispatchableStatus = (status: TaskStatus): boolean =>
  status === 'queued'

/**
 * State of a {@link Blocker} row. The Linker writes `'pending-review'` for
 * keyword-overlap candidates; causal writers (manual blocks, fix-task wiring)
 * write `'confirmed'`. `'rejected'` records that a candidate has been ruled
 * out and must not gate dispatch. The dispatcher's eligibility query treats
 * a task as dispatchable iff its status is `'queued'` AND it has zero rows
 * in `('confirmed', 'pending-review')` state.
 */
export type BlockerState = 'confirmed' | 'pending-review' | 'rejected'

export const BLOCKER_STATES: readonly BlockerState[] = [
  'confirmed',
  'pending-review',
  'rejected',
] as const

export const isBlockerState = (value: unknown): value is BlockerState =>
  value === 'confirmed' || value === 'pending-review' || value === 'rejected'

/**
 * Polymorphic target kind for a Blocker row. The legacy `task_blockers` table
 * is task→task only; the new shape lets a Blocker row name either a Task or
 * an Idea (proposal) as its cause. `'idea'` rows are stored in the
 * `task_proposal_blockers` junction; the read-time {@link listAllBlockers}
 * folds both kinds into one uniform list keyed by `causeKind`.
 */
export type BlockerCauseKind = 'task' | 'idea'

export interface Blocker {
  taskId: string
  causeKind: BlockerCauseKind
  causeId: string
  state: BlockerState
  createdAt: number
}

/**
 * `resolveQueueClient` / `ensureQueueSchema` now live in the dependency-free
 * leaf `core/lib/queue-client.ts` (ADR-0101 item 1) so that modules inside the
 * Arc aggregate can reach the raw client without importing this facade — which
 * imports `Arc` and therefore closed a cycle. They are re-exported here because
 * this module is their public surface for the ~200 call sites outside the
 * aggregate; new call sites in `core/arc*` must import the leaf directly.
 */
export { resolveQueueClient, ensureQueueSchema }

/**
 * Compatibility name retained while callers migrate from the SQLite-era
 * bootstrap API. PostgreSQL has one canonical, idempotent schema.
 */
export const migrateQueueSchema = (): Promise<void> => ensureQueueSchema()

// ADR-0101: upsertTranscript extracted to the dependency-free leaf
// `core/lib/transcript.ts`. Re-exported here for backward compatibility.
export {
  capConversationJson,
  upsertTranscript,
  type UpsertTranscriptInput,
} from './lib/transcript'

export interface TaskTranscriptRow {
  taskId: string
  conversationJson: string
  verifyOutput: string | null
  bytes: number
  recordedAt: string
}

export const getTranscript = async (
  taskId: string,
): Promise<TaskTranscriptRow | null> => {
  // After PRD 436f14c7 slice 5, transcript data lives in trace_events.
  // Return the most recent step_ended event for this task that has either
  // a transcript or verifyOutput in its payload.
  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `SELECT timestamp, payload
            FROM trace_events
           WHERE kind = 'step_ended' AND task_id = ?
           ORDER BY timestamp DESC
           LIMIT 1`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { timestamp: number; payload: string }
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    /* ignore malformed payload */
  }
  const conversationJson = (payload.transcript as string | null | undefined) ?? ''
  return {
    taskId,
    conversationJson,
    verifyOutput: (payload.verifyOutput as string | null | undefined) ?? null,
    bytes: conversationJson.length,
    recordedAt: new Date(row.timestamp).toISOString(),
  }
}

/**
 * Public origin-creation entry point. Thin wrapper that delegates to the Arc
 * aggregate's origin write funnel ({@link Arc.createOrigin}, ADR-0052). The
 * exported signature `(prompt, plan?, opts?)` is preserved bit-for-bit for the
 * many call sites and tests that import it; only the internals route through
 * Arc now. The origin `INSERT INTO tasks` (plus the junction-table writes)
 * lives in `Arc.createOrigin`, not here.
 */
export const enqueueTask = async (
  prompt: string,
  plan?: TaskPlan,
  opts?: EnqueueTaskOptions,
): Promise<Task> => {
  return getArcWriter().createOrigin({ prompt, plan, opts })
}

/**
 * `setTaskStatus` and its `mapStatusToEvent` helper were relocated into the
 * Arc aggregate (ADR-0052 sole-writer) — see `Arc.setTaskStatus` in
 * `core/arc.ts`. The raw `UPDATE tasks SET status` + the four publish()
 * branches now live there; callers import `Arc` and call
 * `Arc.setTaskStatus(taskId, newStatus, extras?, store?)`.
 */

/**
 * `updateTask` and `deriveFailureSignature` were relocated into `arc.ts`
 * (ADR-0101) to break the arc → queue dependency cycle. Re-exported here
 * for backward compatibility.
 */
export { updateTask } from './arc'


/**
 * The sole audited seam for an operator to reopen a terminal task. Thin
 * wrapper over {@link Arc.reopenTerminalTask} (ADR-0052 sole-writer): the
 * raw `UPDATE tasks SET …` now lives in `core/arc.ts`, the only legitimate
 * task-table writer. General task updates cannot use this capability: the
 * database trigger consumes the audit record in the same transaction as
 * this transition.
 */
export const reopenTerminalTask = async (
  id: string,
  reason: string,
  store?: TaskStore,
): Promise<void> => getArcWriter().reopenTerminalTask(id, reason, store)

export const listTasks = async (status?: TaskStatus): Promise<Task[]> => {
  await ensureQueueSchema()
  const r = status
    ? await resolveQueueClient().execute({
        sql: `${TASK_SEL} WHERE ${ORDINARY_TASK_SQL} AND t.status = ? ORDER BY t.priority DESC, t.created_at ASC`,
        args: [status],
      })
    : await resolveQueueClient().execute(
        `${TASK_SEL} WHERE ${ORDINARY_TASK_SQL} ORDER BY t.priority DESC, t.created_at ASC`,
      )
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
}

/**
 * Return the newest non-done tasks other than `excludeId`, capped at `limit`.
 * The triage workflow reverses this descending result before rendering it so
 * its prompt preserves listTasks' historic oldest-first display order.
 */
export const listNonDoneTasks = async (
  excludeId: string,
  limit: number,
): Promise<Task[]> => {
  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `${TASK_SEL} WHERE ${ORDINARY_TASK_SQL} AND t.status <> 'done' AND t.id <> ? ORDER BY t.created_at DESC LIMIT ?`,
    args: [excludeId, limit],
  })
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
}

/** Return only task ids that currently exist. */
export const filterExistingTaskIds = async (
  ids: readonly string[],
): Promise<string[]> => {
  if (ids.length === 0) return []

  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: 'SELECT id FROM tasks WHERE id = ANY(?::text[])',
    args: [ids],
  })
  return r.rows.map((row) => (row as { id: string }).id)
}

/**
 * Paginated task listing. Returns up to `limit` rows (ordered by priority
 * DESC, created_at ASC) alongside the total row count matching the optional
 * status filter. When `limit` is undefined all matching rows are returned
 * (escape-hatch for `--all`).
 */
export const listTasksPaged = async (
  status?: TaskStatus,
  limit?: number,
): Promise<{ tasks: Task[]; total: number }> => {
  await ensureQueueSchema()
  const client = resolveQueueClient()

  const countArgs: DbInValue[] = []
  let countSql = `SELECT COUNT(*) AS n FROM tasks t WHERE ${ORDINARY_TASK_SQL}`
  if (status !== undefined) {
    countSql += ' AND t.status = ?'
    countArgs.push(status)
  }
  const countResult = await client.execute(
    countArgs.length ? { sql: countSql, args: countArgs } : countSql,
  )
  const total = Number(
    (countResult.rows[0] as Record<string, unknown>)['n'] ?? 0,
  )

  const taskArgs: DbInValue[] = []
  let taskSql = `${TASK_SEL} WHERE ${ORDINARY_TASK_SQL}`
  if (status !== undefined) {
    taskSql += ' AND t.status = ?'
    taskArgs.push(status)
  }
  taskSql += ' ORDER BY t.priority DESC, t.created_at ASC'
  if (limit !== undefined) {
    taskSql += ' LIMIT ?'
    taskArgs.push(limit)
  }
  const r = await client.execute(
    taskArgs.length ? { sql: taskSql, args: taskArgs } : taskSql,
  )

  return {
    tasks: r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>)),
    total,
  }
}

/**
 * Reprioritize a still-queued task. Thin wrapper over the Arc aggregate's
 * {@link Arc.reprioritize} write funnel (ADR-0052 sole-writer): the priority
 * `UPDATE tasks SET …` now lives in `core/arc.ts`, the only legitimate
 * task-table writer. The validation, the `'queued'`-only guard, and the
 * re-select all live there; this keeps the historic name/signature for the
 * store + daemon callers.
 */
export const setTaskPriority = async (
  id: string,
  priority: number,
): Promise<Task> => getArcWriter().reprioritize(id, priority)

/**
 * Update the verify command for a task. Thin wrapper over
 * {@link Arc.setVerifyCmd} (ADR-0052 sole-writer): the `verify_cmd`
 * `UPDATE tasks SET …` now lives in `core/arc.ts`, the only legitimate
 * task-table writer.
 *
 * Allowed for all non-done, non-dropped tasks (including failed tasks, which
 * need their spec repaired before they can be re-tried). Rejects done and
 * dropped tasks — those rows are immutable.
 *
 * The caller is responsible for validating that `verifyCmd` uses relative
 * paths (i.e. does not embed the repo root as an absolute prefix). That check
 * lives at the CLI layer, mirroring the guard on `task add --verify`.
 */
export const setTaskVerifyCmd = async (
  id: string,
  verifyCmd: string | null,
): Promise<{ id: string; verifyCmd: string | null }> => getArcWriter().setVerifyCmd(id, verifyCmd)

/**
 * Database-level drop. Thin wrapper over {@link Arc.drop} (ADR-0052): the full
 * cascade — pre-delete `task.dropped`/`task.terminal` emits, dependent
 * re-queue, proposal-blocker cleanup, fix-task cascade, and the final DELETEs,
 * all inside one atomic transaction (ADR-0030 / ADR-0049) — lives on the Arc
 * aggregate now. Signature kept byte-identical for the task-store facade and
 * existing call sites (`corePurgeTask`, etc.).
 *
 * Caller is responsible for cancelling any in-flight workflow and removing the
 * worktree+branch on disk before invoking this.
 */
export const dropTask = async (id: string): Promise<DropTaskResult> => {
  return getArcWriter().drop(id)
}

/**
 * Returns `true` when at least one **non-terminal** task other than
 * `excludeTaskId` references the same `worktreePath` (if non-null) **or**
 * the same `branch`.
 *
 * Fix/rescue tasks that operate on their origin's branch and worktree store
 * the *same* `worktree_path` and `branch` values as the origin row.  Callers
 * that are about to remove a worktree directory or delete a branch ref must
 * call this guard first and skip cleanup when it returns `true`, so that a
 * stale-recovery drop never destroys filesystem resources still owned by a
 * live origin.
 *
 * Non-terminal statuses are all statuses NOT in
 * {@link TERMINAL_TASK_STATUSES} (`done | failed | dropped`).
 */
export const isWorktreeSharedWithLiveTask = async (
  worktreePath: string | null,
  branch: string,
  excludeTaskId: string,
): Promise<boolean> => {
  await ensureQueueSchema()
  const args: string[] = []
  let whereClauses: string

  if (worktreePath !== null) {
    whereClauses = '(worktree_path = ? OR branch = ?)'
    args.push(worktreePath, branch)
  } else {
    whereClauses = 'branch = ?'
    args.push(branch)
  }
  args.push(excludeTaskId)

  const r = await resolveQueueClient().execute({
    sql: `SELECT 1 FROM tasks
           WHERE ${whereClauses}
             AND id != ?
             AND status NOT IN ('done', 'failed', 'dropped')
           LIMIT 1`,
    args,
  })
  return r.rows.length > 0
}

/**
 * Insert a self-arc reflection task. Thin wrapper over
 * {@link Arc.insertReflection} (ADR-0052): the `INSERT INTO tasks`
 * (`origin_id = self`, status `'done'`) lives on the Arc aggregate now.
 * Signature kept byte-identical for the task-store facade and existing call
 * sites (`mars reflect`).
 */
export const insertReflectionTask = async (corpusSize: number): Promise<string> => {
  return getArcWriter().insertReflection(corpusSize)
}

/**
 * Add user-facing blocker edges. Thin wrapper over {@link addBlockerEdges}
 * (ADR-0052): the existence checks, dedupe, ADR-0040 leaf-node guard, and the
 * `state='confirmed'` batch INSERT all live on the Arc aggregate now. Signature
 * kept byte-identical for the task-store facade and existing call sites
 * (`upsertFixTask` non-exempt paths).
 */
export const addBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  await addBlockerEdges(getDefaultDomainTaskStore(), taskId, blockerIds)
}

/**
 * Write a batch of Linker candidate Blocker rows in `'pending-review'` state.
 * Mirrors {@link addBlockers} but stamps `state='pending-review'` so the
 * dispatcher still gates on the row even though it has not been confirmed.
 * Used by the deterministic Linker added by PRD 2be831da; tests exercise it
 * directly until the Linker landing slice wires the call site.
 */
/**
 * Write Linker-candidate blocker rows in `'pending-review'` state (ADR-0006).
 * Thin wrapper over {@link addPendingReviewBlockerEdges} (ADR-0052): the Linker
 * is the sole *deriver* of lexical-overlap edges; Arc is the sole *writer* of
 * `task_blockers` rows. Signature kept for existing call sites.
 */
export const addPendingReviewBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  await addPendingReviewBlockerEdges(getDefaultDomainTaskStore(), taskId, blockerIds)
}

/**
 * Remove a single blocker edge. Thin wrapper over {@link removeBlockerEdge}
 * (ADR-0052); status is unchanged. Signature kept byte-identical for the
 * task-store facade and existing call sites.
 */
export const removeBlocker = async (
  taskId: string,
  blockerId: string,
): Promise<{ removed: boolean }> => {
  return removeBlockerEdge(getDefaultDomainTaskStore(), taskId, blockerId)
}

export const clearBlockers = async (taskId: string): Promise<void> => {
  await clearBlockerEdges(getDefaultDomainTaskStore(), taskId)
}

/**
 * ADR-0015 cross-graph edge writer. Adds `task_proposal_blockers` rows so
 * `taskId` waits on each `proposalId` (a queued task that cannot dispatch
 * until that idea has been shaped and promoted). Mirrors `addBlockers`: the
 * task must exist and duplicates/no-ops are handled via `ON CONFLICT DO NOTHING`.
 *
 * `proposalId` lives in a separate domain (proposals), so it cannot be FK-validated
 * here; existence is checked by the caller against `proposals` before this
 * runs (the CLI verb resolves it via `resolveProposalId`). A self-edge is
 * impossible by construction here — endpoints are different kinds (task vs
 * proposal) and id namespaces do not overlap — so no self-edge guard is
 * needed (contrast `addBlockers`, where both endpoints are tasks).
 */
export const addProposalBlockers = async (
  taskId: string,
  proposalIds: readonly string[],
): Promise<void> => {
  if (proposalIds.length === 0) return
  await ensureQueueSchema()
  const c = resolveQueueClient()

  const taskRow = await c.execute({
    sql: `SELECT 1 FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (taskRow.rows.length === 0) {
    throw new Error(`task ${taskId} not found`)
  }
  const seen = new Set<string>()
  const unique: string[] = []
  for (const id of proposalIds) {
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  if (unique.length === 0) return
  const now = Date.now()
  const stmts = unique.map((proposalId) => ({
    sql: `INSERT INTO task_proposal_blockers (task_id, proposal_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [taskId, proposalId, now],
  }))
  await c.batch(stmts, 'write')
}

/**
 * List proposal ids that `taskId` is blocked by in `task_proposal_blockers`,
 * ordered by edge creation time. No status filter: proposal status lives in
 * a separate domain (proposals) and the dispatch gate only cares whether ANY row
 * still references an un-promoted proposal — that join is the dispatcher's
 * concern, not this reader's.
 */
export const listProposalBlockers = async (
  taskId: string,
): Promise<string[]> => {
  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `SELECT proposal_id AS id
            FROM task_proposal_blockers
           WHERE task_id = ?
           ORDER BY created_at ASC`,
    args: [taskId],
  })
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

/**
 * Remove a single `task_proposal_blockers` edge. Mirrors `removeBlocker`:
 * reports `removed:false` when the (task, proposal) pair did not exist.
 */
export const removeProposalBlocker = async (
  taskId: string,
  proposalId: string,
): Promise<{ removed: boolean }> => {
  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `DELETE FROM task_proposal_blockers WHERE task_id = ? AND proposal_id = ?`,
    args: [taskId, proposalId],
  })
  return { removed: r.rowsAffected > 0 }
}

/**
 * List task ids that are blocked by `proposalId` in
 * `task_proposal_blockers`. Used by the ADR-0015 dismiss-refusal path: the
 * dismiss is refused while ANY task still depends on the idea, and the
 * dependents must be surfaced to the user so they explicitly redirect or
 * drop them (no auto-cascade).
 */
export const listTasksBlockedByProposal = async (
  proposalId: string,
): Promise<string[]> => {
  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `SELECT task_id AS id
            FROM task_proposal_blockers
           WHERE proposal_id = ?
           ORDER BY created_at ASC`,
    args: [proposalId],
  })
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

/**
 * ADR-0015 promote transfer, executed as a SINGLE libSQL write transaction.
 * For every task that is blocked by `proposalId` in
 * `task_proposal_blockers`, this deletes that (task_id, proposal_id) row and
 * inserts (task_id, newBlockerTaskId) into `task_blockers` in the SAME
 * `batch(..., 'write')`. Because both tables live in one database this is a
 * genuine atomic transaction — no dispatcher tick can observe a dependent
 * task with zero blockers between the two writes. (The proposal status flip
 * to 'prd-ready' happens in a separate domain and is independent of this invariant:
 * a status flip without the blocker transfer would still leave the task
 * gated by the surviving `task_proposal_blockers` row, never zero-blocked.)
 *
 * Returns the task ids whose blocker was transferred.
 *
 * TODO(ADR-0015 fan-out): ADR-0015 only pins the single new_blocker_task_id
 * case ("inserts (task_id, new_blocker_task_id)"). When an idea is promoted
 * and later sliced into N tasks, the dependent should arguably end up
 * blocked by all N resulting tasks. The ADR is SILENT on this multi-slice
 * fan-out, so per the task brief this implements the single-new-blocker
 * case verbatim and does NOT invent fan-out semantics. Re-promote/slice
 * wiring for the N-task case is deferred and called out in the report.
 */
export const transferProposalBlockerToTask = async (
  proposalId: string,
  newBlockerTaskId: string,
): Promise<{ transferred: string[] }> => {
  await ensureQueueSchema()
  const c = resolveQueueClient()
  const dependents = await listTasksBlockedByProposal(proposalId)
  if (dependents.length === 0) return { transferred: [] }
  const blockerRow = await c.execute({
    sql: `SELECT 1 FROM tasks WHERE id = ?`,
    args: [newBlockerTaskId],
  })
  if (blockerRow.rows.length === 0) {
    throw new Error(`blocker task ${newBlockerTaskId} not found`)
  }
  // Delegate to the blocker-edge module (ADR-0052 sole-writer for
  // task_blockers). transferProposalBlockerEdges re-runs the ADR-0040 leaf-node
  // guard and builds the atomic INSERT+DELETE batch. It takes the store
  // explicitly (rather than resolving its own default) so arc/blockers.ts
  // does not import store/task-store.ts at runtime.
  return transferProposalBlockerEdges(
    getDefaultDomainTaskStore(),
    dependents,
    newBlockerTaskId,
    proposalId,
  )
}

export interface UnblockTaskResult {
  taskId: string
  outcome: 'unblocked' | 'noop'
  previousStatus: string
}

/**
 * Manual escape hatch: flip a `blocked` task to `failed`, clearing any
 * `task_blockers` rows pointing from it. Used by `mars unblock <id>` so users
 * do not need to reach for raw SQL when the row has slipped into an
 * inconsistent state (stale junction rows after a blocker was purged).
 */
/**
 * Thin wrapper over {@link failAndClearBlockerEdges} (ADR-0052 sole-writer). The
 * `blocked|queued → failed` status write + blocker clear + `task.failed` /
 * `task.terminal` emit now live inside the Arc aggregate; this export keeps the
 * historic call surface (`mars unblock <id>`, the daemon RPC, the `TaskStore`
 * facade) green by delegating verbatim.
 */
export const unblockTask = async (
  taskId: string,
): Promise<UnblockTaskResult> => {
  return failAndClearBlockerEdges(taskId)
}

/**
 * List sibling task ids that share the same `origin_id` as the given task.
 * Used by `mars show <task-id>` to surface other tasks sliced from the same
 * originating proposal (or related task arc). Excludes the task itself.
 *
 * Returns an empty array when `originId === excludeTaskId` (the task is its
 * own origin and therefore has no siblings) or when no other rows match.
 */
export const listSiblings = async (
  originId: string,
  excludeTaskId: string,
): Promise<string[]> => {
  if (originId === excludeTaskId) return []
  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `SELECT id FROM tasks
            WHERE origin_id = ? AND id != ?
            ORDER BY created_at ASC`,
    args: [originId, excludeTaskId],
  })
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

/**
 * List tasks that reference the given proposal as their `origin_id`. Used
 * by `mars show <proposal-id>` to surface the tasks sliced from that
 * proposal. Returns id and status, ordered by creation time so the display
 * reflects the slicing order.
 */
export const listTasksForProposal = async (
  proposalId: string,
): Promise<Array<{ id: string; status: string }>> => {
  await ensureQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `SELECT id, status FROM tasks
            WHERE origin_id = ?
            ORDER BY created_at ASC`,
    args: [proposalId],
  })
  return r.rows.map((row) => {
    const r = row as unknown as { id: string; status: string }
    return { id: r.id, status: r.status }
  })
}

export const listBlockers = async (taskId: string): Promise<string[]> => {
  await ensureQueueSchema()
  // Only confirmed-or-pending-review rows gate dispatch; rejected rows are
  // historical/audit and must not appear here.
  const r = await resolveQueueClient().execute({
    sql: `SELECT b.blocker_task_id AS id
            FROM task_blockers b
            JOIN tasks t ON t.id = b.blocker_task_id
           WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
             AND b.state IN ('confirmed', 'pending-review')`,
    args: [taskId],
  })
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

/**
 * True when at least one confirmed/pending-review blocker edge still gates
 * `taskId` — i.e. points at a blocker that has not SETTLED
 * ({@link SETTLED_BLOCKER_STATUSES}: `done` or `dropped`).
 */
export const hasIncompleteBlockers = async (taskId: string, store?: TaskStore): Promise<boolean> => {
  const stmt = {
    sql: `SELECT 1
            FROM task_blockers b
            JOIN tasks t ON t.id = b.blocker_task_id
           WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
             AND b.state IN ('confirmed', 'pending-review')
           LIMIT 1`,
    args: [taskId],
  }
  let r
  if (store) {
    r = await store.query(stmt)
  } else {
    await ensureQueueSchema()
    r = await resolveQueueClient().execute(stmt)
  }
  return r.rows.length > 0
}

/**
 * Atomically flip `taskId` from 'queued'/'draft' to 'blocked' IF AND ONLY IF
 * at least one confirmed-or-pending-review blocker edge still points to an
 * unsettled blocker at the moment of the write.
 *
 * ### Why this exists — the race in handleAdd
 *
 * The two-step pattern this replaces:
 *   1. hasIncompleteBlockers(dep) → true
 *   2. updateTask(dep, { status: 'blocked' })  ← RACE HERE
 *
 * Between steps 1 and 2, a concurrent Arc.drop(blocker) can delete the edge
 * while dep is still 'queued'. Arc.drop's re-queue guard fires only on tasks
 * already in 'blocked', so it misses dep. When step 2 then runs, dep lands as
 * 'blocked' with ZERO edges — the illegal stranded-blocked state that required
 * operator intervention via `mars unblock + mars restart`.
 *
 * This function closes that window with a secondary check-after-write guard:
 * if the edge vanished between the first check and the write, it restores dep
 * to 'queued' (emitting task.queued so drain() picks it up) before returning
 * false. The residual window between the secondary check and the restore write
 * is covered by the orphanedBlockedScan startup reconciler as a backstop.
 *
 * @returns true when dep was parked as 'blocked' with at least one live edge,
 *          false when it was left in (or restored to) 'queued'.
 */
export const blockTaskIfIncomplete = async (taskId: string): Promise<boolean> => {
  if (!(await hasIncompleteBlockers(taskId))) return false
  await updateTask(taskId, { status: 'blocked' })
  // Secondary guard: re-check after the write. If a concurrent Arc.drop of
  // the blocker deleted the edge between the check above and the write above,
  // the edge is now gone but dep is 'blocked'. Restore 'queued' (emits
  // task.queued → daemon drain picks it up) to prevent the stranded-blocked
  // state.
  if (!(await hasIncompleteBlockers(taskId))) {
    await updateTask(taskId, { status: 'queued' })
    return false
  }
  return true
}

/**
 * Polymorphic Blocker reader: returns every Blocker row that gates `taskId`,
 * folding `task_blockers` (cause=task) and `task_proposal_blockers`
 * (cause=idea) into a single uniform list. Rejected rows are excluded.
 * Order: confirmed first, then pending-review, then by createdAt ascending.
 */
export const listAllBlockers = async (taskId: string): Promise<Blocker[]> => {
  await ensureQueueSchema()
  const c = resolveQueueClient()
  const taskRows = await c.execute({
    sql: `SELECT blocker_task_id AS cause_id, state, created_at
            FROM task_blockers
           WHERE task_id = ?
             AND state IN ('confirmed', 'pending-review')`,
    args: [taskId],
  })
  const ideaRows = await c.execute({
    sql: `SELECT proposal_id AS cause_id, created_at
            FROM task_proposal_blockers
           WHERE task_id = ?`,
    args: [taskId],
  })
  const blockers: Blocker[] = [
    ...taskRows.rows.map((row) => {
      const r = row as unknown as {
        cause_id: string
        state: string
        created_at: number
      }
      return {
        taskId,
        causeKind: 'task' as const,
        causeId: r.cause_id,
        state: (isBlockerState(r.state) ? r.state : 'confirmed') as BlockerState,
        createdAt: r.created_at,
      }
    }),
    ...ideaRows.rows.map((row) => {
      const r = row as unknown as { cause_id: string; created_at: number }
      // Proposal blockers are always treated as confirmed gates — the
      // ADR-0015 cross-graph edge has no per-row state column yet (a future
      // slice may add one alongside the Linker for ideas).
      return {
        taskId,
        causeKind: 'idea' as const,
        causeId: r.cause_id,
        state: 'confirmed' as BlockerState,
        createdAt: r.created_at,
      }
    }),
  ]
  blockers.sort((a, b) => {
    const stateRank = (s: BlockerState): number =>
      s === 'confirmed' ? 0 : s === 'pending-review' ? 1 : 2
    const sa = stateRank(a.state)
    const sb = stateRank(b.state)
    if (sa !== sb) return sa - sb
    return a.createdAt - b.createdAt
  })
  return blockers
}

/**
 * Transition a task from `'draft'` to `'triaging'`. This is the entry-point
 * for the deterministic Linker path (PRD 2be831da): the dispatcher calls this
 * immediately after picking a draft task so the task is observable in the
 * transient `'triaging'` phase while the Linker runs keyword-overlap analysis
 * and may attach `'pending-review'` Blocker rows. Once the Linker completes,
 * {@link promoteDraftToQueued} (which accepts both `'draft'` and `'triaging'`)
 * advances the task to `'queued'` — gated on zero incomplete blockers.
 *
 * Returns the updated {@link Task} on success; `null` if the task does not
 * exist or is not currently in `'draft'` status.
 */
export const promoteDraftToTriaging = async (
  taskId: string,
): Promise<Task | null> => {
  // ADR-0052 sole-writer: the guarded 'draft' → 'triaging' status UPDATE now
  // lives inside the Arc aggregate; this export keeps the historic call surface
  // (the dispatcher, the triaging tests) green by delegating verbatim.
  return getArcWriter().promoteDraftToTriaging(taskId)
}

/**
 * Thin wrapper over {@link Arc.promoteDraftToQueued} (ADR-0052 sole-writer).
 * The guarded `'draft' | 'triaging' → 'queued'` status UPDATE + conditional
 * `task.queued` emit now live inside the Arc aggregate; this export keeps the
 * historic call surface (the `updateTask` done-cascade, the `TaskStore` facade,
 * and `triage-workflow.ts`) green by delegating verbatim.
 */
export const promoteDraftToQueued = async (
  taskId: string,
): Promise<Task | null> => {
  return getArcWriter().promoteDraftToQueued(taskId)
}
