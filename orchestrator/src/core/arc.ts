/**
 * Arc — the aggregate root for a task arc (ADR-0052).
 *
 * An *Arc* is the cluster of Actions (tasks) that share one `origin_id`: the
 * single origin task plus any recovery/fix/diagnose tasks spawned beneath it.
 * The Arc aggregate is the write funnel for arc-shaped mutations; this slice
 * (S1) introduces the skeleton and routes **origin creation** through
 * {@link Arc.createOrigin}. Later slices fold the remaining arc writes
 * (recovery spawn, drop, blockers) behind this same root.
 *
 * The class is constructed only via the static factories ({@link Arc.load},
 * {@link Arc.createOrigin}); the constructor is private. Every instance holds
 * an injected {@link DomainTaskStore} (the deep seam over `.mars/mars.db`) so
 * all persistence routes through the store rather than a raw libsql client.
 */

import { randomUUID } from 'node:crypto'
import { type InStatement } from '@libsql/client'
import {
  coerceToString,
  validatePriority,
  isTaskTag,
  isTaskType,
  TASK_TYPES,
  TASK_SEL,
  rowToTask,
  assertTaskKindInvariant,
  migrateQueueSchema,
  getTask,
  updateTask,
  resolveQueueClient,
  MAX_PRIORITY,
  type Task,
  type TaskPlan,
  type TaskStatus,
  type TaskKind,
  type TaskTag,
  type FollowUpKind,
  type EnqueueTaskOptions,
  type DropTaskResult,
} from './queue'
import {
  getDefaultTaskStore,
  getDefaultDomainTaskStore,
  type DomainTaskStore,
} from './store/task-store'
import { getRecipe, type FixRecipeContext } from './lib/fix-recipes'
import { buildEventInsert, publish, withWriteTx } from './lib/outbox'
import { assertNotRecoveryEdge } from './lib/blocker-invariant'
import {
  MAIN_COMMITER_RECIPE,
  SOURCE_ERROR_SUMMARY,
  VERIFY_MAIN_DIRTY_CODE,
  serialiseMainCommiterPayload,
  type MainCommiterPayload,
} from './lib/main-dirty'
import type { TraceEventStore } from './lib/trace-events-store'
import { internalBus } from '../internal-bus'
import { getRetryBudget, markTaskFailed } from './queue-retry'
import { computeFailureSignature } from './lib/failure-signature'
import {
  raiseActionQueueItem,
  supersedeActionQueueItemsForOrigin,
} from './lib/action-queue'
import {
  CANCELLED_CASCADE_ACTION_QUEUE_KIND,
  CANCELLED_CASCADE_FAILURE_REASON,
  PREREQUISITE_FAILED_ACTION_QUEUE_KIND,
  RETRY_BUDGET_FAILURE_REASON,
  WORKTREE_AHEAD_FAILURE_REASON,
  WorktreeAheadOfIntegrationError,
  integrationBranchName,
  raiseActionQueueForBlockedTask,
  raiseWorktreeAheadActionQueue,
  resetDependentWorktreeToIntegration,
  retryBudgetExhausted,
  type BlockByFailureOutcome,
  type BlockByFailureResult,
  type BlockedDependentRow,
  type PropagateRecoveryDoneResult,
  type RecoverAllBlockedTasksResult,
  type RecoverBlockedTaskOutcome,
  type UnblockByTaskResult,
  type UnblockOutcome,
} from './blocker-resolution'

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const FIX_TASK_AUTHOR_KIND = 'agent'
const FIX_TASK_AUTHOR_NAME = 'fail-fix-handler'

/**
 * Maps a {@link TaskStatus} to the outbox event that mirrors it, or `null` for
 * statuses that do not have a single matching outbox event (e.g. `'blocked'`,
 * `'running'`). Used by {@link Arc.setTaskStatus} to decide whether to publish.
 *
 * Relocated bit-for-bit from `queue.ts` (ADR-0052 sole-writer).
 */
const mapStatusToEvent = (
  status: TaskStatus,
): 'task.completed' | 'task.dropped' | 'task.failed' | 'task.queued' | null => {
  if (status === 'done') return 'task.completed'
  if (status === 'dropped') return 'task.dropped'
  if (status === 'failed') return 'task.failed'
  if (status === 'queued') return 'task.queued'
  return null
}

/**
 * Spawn-recovery input. Mirrors the historic `upsertFixTask(input)` parameter
 * shape so the queue-fix-tasks.ts wrapper can delegate without reshaping
 * arguments. Re-exported from queue-fix-tasks.ts for back-compat.
 */
export interface UpsertFixTaskInput {
  sourceTaskId: string
  failureSignature: string
  failingStep: string
  truncatedError: string
  branch: string | null
  /**
   * Recipe context handed to the recipe's `buildPrompt`. Required — the
   * generic prompt builder is gone (see ADR 0002). Callers that don't
   * have meaningful context can pass an empty `statusOutput`; the recipe
   * decides whether to use the rest of the fields.
   */
  recipeContext: FixRecipeContext
  /**
   * TaskStore threaded in from the workflow composition root. When
   * provided, all DB operations run through the store rather than
   * falling back to the module-singleton client.
   */
  store?: DomainTaskStore
}

export interface UpsertFixTaskResult {
  fixTaskId: string
  created: boolean
}

/**
 * Attach-to-existing-recovery input. Mirrors the historic
 * `attachToExistingFixTask(input)` parameter shape so the queue-fix-tasks.ts
 * wrapper can delegate without reshaping arguments. Re-exported from
 * queue-fix-tasks.ts for back-compat.
 */
export interface AttachToExistingFixTaskInput {
  sourceTaskId: string
  /** The recovery task to attach the source to. Must already exist as a kind='fix' row. */
  fixTaskId: string
  /** Catalog code recorded on the source's `failure_reason_code` column. */
  failureReasonCode: string | null
  /**
   * Loose-string archive of the failure for forensic continuity (mirrors
   * `tasks.failure_reason`). Kept in step with the catalog-driven code.
   */
  failureReason: string | null
  /** Short error summary written to `tasks.error` (truncated to 1000 chars). */
  errorSummary: string
  store?: DomainTaskStore
}

/**
 * Origin-creation spec for {@link Arc.createOrigin}. Mirrors the historic
 * `enqueueTask(prompt, plan?, opts?)` parameter shape so the queue.ts wrapper
 * can delegate without reshaping arguments.
 */
export interface CreateOriginSpec {
  prompt: string
  plan?: TaskPlan
  opts?: EnqueueTaskOptions
}

export class Arc {
  /**
   * Private — construct an Arc only via {@link Arc.load} or
   * {@link Arc.createOrigin}. Holds the injected store seam and the resolved
   * arc id (the origin task's id).
   */
  private constructor(
    private readonly store: DomainTaskStore,
    public readonly arcId: string,
  ) {}

  /**
   * Cheap factory: wrap an existing arc id for instance methods added by later
   * slices. Does no I/O and does not assert the arc exists — callers that need
   * existence guarantees should query through the store. The `store` defaults
   * to the process-wide default store (synchronous accessor; the migration is
   * driven on first domain call).
   */
  static load(arcId: string, store?: DomainTaskStore): Arc {
    return new Arc(store ?? getDefaultDomainTaskStore(), arcId)
  }

  /**
   * The origin-creation write funnel. Creates the single origin Action (task)
   * for a new arc and returns the persisted {@link Task}. All persistence
   * routes through the injected `store` seam (defaulting to the process-wide
   * default store).
   *
   * This is the canonical home of the origin `INSERT INTO tasks` (plus the
   * `task_spec_files` / `task_done_criteria` junction writes); `enqueueTask`
   * in queue.ts is a thin wrapper that delegates here.
   */
  static async createOrigin(
    spec: CreateOriginSpec,
    store?: DomainTaskStore,
  ): Promise<Task> {
    const resolvedStore = store ?? (await getDefaultTaskStore())
    const { prompt, plan, opts } = spec

    const promptText = coerceToString(prompt, 'enqueueTask: prompt')
    if (opts?.priority !== undefined) validatePriority(opts.priority)
    if (
      opts?.tags !== undefined &&
      (!Array.isArray(opts.tags) || opts.tags.some((t) => !isTaskTag(t)))
    ) {
      throw new Error(
        `tags must be an array of non-empty strings; got ${JSON.stringify(opts.tags)}`,
      )
    }
    await migrateQueueSchema()
    const id = `mars-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const status: TaskStatus = opts?.skipTriage ? 'queued' : 'draft'
    const authorKind = opts?.author?.kind ?? null
    const authorName = opts?.author?.name ?? null
    const originId = opts?.originId ?? id
    const priority = opts?.priority ?? 0
    const parentProposalId = opts?.parentProposalId ?? null
    const sliceIndex = opts?.sliceIndex ?? null
    const tags: TaskTag[] = opts?.tags ?? ['coder']
    const kind: TaskKind = opts?.kind ?? 'task'
    // createOrigin never sets fix_for_task_id (fix-tasks go through their own
    // recovery path), so the invariant collapses to: only 'task' and
    // 'diagnose' kinds are valid here.
    assertTaskKindInvariant(kind, null)
    if (kind === 'fix') {
      throw new Error(
        `enqueueTask cannot create kind='fix'; use the recovery fix-task path`,
      )
    }
    const taskSpec = opts?.spec ?? null
    if (taskSpec !== null && !isTaskType(taskSpec.taskType)) {
      throw new Error(
        `spec.taskType must be one of ${TASK_TYPES.join(', ')}; got '${String(taskSpec.taskType)}'`,
      )
    }
    const verifyCmd = taskSpec ? taskSpec.verifyCmd : null
    const taskType = taskSpec ? taskSpec.taskType : null
    const readFirstJson = taskSpec
      ? JSON.stringify(taskSpec.readFirst ?? [])
      : null
    const prescriptiveAction = taskSpec
      ? (taskSpec.prescriptiveAction ?? null)
      : null
    // sliceKindVal: 'coder' | 'hitl' routing hint from the slicer. Distinct from
    // the `kind` variable above (TaskKind: 'task' | 'fix' | 'diagnose').
    const sliceKindVal = taskSpec?.sliceKind ?? null
    const subDeliverableJson = taskSpec?.subDeliverable
      ? JSON.stringify(taskSpec.subDeliverable)
      : null
    const tagsJson = JSON.stringify(tags)
    await resolvedStore.execute({
      sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, author_kind, author_name, origin_id, priority, parent_proposal_id, slice_index, tags_json, kind, verify_cmd, task_type, read_first_json, prescriptive_action, slice_kind, sub_deliverable_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        promptText,
        status,
        plan?.functional ?? null,
        plan?.technical ?? null,
        authorKind,
        authorName,
        originId,
        priority,
        parentProposalId,
        sliceIndex,
        tagsJson,
        kind,
        verifyCmd,
        taskType,
        readFirstJson,
        prescriptiveAction,
        sliceKindVal,
        subDeliverableJson,
        now,
        now,
      ],
    })
    // Write spec.files to task_spec_files junction table.
    if (taskSpec?.files && taskSpec.files.length > 0) {
      for (let i = 0; i < taskSpec.files.length; i++) {
        await resolvedStore.execute({
          sql: `INSERT OR IGNORE INTO task_spec_files (task_id, path, position) VALUES (?, ?, ?)`,
          args: [id, taskSpec.files[i], i],
        })
      }
    }
    // Write spec.doneCriteria to task_done_criteria junction table.
    if (taskSpec?.doneCriteria && taskSpec.doneCriteria.length > 0) {
      for (let i = 0; i < taskSpec.doneCriteria.length; i++) {
        await resolvedStore.execute({
          sql: `INSERT OR IGNORE INTO task_done_criteria (task_id, criterion, position) VALUES (?, ?, ?)`,
          args: [id, taskSpec.doneCriteria[i], i],
        })
      }
    }
    const r = await resolvedStore.execute({
      sql: `${TASK_SEL} WHERE t.id = ?`,
      args: [id],
    })
    return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
  }

  /**
   * The Arc-owned status-write primitive (ADR-0052 sole-writer). Builds the
   * canonical raw `UPDATE tasks SET ${fields} WHERE id = ?` statement and runs
   * the lifecycle row-change + paired outbox event INSERTs in a single atomic
   * commit. This is the *only* place the status-bearing `UPDATE tasks SET …`
   * string lives — {@link updateTask} (and, in later slices,
   * {@link Arc.setTaskStatus}) build the column patch (`fields`/`args`),
   * Zod-validated event payloads (`eventStmts`), the terminal-immutability
   * pre-check, and the `isStatusChange` decision, then hand the finished pieces
   * here for the SQL + commit. The caller's `args` array already carries the
   * trailing `WHERE id = ?` bind value (the patch builder pushes `id` last), so
   * this method does not append it.
   *
   * The three-branch dispatch is preserved bit-for-bit from the historic
   * `updateTask` body:
   *   - `appendSessionId` → `withWriteTx` wrapping the row UPDATE, the
   *     `task_claude_sessions` INSERT (`sessionIdStmt`), and every event INSERT
   *     in one write transaction;
   *   - `store` provided → `store.batch([updateStmt, ...eventStmts], 'write')`
   *     so the row change and event inserts share one commit;
   *   - else → `withWriteTx(resolveQueueClient())` wrapping the row UPDATE and
   *     the event INSERTs (retries on `SQLITE_BUSY`).
   */
  static async applyStatusWrite(input: {
    id: string
    fields: string[]
    args: unknown[]
    eventStmts: InStatement[]
    store?: DomainTaskStore
    appendSessionId?: boolean
    sessionIdStmt?: InStatement
  }): Promise<void> {
    const updateStmt: InStatement = {
      sql: `UPDATE tasks SET ${input.fields.join(', ')} WHERE id = ?`,
      args: input.args as never,
    }

    if (input.appendSessionId) {
      // Atomically (a) apply the field updates, (b) insert the new session id
      // into task_claude_sessions (OR IGNORE deduplicates), and (c) insert the
      // outbox event row.  All three writes share one write transaction so a
      // crash between any two leaves the DB consistent (either everything
      // committed or nothing).
      const sessionIdStmt = input.sessionIdStmt as InStatement
      await withWriteTx(resolveQueueClient(), async (tx) => {
        await tx.execute(updateStmt)
        await tx.execute(sessionIdStmt)
        // Event INSERTs share the same transaction: if any throws the whole
        // transaction rolls back (no orphan state row without event).
        for (const stmt of input.eventStmts) await tx.execute(stmt)
      })
    } else if (input.store) {
      // store.batch runs all statements atomically (BEGIN IMMEDIATE … COMMIT)
      // so the state write and event inserts are in the same commit.
      await input.store.batch([updateStmt, ...input.eventStmts], 'write')
    } else {
      // Common path: wrap state write and event inserts in a single write
      // transaction.  withWriteTx retries on SQLITE_BUSY so a transient lock
      // contention doesn't drop the event.
      await withWriteTx(resolveQueueClient(), async (tx) => {
        await tx.execute(updateStmt)
        for (const stmt of input.eventStmts) await tx.execute(stmt)
      })
    }
  }

  /**
   * Guarded `'draft' | 'triaging' → 'queued'` promote (ADR-0052 sole-writer).
   *
   * Relocated bit-for-bit from `queue.ts:promoteDraftToQueued`. The status
   * `UPDATE` carries a `NOT EXISTS` conditional WHERE (gate on zero
   * confirmed-or-pending-review incomplete blockers) that cannot be expressed
   * through the column-patch {@link Arc.applyStatusWrite} funnel, so it lives
   * as its own primitive here.
   *
   * PRD 2be831da: `'queued'` requires zero confirmed-or-pending-review rows;
   * rejected rows are historical and must not gate the promote. The guarded
   * UPDATE + the `task.queued` emit share one transaction; the event is
   * appended only when the row actually flipped (`rowsAffected > 0`), so a
   * no-op promote emits nothing. Emitting `task.queued` lets the Invalidator
   * evict any stale failure row for a task that is live again (ADR-0030).
   *
   * Store routing: when `store` is provided the guarded UPDATE + conditional
   * emit run inside `store.atomic` (same commit); otherwise the body is the
   * historic `withWriteTx(resolveQueueClient(), …)` form preserved bit-for-bit.
   *
   * Returns the updated {@link Task} on success; `null` if the row did not
   * flip (already past `'draft'/'triaging'`, missing, or gated by a blocker).
   */
  static async promoteDraftToQueued(
    taskId: string,
    store?: DomainTaskStore,
  ): Promise<Task | null> {
    await migrateQueueSchema()
    const now = new Date().toISOString()
    if (store) {
      const upd = await store.atomic(async (scope) => {
        const res = await scope.execute({
          // updated_at first — exempt from STATUS_WRITE arch guard (conditional
          // NOT EXISTS guard cannot be expressed through setTaskStatus).
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ?
                   AND status IN ('draft', 'triaging')
                   AND NOT EXISTS (
                     SELECT 1 FROM task_blockers b
                     JOIN tasks t ON t.id = b.blocker_task_id
                     WHERE b.task_id = ? AND t.status != 'done'
                       AND b.state IN ('confirmed', 'pending-review')
                   )`,
          args: [now, taskId, taskId],
        })
        if ((res.rowsAffected ?? 0) > 0) {
          await scope.execute(buildEventInsert('task.queued', { taskId }))
        }
        return res
      })
      if ((upd.rowsAffected ?? 0) === 0) return null
      const r = await store.query({
        sql: `SELECT * FROM tasks WHERE id = ?`,
        args: [taskId],
      })
      if (r.rows.length === 0) return null
      return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
    }
    // PRD 2be831da: 'queued' requires zero confirmed-or-pending-review rows;
    // rejected rows are historical and must not gate the promote.
    // The guarded UPDATE + the task.queued emit share one transaction; the
    // event is appended only when the row actually flipped (rowsAffected > 0),
    // so a no-op promote emits nothing. Emitting task.queued lets the
    // Invalidator evict any stale failure row for a task that is live again
    // (ADR-0030).
    const upd = await withWriteTx(resolveQueueClient(), async (tx) => {
      const res = await tx.execute({
        // updated_at first — exempt from STATUS_WRITE arch guard (conditional
        // NOT EXISTS guard cannot be expressed through setTaskStatus).
        sql: `UPDATE tasks
                 SET updated_at = ?, status = 'queued'
               WHERE id = ?
                 AND status IN ('draft', 'triaging')
                 AND NOT EXISTS (
                   SELECT 1 FROM task_blockers b
                   JOIN tasks t ON t.id = b.blocker_task_id
                   WHERE b.task_id = ? AND t.status != 'done'
                     AND b.state IN ('confirmed', 'pending-review')
                 )`,
        args: [now, taskId, taskId],
      })
      if (res.rowsAffected > 0) {
        await tx.execute(buildEventInsert('task.queued', { taskId }))
      }
      return res
    })
    if (upd.rowsAffected === 0) return null
    const r = await resolveQueueClient().execute({
      sql: `SELECT * FROM tasks WHERE id = ?`,
      args: [taskId],
    })
    if (r.rows.length === 0) return null
    return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
  }

  /**
   * Atomic single-writer chokepoint for task status changes (ADR-0052).
   *
   * Relocated bit-for-bit from `queue.ts:setTaskStatus`. Wraps the raw
   * `UPDATE tasks SET status` and the matching outbox event in one commit so
   * the event id is allocated in the same SQLite transaction as the row change
   * (ADR-0030 same-commit guarantee). Callers that need additional column
   * updates (e.g. `drop_reason`, `failure_reason`) or additional events (e.g.
   * `task.terminal`) must issue those in a separate transaction **after**
   * calling this method (see `Arc.propagateRecoveryDone` / the
   * blocker-resolution `error = NULL` + `task.terminal` two-tx structure).
   *
   * Statuses without a registered event mapping (`'blocked'`, `'running'`,
   * etc.) are still written to the row — the method just skips the publish
   * step (see {@link mapStatusToEvent}).
   *
   * PARITY (preserved from the historic `setTaskStatus`):
   *   - **publish-only asymmetry**: `extras.error` rides the `task.failed`
   *     event payload but is NOT written to the `error` column here. A caller
   *     that needs the column persisted must do so in a follow-up write.
   *   - **no terminal-immutability guard**: this method does NOT reject a
   *     write onto an already-terminal row. The sole guard is the caller-side
   *     pre-check ({@link Arc.propagateRecoveryDone} returns early when the
   *     origin is already `done`/`failed`/`dropped`). Keep that defense at the
   *     call site.
   *
   * Store routing (ADR-0021 / ADR-0030): when `store` is provided the row
   * UPDATE + event INSERT run via `store.batch([updateStmt, ...eventStmts],
   * 'write')` (one BEGIN IMMEDIATE … COMMIT); otherwise the body is the
   * historic `withWriteTx(resolveQueueClient(), …)` form preserved bit-for-bit
   * (retries on SQLITE_BUSY).
   */
  static async setTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    extras?: { error?: string; result?: unknown; dropReason?: string },
    store?: DomainTaskStore,
  ): Promise<void> {
    const now = new Date().toISOString()
    const eventType = mapStatusToEvent(newStatus)
    if (store) {
      const updateStmt: InStatement = {
        sql: 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
        args: [newStatus, now, taskId],
      }
      // No event mapping (e.g. 'blocked', 'running') → row write only, no emit.
      if (eventType === null) {
        await store.batch([updateStmt], 'write')
        return
      }
      // Build the matching event payload exactly as the historic publish()
      // branches did; buildEventInsert validates the payload against the same
      // Zod schema publish() uses, so the rows are bit-for-bit identical.
      let eventStmt: InStatement
      if (newStatus === 'done') {
        eventStmt = buildEventInsert('task.completed', {
          taskId,
          result: extras?.result ?? null,
        })
      } else if (newStatus === 'dropped') {
        eventStmt = buildEventInsert('task.dropped', {
          taskId,
          dropReason: extras?.dropReason ?? '',
        })
      } else if (newStatus === 'failed') {
        eventStmt = buildEventInsert('task.failed', {
          taskId,
          error: extras?.error ?? '',
        })
      } else {
        eventStmt = buildEventInsert('task.queued', { taskId })
      }
      // Row change + event INSERT share one commit (ADR-0030).
      await store.batch([updateStmt, eventStmt], 'write')
      return
    }
    await withWriteTx(resolveQueueClient(), async (tx) => {
      await tx.execute({
        sql: 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
        args: [newStatus, now, taskId],
      })
      if (eventType === null) return
      if (newStatus === 'done') {
        await publish(tx, 'task.completed', { taskId, result: extras?.result ?? null })
      } else if (newStatus === 'dropped') {
        await publish(tx, 'task.dropped', { taskId, dropReason: extras?.dropReason ?? '' })
      } else if (newStatus === 'failed') {
        await publish(tx, 'task.failed', { taskId, error: extras?.error ?? '' })
      } else if (newStatus === 'queued') {
        await publish(tx, 'task.queued', { taskId })
      }
    })
  }

  /**
   * The single status-transition funnel (ADR-0052). Routes every task status
   * change through {@link updateTask} — the transition primitive that survives
   * *inside* the aggregate. `updateTask` performs the `UPDATE tasks SET status`
   * + matching outbox event (and the `task.terminal` pair for terminal
   * statuses) in one atomic write, guarding terminal immutability via
   * {@link IllegalTransitionError}.
   *
   * `extras` mirrors the historic `setTaskStatus` extras shape so callers that
   * carried an `error`/`dropReason` payload map cleanly onto `updateTask`'s
   * patch columns:
   *   - `error`     → `patch.error`     (rides the `task.failed` payload),
   *   - `dropReason`→ `patch.failureReason` (rides the `task.dropped` payload).
   * `result` is accepted for shape-compatibility but is not a persisted column;
   * `updateTask` emits `task.completed` with `result: null` (unchanged).
   */
  async transition(
    taskId: string,
    to: TaskStatus,
    extras?: { error?: string; result?: unknown; dropReason?: string },
  ): Promise<void> {
    await updateTask(taskId, {
      status: to,
      ...(extras?.error !== undefined ? { error: extras.error } : {}),
      ...(extras?.dropReason !== undefined
        ? { failureReason: extras.dropReason }
        : {}),
    })
  }

  /**
   * Continuation (follow-up) write funnel (ADR-0052). Enqueues a follow-up task
   * for `originTaskId` exactly ONCE, across restarts.
   *
   * Deduplicates via the dedicated `followup_dedup_key` column (value:
   * `followup:<originTaskId>:<kind>`): if an open (non-terminal) follow-up for
   * this origin+kind combination already exists, the enqueue is skipped and the
   * existing task id is returned with `created: false`.
   *
   * Arc membership (ADR-0050): the follow-up's `origin_id` is set to the
   * RESOLVED `origin_id` of `originTaskId` (i.e. the arc root), not to a
   * synthetic dedup string, so the follow-up is reachable from the same arc as
   * the task it continues. Creation routes through {@link Arc.createOrigin}
   * (via the queue wrapper) and the blocker edge through {@link Arc.addBlocker}.
   */
  async addContinuation(
    originTaskId: string,
    kind: FollowUpKind,
    prompt: string,
  ): Promise<{ id: string; created: boolean }> {
    const dedupKey = `followup:${originTaskId}:${kind}`
    await migrateQueueSchema()
    const s = this.store
    // Dedup: if an open (non-terminal) follow-up with this dedup key exists,
    // reuse it.
    const existing = await s.execute({
      sql: `SELECT id FROM tasks WHERE followup_dedup_key = ? AND status NOT IN ('done', 'failed', 'dropped') LIMIT 1`,
      args: [dedupKey],
    })
    if (existing.rows.length > 0) {
      const id = (existing.rows[0] as unknown as { id: string }).id
      return { id, created: false }
    }
    // Inherit the arc: resolve the origin task's actual origin_id so the
    // follow-up joins the same arc as the task it continues (ADR-0050).
    const originRow = await s.execute({
      sql: `SELECT origin_id, id FROM tasks WHERE id = ?`,
      args: [originTaskId],
    })
    const resolvedOriginId =
      originRow.rows.length > 0
        ? ((
            originRow.rows[0] as unknown as {
              origin_id: string | null
              id: string
            }
          ).origin_id ?? originTaskId)
        : originTaskId
    const followUp = await Arc.createOrigin(
      {
        prompt,
        opts: { skipTriage: true, originId: resolvedOriginId },
      },
      s,
    )
    // Stamp the dedup key onto the newly created follow-up row.
    await s.execute({
      sql: `UPDATE tasks SET followup_dedup_key = ? WHERE id = ?`,
      args: [dedupKey, followUp.id],
    })
    await this.addBlocker(followUp.id, [originTaskId])
    return { id: followUp.id, created: true }
  }

  /**
   * Reflection-task insert (ADR-0052). Writes a single self-arc reflection row
   * (`origin_id = self`, status `'done'`) capturing a `mars reflect` run over
   * `corpusSize` task(s). Returns the new task id. Routed through the Arc
   * aggregate so the reflect arc is created by the same write funnel as every
   * other origin; the `origin_id = self` semantics are preserved.
   */
  async insertReflection(corpusSize: number): Promise<string> {
    await migrateQueueSchema()
    const id = `reflect-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const prompt = `mars reflect run over ${corpusSize} task(s) at ${now}`
    await this.store.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)`,
      args: [id, prompt, id, now, now],
    })
    return id
  }

  /**
   * Locate an existing outstanding fix-task for a (sourceTaskId,
   * failureSignature) pair. Non-shared recipes dedup per source.
   */
  private async findExistingFixTask(
    sourceTaskId: string,
    failureSignature: string,
  ): Promise<string | null> {
    const r = await this.store.query({
      sql: `SELECT id FROM tasks
             WHERE fix_for_task_id = ?
               AND failure_signature = ?
               AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
             ORDER BY created_at DESC
             LIMIT 1`,
      args: [sourceTaskId, failureSignature],
    })
    if (r.rows.length === 0) return null
    return (r.rows[0] as unknown as { id: string }).id
  }

  /**
   * For shared recipes: locate ANY outstanding fix-task for this signature,
   * regardless of which source task spawned it. New blocked sources attach
   * to it via a `task_blockers` edge instead of spawning a duplicate.
   */
  private async findSharedFixTask(
    failureSignature: string,
  ): Promise<string | null> {
    const r = await this.store.query({
      sql: `SELECT id FROM tasks
             WHERE failure_signature = ?
               AND fix_for_task_id IS NOT NULL
               AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
             ORDER BY created_at DESC
             LIMIT 1`,
      args: [failureSignature],
    })
    if (r.rows.length === 0) return null
    return (r.rows[0] as unknown as { id: string }).id
  }

  /**
   * Recovery-spawn write funnel (ADR-0052). Atomically:
   *  - INSERT a new runnable fix-task row (status='queued', skip triage),
   *  - INSERT a task_blockers row linking the source task to the fix task,
   *  - UPDATE the source task to status='blocked' with retry_count incremented,
   *  - append a `self_heal_attempts` ledger row,
   *  - emit a durable `task.blocked` event in the same batch.
   *
   * Idempotent on (sourceTaskId, failureSignature): if a fix task is already
   * outstanding for that pair, the existing task is reused.
   *
   * Caller must guarantee a recipe exists for `input.failureSignature` —
   * `getRecipe` throws if it doesn't. Use `hasRecipe(signature)` before
   * calling.
   *
   * F.1 EXEMPTION (ADR-0040). The by-construction origin → fix
   * `task_blockers` edge is written DIRECTLY in the batch below and MUST NOT
   * be routed through `addBlockers`/`assertNotRecoveryEdge`. `spawnRecovery`
   * is the documented canonical origin → recovery edge writer — the one
   * legitimate bypass of F.1's ADR-0040 leaf-node guard (every other
   * `task_blockers` writer goes through `assertNotRecoveryEdge`). The edge
   * here is the canonical attach mechanism; the guard does not apply.
   */
  async spawnRecovery(input: UpsertFixTaskInput): Promise<UpsertFixTaskResult> {
    const s = this.store

    const recipe = getRecipe(input.failureSignature)
    const shared = recipe.shared === true

    // Shared recipes (e.g. dirty merge target) reuse a single in-flight
    // fix-task across every source task that hits the signature. New
    // sources just attach a task_blockers edge — one commit unblocks
    // every dependent at once via Arc.unblockByCompletion.
    const existingId = shared
      ? await this.findSharedFixTask(input.failureSignature)
      : await this.findExistingFixTask(
          input.sourceTaskId,
          input.failureSignature,
        )

    const source = await getTask(input.sourceTaskId, s)
    if (!source) {
      throw new Error(`source task ${input.sourceTaskId} not found`)
    }
    const nextRetryCount = source.retryCount + 1
    const errorSummary = truncate(
      `${input.failingStep}: ${input.truncatedError}`,
      1000,
    )
    const now = new Date().toISOString()

    if (existingId) {
      // Attach this source to the existing fix-task and park it.
      await s.batch(
        [
          {
            sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
                VALUES (?, ?, ?)`,
            args: [input.sourceTaskId, existingId, now],
          },
          {
            // updated_at first — exempt from STATUS_WRITE arch guard. Events are
            // emitted atomically in this same batch per ADR-0030.
            sql: `UPDATE tasks
                   SET updated_at = ?,
                       status = 'blocked',
                       retry_count = ?,
                       error = ?
                 WHERE id = ?`,
            args: [now, nextRetryCount, errorSummary, input.sourceTaskId],
          },
          // Durable task.blocked in the same atomic batch (ADR-0030); the
          // internalBus().emit below stays only as an in-process wake-hint.
          buildEventInsert('task.blocked', {
            taskId: input.sourceTaskId,
            fixTaskId: existingId,
            failureSignature: input.failureSignature,
            failingStep: input.failingStep,
            originId: source.originId,
          }),
        ],
        'write',
      )
      internalBus().emit('task.blocked', {
        taskId: input.sourceTaskId,
        fixTaskId: existingId,
        failureSignature: input.failureSignature,
        failingStep: input.failingStep,
        originId: source.originId,
      })
      return { fixTaskId: existingId, created: false }
    }

    // Inline the source task's prompt so recipes that re-do the original
    // work (e.g. verify:has-diff/no-commits-ahead) don't burn turns
    // re-fetching it from .mars/queue.db. Handlers should already set
    // `originalPrompt`; backfill from the source row if a direct caller
    // forgot. Default to '' only when the source genuinely has no prompt.
    const incomingPrompt = input.recipeContext.originalPrompt
    const recipeContextWithSource: FixRecipeContext = {
      ...input.recipeContext,
      originalPrompt:
        incomingPrompt && incomingPrompt.trim().length > 0
          ? incomingPrompt
          : source.prompt ?? '',
    }
    const prompt = recipe.buildPrompt(recipeContextWithSource)
    const fixTaskId = randomUUID().slice(0, 8)
    // Shared remediations run at top priority — every other queued task is
    // waiting on this one resource (e.g. a clean main). Non-shared fix-tasks
    // stay at default priority; they only unblock the single source.
    const fixPriority = shared ? MAX_PRIORITY : 0

    await s.batch(
      [
        {
          // ADR-0049: kind='fix' is written by construction so the row is never
          // an orphan from birth. assertTaskKindInvariant enforces this same
          // constraint at the enqueueTask path; spawnRecovery mirrors it here.
          sql: `INSERT INTO tasks (
                id, prompt, status,
                author_kind, author_name,
                fix_for_task_id, failure_signature,
                kind,
                retry_count, origin_id, priority,
                created_at, updated_at
              ) VALUES (?, ?, 'queued', ?, ?, ?, ?, 'fix', 0, ?, ?, ?, ?)`,
          args: [
            fixTaskId,
            prompt,
            FIX_TASK_AUTHOR_KIND,
            FIX_TASK_AUTHOR_NAME,
            input.sourceTaskId,
            input.failureSignature,
            source.originId,
            fixPriority,
            now,
            now,
          ],
        },
        {
          // F.1 exemption (ADR-0040): the origin → fix edge is written
          // DIRECTLY here, not through addBlockers/assertNotRecoveryEdge.
          // `spawnRecovery` is the one legitimate origin → recovery edge
          // writer; see the method-level note above.
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
              VALUES (?, ?, ?)`,
          args: [input.sourceTaskId, fixTaskId, now],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                 SET updated_at = ?,
                     status = 'blocked',
                     retry_count = ?,
                     error = ?
               WHERE id = ?`,
          args: [now, nextRetryCount, errorSummary, input.sourceTaskId],
        },
        // Append-only ledger row for the sweeper's per-(parent,signature)
        // dedup + budget logic. Lives inside the same batch as the
        // fix-task INSERT so a rollback leaves no stray attempt row.
        {
          sql: `INSERT INTO self_heal_attempts (
                parent_task_id, failure_signature, fix_task_id, created_at
              ) VALUES (?, ?, ?, ?)`,
          args: [input.sourceTaskId, input.failureSignature, fixTaskId, now],
        },
        // Durable task.blocked in the same atomic batch (ADR-0030).
        buildEventInsert('task.blocked', {
          taskId: input.sourceTaskId,
          fixTaskId,
          failureSignature: input.failureSignature,
          failingStep: input.failingStep,
          originId: source.originId,
        }),
      ],
      'write',
    )

    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId,
      failureSignature: input.failureSignature,
      failingStep: input.failingStep,
      originId: source.originId,
    })

    return { fixTaskId, created: true }
  }

  /**
   * Slice F.2: attach a new blocked source to an EXISTING recovery (fix) task
   * without spawning a fresh recovery row.
   *
   * Background. `spawnRecovery` is the canonical origin → recovery edge writer
   * and is the documented exemption from F.1's ADR-0040 leaf-node guard (every
   * other `task_blockers` writer goes through `assertNotRecoveryEdge`). When
   * dirty-main dedup determines that a queued / in-flight / failed
   * `main-commiter` already exists for the current diff hash, we still need
   * a `task_blockers` edge (origin → existing recovery) — but we MUST NOT
   * re-create the recovery row. A normal `addBlockers` call would trip
   * F.1's guard because the blocker endpoint is a recovery task; this helper
   * bypasses the guard by writing the edge through the same chokepoint the
   * spawn path uses, then re-parks the source.
   *
   * The combined fields written are exactly the post-spawn shape of
   * `spawnRecovery` minus the fix-task INSERT (and minus the
   * `self_heal_attempts` ledger row, since the cap counts attempt-by-row and
   * we are not adding a new attempt — we are joining an existing one).
   *
   * No-op when the source is already blocked on this exact recovery
   * (`INSERT OR IGNORE` on the edge).
   */
  async attachToRecovery(input: AttachToExistingFixTaskInput): Promise<void> {
    const s = this.store
    const source = await getTask(input.sourceTaskId, s)
    if (!source) {
      throw new Error(`source task ${input.sourceTaskId} not found`)
    }
    const now = new Date().toISOString()
    const truncatedError = truncate(input.errorSummary, 1000)
    await s.batch(
      [
        {
          // F.1 exemption: this insert reaches `task_blockers` directly because
          // the legitimate origin → recovery edge writer (`spawnRecovery`) is
          // the documented bypass of the ADR-0040 guard, and this helper is its
          // dedup sibling. See ADR-0040 clarification: the origin → recovery
          // edge is the canonical attach mechanism.
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at)
                VALUES (?, ?, 'confirmed', ?)`,
          args: [input.sourceTaskId, input.fixTaskId, now],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                   SET updated_at = ?,
                       status = 'blocked',
                       error = ?,
                       failure_reason = COALESCE(?, failure_reason),
                       failure_reason_code = COALESCE(?, failure_reason_code)
                 WHERE id = ?`,
          args: [
            now,
            truncatedError,
            input.failureReason,
            input.failureReasonCode,
            input.sourceTaskId,
          ],
        },
        // Durable task.blocked in the same atomic batch (ADR-0030).
        buildEventInsert('task.blocked', {
          taskId: input.sourceTaskId,
          fixTaskId: input.fixTaskId,
          failureSignature: input.failureReasonCode ?? 'verify:main-dirty',
          failingStep: 'dispatch:main-dirty',
          originId: source.originId,
        }),
      ],
      'write',
    )
    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId: input.fixTaskId,
      failureSignature: input.failureReasonCode ?? 'verify:main-dirty',
      failingStep: 'dispatch:main-dirty',
      originId: source.originId,
    })
  }

  /**
   * Fresh `main-commiter` recovery spawn (ADR-0052 sole-writer). Relocated
   * bit-for-bit from `main-dirty.ts:spawnFresh`. When dirty-main detection finds
   * no active committer at the current hash, this inserts a brand-new recovery
   * (fix) task, parks the source behind it, and records the dirty-main payload.
   *
   * The four batched statements run in one atomic `s.batch([...], 'write')`
   * commit (ADR-0030):
   *   1. INSERT the `kind='fix'` committer row (priority 3,
   *      author='main-commiter-spawn', `recovery_payload` = the serialised
   *      {@link MainCommiterPayload});
   *   2. INSERT OR IGNORE the origin → recovery `task_blockers` edge
   *      (`state='confirmed'`) — the F.1 ADR-0040 leaf-node exemption mirror;
   *   3. UPDATE the source to `status='blocked'`, overwriting
   *      `error`/`failure_reason`/`failure_reason_code = VERIFY_MAIN_DIRTY_CODE`
   *      (updated_at first — exempt from the STATUS_WRITE arch guard);
   *   4. the durable `task.blocked` outbox event.
   *
   * PARITY (preserved bit-for-bit):
   *   - a single `now` timestamp threaded through every statement;
   *   - a fresh `randomUUID().slice(0, 8)` fix-task id per call;
   *   - `recovery_payload` IS written (unlike {@link Arc.spawnRecovery}, which
   *     leaves it NULL — the two writers coexist);
   *   - NO `self_heal_attempts` ledger append (intentional, slice F.2 — the
   *     hash-based dedup, not the per-(parent,signature) cap, owns committer
   *     identity);
   *   - the `recovery_spawned` trace emit and the `internalBus().emit` stay
   *     OUTSIDE the batch (best-effort wake hints).
   *
   * F.1 EXEMPTION (ADR-0040): the origin → recovery `task_blockers` edge is
   * written DIRECTLY in the batch, NOT through `addBlocker`/`assertNotRecoveryEdge`
   * — this is the canonical origin → recovery edge writer, the same documented
   * bypass that {@link Arc.spawnRecovery} carries.
   */
  async spawnMainCommitterRecovery(input: {
    sourceTaskId: string
    dirtyMainHash: string | null
    integrationBranch: string
    dispatchPhase: 'dispatch' | 'verify'
    recipePrompt: string
    sourceOriginId: string
    traceStore: TraceEventStore
  }): Promise<{ fixTaskId: string }> {
    const s = this.store
    const fixTaskId = randomUUID().slice(0, 8)
    const now = new Date().toISOString()
    const payload: MainCommiterPayload = {
      recipe: MAIN_COMMITER_RECIPE,
      // Empty string when hash compute failed — keeps the payload shape stable
      // and signals "no dedup possible" to anyone reading.
      dirtyMainHash: input.dirtyMainHash ?? '',
      integrationBranch: input.integrationBranch,
    }
    await s.batch(
      [
        {
          sql: `INSERT INTO tasks (
                id, prompt, status, kind,
                author_kind, author_name,
                fix_for_task_id, failure_signature,
                failure_reason, failure_reason_code,
                retry_count, origin_id, priority,
                recovery_payload,
                created_at, updated_at
              ) VALUES (?, ?, 'queued', 'fix', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          args: [
            fixTaskId,
            input.recipePrompt,
            'agent',
            'main-commiter-spawn',
            input.sourceTaskId,
            VERIFY_MAIN_DIRTY_CODE,
            VERIFY_MAIN_DIRTY_CODE,
            VERIFY_MAIN_DIRTY_CODE,
            input.sourceOriginId,
            // Max priority: every queued task is blocked behind this.
            3,
            serialiseMainCommiterPayload(payload),
            now,
            now,
          ],
        },
        {
          // F.1 exemption: this is the canonical origin → recovery edge
          // mirror of `upsertFixTask`. The recovery side cannot grow further
          // edges (recovery-of-recovery is rejected by
          // `handleTaskFailureWithFixTask`), so the leaf invariant holds.
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at)
              VALUES (?, ?, 'confirmed', ?)`,
          args: [input.sourceTaskId, fixTaskId, now],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                 SET updated_at = ?,
                     status = 'blocked',
                     error = ?,
                     failure_reason = ?,
                     failure_reason_code = ?
               WHERE id = ?`,
          args: [
            now,
            SOURCE_ERROR_SUMMARY(input.integrationBranch, input.dispatchPhase),
            VERIFY_MAIN_DIRTY_CODE,
            VERIFY_MAIN_DIRTY_CODE,
            input.sourceTaskId,
          ],
        },
        // Durable task.blocked in the same atomic batch (ADR-0030); the
        // internalBus().emit below stays only as an in-process wake-hint.
        buildEventInsert('task.blocked', {
          taskId: input.sourceTaskId,
          fixTaskId,
          failureSignature: VERIFY_MAIN_DIRTY_CODE,
          failingStep: `${input.dispatchPhase}:main-dirty`,
          originId: input.sourceOriginId,
        }),
      ],
      'write',
    )

    // Emit the canonical recovery_spawned trace event (kind already in the
    // vocabulary since slice B) so the trace surface reflects the new
    // recovery exactly like every other recipe-driven spawn.
    await input.traceStore
      .record({
        kind: 'recovery_spawned',
        taskId: fixTaskId,
        originId: input.sourceOriginId,
        phase: input.dispatchPhase === 'verify' ? 'verify' : 'setup',
        payload: {
          recipe: MAIN_COMMITER_RECIPE,
          sourceTaskId: input.sourceTaskId,
          dirtyMainHash: input.dirtyMainHash,
          integrationBranch: input.integrationBranch,
          dispatchPhase: input.dispatchPhase,
        },
      })
      .catch(() => {
        // Trace emission is best-effort; never fail a recovery spawn on it.
      })

    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId,
      failureSignature: VERIFY_MAIN_DIRTY_CODE,
      failingStep: `${input.dispatchPhase}:main-dirty`,
      originId: input.sourceOriginId,
    })

    return { fixTaskId }
  }

  /**
   * Add user-facing blocker edges (ADR-0052). Routes the historic
   * `addBlockers` body through the Arc aggregate: existence-check the dependent
   * task and every blocker id, dedupe (drop self-blocks and repeats), run the
   * ADR-0040 leaf-node guard ({@link assertNotRecoveryEdge}) on both endpoints
   * of every surviving edge, then batch-insert `state='confirmed'` rows.
   *
   * The recovery-spawn path (`spawnRecovery`/`attachToRecovery`) is the one
   * legitimate origin → fix edge writer and bypasses this method by reaching
   * `task_blockers` directly — the guard does not apply there (ADR-0040).
   */
  async addBlocker(
    taskId: string,
    blockerIds: readonly string[],
  ): Promise<void> {
    if (blockerIds.length === 0) return
    await migrateQueueSchema()
    const s = this.store

    const taskRow = await s.execute({
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
      const r = await s.execute({
        sql: `SELECT 1 FROM tasks WHERE id = ?`,
        args: [id],
      })
      if (r.rows.length === 0) {
        throw new Error(`blocker ${id} not found`)
      }
      unique.push(id)
    }

    if (unique.length === 0) return
    // ADR-0040 leaf-node guard: recovery (fix) tasks cannot be either endpoint
    // of a task_blockers edge. Probe both sides before the batch — the fix-task
    // spawn path (`spawnRecovery`) is the one legitimate origin → fix writer
    // and bypasses this entry point by reaching `task_blockers` directly.
    for (const blockerId of unique) {
      await assertNotRecoveryEdge(taskId, blockerId, { client: s })
    }
    const now = new Date().toISOString()
    // Causal writers default to 'confirmed' state. The Linker writes
    // 'pending-review' rows via a separate entry point.
    const stmts = unique.map((blockerId) => ({
      sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
      args: [taskId, blockerId, now],
    }))
    await s.batch(stmts, 'write')
  }

  /**
   * Remove a single blocker edge (ADR-0052). Routes the historic
   * `removeBlocker` body through the Arc aggregate; status is unchanged.
   * Reports `{ removed: true }` when a row was deleted, `false` otherwise.
   */
  async removeBlocker(
    taskId: string,
    blockerId: string,
  ): Promise<{ removed: boolean }> {
    await migrateQueueSchema()
    const r = await this.store.execute({
      sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [taskId, blockerId],
    })
    return { removed: r.rowsAffected > 0 }
  }

  /**
   * Database-level drop of the arc's task (ADR-0052). Works regardless of
   * status — clears every `task_blockers` row mentioning the id on either side,
   * cascade-deletes every fix/recovery task whose `fix_for_task_id` points at
   * the id (ADR-0049), and deletes the task row. Caller is responsible for
   * cancelling any in-flight workflow and removing the worktree+branch on disk
   * before invoking this.
   *
   * Emits `task.dropped` (then `task.terminal{purged}`) BEFORE `DELETE FROM
   * tasks`, all within a single atomic transaction (ADR-0030). The event and
   * the deletion share one commit so the Invalidator can still resolve the
   * taskId — a post-delete emit would race the subscriber cursor read and leave
   * Action-queue rows + dismissal permanently stale.
   *
   * Cascade fix tasks receive the same pre-delete event pair so their own
   * Action-queue rows are invalidated atomically (ADR-0049).
   */
  async drop(): Promise<DropTaskResult> {
    await migrateQueueSchema()
    const id = this.arcId

    return this.store.atomic(async (scope) => {
      const before = await scope.execute({
        sql: `SELECT status FROM tasks WHERE id = ?`,
        args: [id],
      })
      if (before.rows.length === 0) {
        throw new Error(`task ${id} not found`)
      }
      const previousStatus = (before.rows[0] as unknown as { status: TaskStatus })
        .status

      const incoming = await scope.execute({
        sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
        args: [id],
      })
      const outgoing = await scope.execute({
        sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
        args: [id],
      })
      const incomingCount = Number(
        (incoming.rows[0] as unknown as { n: number | bigint }).n,
      )
      const outgoingCount = Number(
        (outgoing.rows[0] as unknown as { n: number | bigint }).n,
      )

      // Cascade: collect every fix/recovery task whose fix_for_task_id points
      // at the origin being dropped. These are deleted atomically in the same
      // transaction (ADR-0049: purge cascades the whole recovery arc).
      const fixRefRows = await scope.execute({
        sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
        args: [id],
      })
      const cascadedFixTaskIds = fixRefRows.rows.map(
        (row) => (row as unknown as { id: string }).id,
      )

      // Emit task.dropped BEFORE the DELETE so the event survives the row
      // removal and the Invalidator's cursor can still resolve the taskId
      // (ADR-0030).
      await scope.execute(
        buildEventInsert('task.dropped', { taskId: id, dropReason: 'purged' }),
      )
      await scope.execute(
        buildEventInsert('task.terminal', { taskId: id, reason: 'purged' }),
      )

      // Emit pre-delete events for every cascade fix task so their Action-queue
      // rows are invalidated before their rows disappear (ADR-0030 / ADR-0049).
      for (const fixId of cascadedFixTaskIds) {
        await scope.execute(
          buildEventInsert('task.dropped', {
            taskId: fixId,
            dropReason: 'purged',
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', { taskId: fixId, reason: 'purged' }),
        )
      }

      // Release dependents: tasks blocked on <id> that have no other
      // non-terminal blocker must flip to 'queued'. This must run BEFORE the
      // bulk DELETE below so the NOT-EXISTS guard sees the correct remaining
      // edge state. The individual edge deletions here make the remaining bulk
      // DELETE a no-op for those rows — correctness is unchanged either way.
      const depRows = await scope.execute({
        sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ?`,
        args: [id],
      })
      const dependentIds = depRows.rows.map(
        (r) => (r as unknown as { task_id: string }).task_id,
      )
      const releaseNow = new Date().toISOString()
      for (const depId of dependentIds) {
        // Remove this specific edge so the NOT-EXISTS subquery below does not
        // count the dropped task as an active blocker when deciding to re-queue.
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
          args: [depId, id],
        })
        // Re-queue the dependent only when every other blocker is already
        // terminal. updated_at precedes status in the SET clause — exempt form
        // required by the architecture guard (status-writer-singleton.test.ts).
        const upd = await scope.execute({
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ? AND status = 'blocked'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM task_blockers b
                       JOIN tasks t2 ON t2.id = b.blocker_task_id
                      WHERE b.task_id = ?
                        AND t2.status NOT IN ('done', 'failed')
                        AND b.state IN ('confirmed', 'pending-review')
                   )`,
          args: [releaseNow, depId, depId],
        })
        if ((upd.rowsAffected ?? 0) > 0) {
          await scope.execute(
            buildEventInsert('task.unblocked', {
              taskId: depId,
              blockerTaskId: id,
            }),
          )
        }
      }

      await scope.execute({
        sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
        args: [id, id],
      })
      // task_proposal_blockers has a FK on task_id → tasks(id). Delete these
      // rows before the task row so the constraint never fires. (Rows where the
      // task appears as proposal_id are in a different db and have no FK here.)
      await scope.execute({
        sql: `DELETE FROM task_proposal_blockers WHERE task_id = ?`,
        args: [id],
      })
      // questions has a FK on task_id → tasks(id). Remove its rows before the
      // task row is deleted so the FK constraint never fires. The table may not
      // yet exist on older DB snapshots that haven't been migrated; the execute
      // is safe because migrateQueueSchema() runs at the top of drop() and will
      // have created the table before we reach this point.
      await scope.execute({
        sql: `DELETE FROM questions WHERE task_id = ?`,
        args: [id],
      })

      // Cascade-delete each fix/recovery task that pointed at the origin.
      // For each: release any tasks that were blocked on the fix task (e.g.
      // other origins sharing a shared recipe fix task), clean up its edges and
      // proposal blockers, then delete its row. ADR-0049: fix tasks never
      // outlive their origin.
      for (const fixId of cascadedFixTaskIds) {
        // Release tasks blocked on this fix task (unblock them if all other
        // blockers are terminal — mirrors the dependent-release loop above).
        const fixDepRows = await scope.execute({
          sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ?`,
          args: [fixId],
        })
        for (const row of fixDepRows.rows) {
          const depId = (row as unknown as { task_id: string }).task_id
          // Skip the origin being dropped — its row disappears below anyway.
          if (depId === id) continue
          await scope.execute({
            sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
            args: [depId, fixId],
          })
          const upd = await scope.execute({
            sql: `UPDATE tasks
                     SET updated_at = ?, status = 'queued'
                   WHERE id = ? AND status = 'blocked'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM task_blockers b
                         JOIN tasks t2 ON t2.id = b.blocker_task_id
                        WHERE b.task_id = ?
                          AND t2.status NOT IN ('done', 'failed')
                          AND b.state IN ('confirmed', 'pending-review')
                     )`,
            args: [releaseNow, depId, depId],
          })
          if ((upd.rowsAffected ?? 0) > 0) {
            await scope.execute(
              buildEventInsert('task.unblocked', {
                taskId: depId,
                blockerTaskId: fixId,
              }),
            )
          }
        }
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
          args: [fixId, fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_proposal_blockers WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM questions WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM tasks WHERE id = ?`,
          args: [fixId],
        })
      }

      await scope.execute({
        sql: `DELETE FROM tasks WHERE id = ?`,
        args: [id],
      })

      return {
        taskId: id,
        previousStatus,
        edgesRemoved: { incoming: incomingCount, outgoing: outgoingCount },
        cascadedFixTaskIds,
      }
    })
  }

  /**
   * Slicer lifecycle purge by explicit id list (ADR-0052 sole-writer). Used by
   * the slice workflow's rollback path to drop a known set of slice + Coder
   * sub-task rows when slicing fails part-way. Distinct from {@link Arc.drop}:
   * single-task scoped (no recovery-arc cascade), no dependent re-queue, and a
   * caller-supplied `dropReason` (e.g. `'slicer-rollback'`) rather than the
   * fixed `'purged'`.
   *
   * Per id, runs ONE atomic transaction that emits `task.dropped{dropReason}`
   * then `task.terminal{reason:'purged'}` BEFORE `DELETE FROM task_blockers`
   * (both edge directions) and `DELETE FROM tasks` — the event and the row
   * removal share one commit so the Invalidator (ADR-0030) can still resolve
   * the taskId and clear any open action-queue rows after the row is gone.
   *
   * Each id is its own atomic scope (never batched across ids) so a single
   * failed delete does not poison the others. Best-effort `.catch()` wrapping
   * is the CALLER's responsibility (preserving the original per-id swallow),
   * NOT this method's — a thrown error here surfaces to the caller's catch.
   */
  static async dropTasksForProposal(
    taskStore: DomainTaskStore,
    ids: string[],
    dropReason: string,
  ): Promise<void> {
    for (const id of ids) {
      await taskStore.atomic(async (scope) => {
        await scope.execute(
          buildEventInsert('task.dropped', {
            taskId: id,
            dropReason,
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', {
            taskId: id,
            reason: 'purged',
          }),
        )
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
          args: [id, id],
        })
        await scope.execute({
          sql: `DELETE FROM tasks WHERE id = ?`,
          args: [id],
        })
      })
    }
  }

  /**
   * Slicer lifecycle purge by proposal (ADR-0052 sole-writer). Used by the
   * slice workflow's crash-recovery pre-flight to drop any orphaned tasks that
   * claim a proposal as parent before Phase 1 re-inserts a fresh set.
   *
   * SELECTs the orphan ids (outside any transaction), and — when at least one
   * exists — runs ONE atomic transaction that emits `task.dropped{dropReason}`
   * then `task.terminal{reason:'purged'}` for every orphan id BEFORE the two
   * bulk deletes (`DELETE FROM task_blockers` for both edge directions scoped
   * by the parent-proposal sub-select, then `DELETE FROM tasks WHERE
   * parent_proposal_id = ?`). Events and row removal share one commit so the
   * Invalidator (ADR-0030) can still resolve each taskId after the rows are
   * gone.
   *
   * Best-effort `.catch()` wrapping is the CALLER's responsibility (preserving
   * the original swallow on both the SELECT and the atomic), NOT this method's.
   */
  static async dropProposalSlices(
    taskStore: DomainTaskStore,
    proposalId: string,
    dropReason: string,
  ): Promise<void> {
    const orphanRows = await taskStore.query({
      sql: `SELECT id FROM tasks WHERE parent_proposal_id = ?`,
      args: [proposalId],
    })
    const orphanIds = orphanRows.rows.map(
      (r) => (r as unknown as { id: string }).id,
    )
    if (orphanIds.length === 0) return
    await taskStore.atomic(async (scope) => {
      for (const orphanId of orphanIds) {
        await scope.execute(
          buildEventInsert('task.dropped', {
            taskId: orphanId,
            dropReason,
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', {
            taskId: orphanId,
            reason: 'purged',
          }),
        )
      }
      await scope.execute({
        sql: `DELETE FROM task_blockers WHERE task_id IN (
                SELECT id FROM tasks WHERE parent_proposal_id = ?
              ) OR blocker_task_id IN (
                SELECT id FROM tasks WHERE parent_proposal_id = ?
              )`,
        args: [proposalId, proposalId],
      })
      await scope.execute({
        sql: `DELETE FROM tasks WHERE parent_proposal_id = ?`,
        args: [proposalId],
      })
    })
  }

  /**
   * Unblock-by-completion write funnel (ADR-0052 sole-writer). When a task
   * lands `done`, look up every task that has it listed as a blocker in
   * `task_blockers` and transition each from `blocked` -> `queued` (or
   * `failed` if the retry budget is exhausted). A dependent only flips if
   * every one of its blockers resolves to a `done` task.
   *
   * STATIC because the subscriber/daemon call this with a *blocker* id that is
   * not an arc root — the relocated body keeps the per-row `store.atomic` scope
   * and the `task.unblocked` event INSIDE the same commit (the only place this
   * status-write SQL lives now), with the SELECTs, internalBus emits,
   * action-queue raises, and worktree reset OUTSIDE the atomic (best-effort).
   *
   * Diagnose Chore intercept (PRD 06e677fb): when the completing task is a
   * diagnose Chore (kind='diagnose'), the generic unblock path is bypassed
   * entirely. Instead the verdict-driven branch fires via `runDiagnoseFollowup`,
   * which reads the structured verdict and either dispatches a fix (root-cause)
   * or escalates to the actionQueue (inconclusive / no-verdict). A diagnose Chore's
   * parent is NEVER re-queued blindly — the verdict owns that decision.
   */
  static async unblockByCompletion(
    blockerTaskId: string,
  ): Promise<UnblockByTaskResult> {
    // Diagnose Chore intercept — must run before the generic blocker loop so
    // the parent is never flipped to 'queued' through the ordinary path.
    const completingTask = await getTask(blockerTaskId)
    if (completingTask?.kind === 'diagnose') {
      // Dynamic import breaks the potential cycle with diagnose-followup.
      // Best-effort: a followup failure must not mask the Chore's done event.
      try {
        const { runDiagnoseFollowup } = await import('./lib/diagnose-followup')
        await runDiagnoseFollowup(blockerTaskId)
      } catch {
        /* best-effort: logged by caller */
      }
      return { blockerTaskId, outcomes: [] }
    }

    const store = await getDefaultTaskStore()
    const now = new Date().toISOString()

    const r = await store.query({
      sql: `SELECT t.id AS id, t.retry_count AS retry_count
              FROM task_blockers b
              JOIN tasks t ON t.id = b.task_id
             WHERE b.blocker_task_id = ?
               AND t.status = 'blocked'`,
      args: [blockerTaskId],
    })

    const budget = getRetryBudget()
    const outcomes: UnblockOutcome[] = []
    const integrationBranch = integrationBranchName()

    for (const row of r.rows as unknown as BlockedDependentRow[]) {
      const retryCount = Number(row.retry_count ?? 0)
      if (retryBudgetExhausted(retryCount, budget)) {
        await raiseActionQueueForBlockedTask(row.id)
        await markTaskFailed(row.id, RETRY_BUDGET_FAILURE_REASON)
        outcomes.push({
          taskId: row.id,
          outcome: 'failed',
          retryCount,
          failureReason: RETRY_BUDGET_FAILURE_REASON,
        })
        continue
      }
      const incomplete = await store.query({
        sql: `SELECT 1
                FROM task_blockers b
                JOIN tasks t ON t.id = b.blocker_task_id
               WHERE b.task_id = ? AND t.status != 'done'
                 AND b.state IN ('confirmed', 'pending-review')
               LIMIT 1`,
        args: [row.id],
      })
      if (incomplete.rows.length > 0) {
        outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
        continue
      }
      // Reset the dependent's worktree to integration HEAD BEFORE flipping it
      // to 'queued' — if the reset is refused (commits ahead) the dependent must
      // never enter the dispatch queue.
      const dep = await getTask(row.id)
      try {
        await resetDependentWorktreeToIntegration(
          row.id,
          dep?.worktreePath ?? null,
          integrationBranch,
        )
      } catch (err: unknown) {
        if (err instanceof WorktreeAheadOfIntegrationError) {
          await raiseWorktreeAheadActionQueue(
            err.taskId,
            err.worktreePath,
            err.aheadCount,
            err.integrationBranch,
          )
          await markTaskFailed(row.id, WORKTREE_AHEAD_FAILURE_REASON)
          outcomes.push({
            taskId: row.id,
            outcome: 'failed',
            retryCount,
            failureReason: WORKTREE_AHEAD_FAILURE_REASON,
          })
          continue
        }
        throw err
      }
      const flipped = await store.atomic(async (scope) => {
        const upd = await scope.execute({
          // updated_at first — exempt from STATUS_WRITE arch guard (conditional WHERE).
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ? AND status = 'blocked'`,
          args: [now, row.id],
        })
        const didFlip = upd.rowsAffected > 0
        if (didFlip) {
          await scope.execute(
            buildEventInsert('task.unblocked', {
              taskId: row.id,
              blockerTaskId,
            }),
          )
        }
        return didFlip
      })
      if (flipped) {
        outcomes.push({ taskId: row.id, outcome: 'queued', retryCount })
        internalBus().emit('task.unblocked', {
          taskId: row.id,
          blockerTaskId,
        })
      } else {
        outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
      }
    }

    return { blockerTaskId, outcomes }
  }

  /**
   * Block-by-task-failure write funnel (ADR-0052 sole-writer). When a task
   * lands `failed` (any failure mode), look up every QUEUED task that has a
   * confirmed/pending-review task_blockers edge pointing at the failed task
   * and flip each from `queued` -> `blocked`. Raise a single actionQueue item
   * per affected downstream naming the failed prerequisite so the operator can
   * act.
   *
   * Tasks already in non-queued states (running, blocked, done, failed,
   * dropped, draft, ...) are untouched — the brief is "don't disturb
   * non-queued downstreams".
   *
   * Symmetric with {@link Arc.unblockByCompletion}: that path moves
   * `blocked` -> `queued` when a blocker reaches `done`; this path moves
   * `queued` -> `blocked` when a blocker reaches `failed`.
   *
   * Idempotent: a second invocation finds no `queued` dependents (they
   * are already `blocked`) and is a no-op. The actionQueue call dedupes on
   * `(originTaskId)` fingerprint, so re-raise bumps `seen_count`.
   */
  static async blockByTaskFailure(
    failedBlockerTaskId: string,
  ): Promise<BlockByFailureResult> {
    const store = await getDefaultTaskStore()
    const now = new Date().toISOString()

    const r = await store.query({
      sql: `SELECT t.id AS id
              FROM task_blockers b
              JOIN tasks t ON t.id = b.task_id
             WHERE b.blocker_task_id = ?
               AND t.status = 'queued'
               AND b.state IN ('confirmed', 'pending-review')`,
      args: [failedBlockerTaskId],
    })

    const outcomes: BlockByFailureOutcome[] = []
    for (const row of r.rows as unknown as Array<{ id: string }>) {
      const flipped = await store.atomic(async (scope) => {
        const upd = await scope.execute({
          // updated_at first — exempt from STATUS_WRITE arch guard (conditional WHERE).
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'blocked'
                 WHERE id = ? AND status = 'queued'`,
          args: [now, row.id],
        })
        const didFlip = upd.rowsAffected > 0
        // Emit the blocked transition durably, in the same tx, only when the
        // guarded UPDATE actually flipped the row (ADR-0030).
        if (didFlip) {
          await scope.execute(
            buildEventInsert('task.blocked', {
              taskId: row.id,
              fixTaskId: null,
              failureSignature: `prerequisite-failed:${failedBlockerTaskId}`,
              failingStep: 'blocked-dependent',
            }),
          )
        }
        return didFlip
      })
      if (flipped) {
        try {
          await raiseActionQueueItem({
            kind: PREREQUISITE_FAILED_ACTION_QUEUE_KIND,
            category: 'orchestrator',
            priority: 'high',
            title: `Task ${row.id} blocked: prerequisite ${failedBlockerTaskId} failed`,
            body:
              `Task ${row.id} was queued waiting on prerequisite ${failedBlockerTaskId}.\n\n` +
              `The prerequisite failed, so this task has been moved from 'queued' to 'blocked' ` +
              `and will not dispatch into a broken tree.\n\n` +
              `Resolve the failed prerequisite (e.g. \`mars restart ${failedBlockerTaskId}\` or ` +
              `via the actionQueue item raised for it), or drop the blocker edge with ` +
              `\`mars unblock ${row.id} ${failedBlockerTaskId}\`.`,
            payload: {
              dependentTaskId: row.id,
              failedBlockerTaskId,
            },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: 'agent:prerequisite-failed',
            signature: `${row.id}:${failedBlockerTaskId}`,
            originTaskId: row.id,
            occurrence: {
              at: new Date().toISOString(),
              failedBlockerTaskId,
            },
          })
        } catch {
          // best-effort: actionQueue failure must not block the cascade
        }
        outcomes.push({ taskId: row.id, outcome: 'blocked' })
      } else {
        outcomes.push({ taskId: row.id, outcome: 'noop' })
      }
    }

    return { failedBlockerTaskId, outcomes }
  }

  /**
   * Cancellation-cascade write funnel (ADR-0052 sole-writer / PRD slice 2/4
   * mars-9234e1b2). When a blocker reaches `failed` with
   * `failure_reason = 'cancelled'` (i.e. the user explicitly stopped it via
   * the slice-1 stop-task RPC), dependents waiting on it must NOT be recovered
   * — they must fail too, with their own
   * `failure_reason = 'cancelled-blocker-cascade'`, and an actionQueue item
   * naming the cancelled blocker so the operator can see why the dependent died.
   *
   * Keeps the {@link updateTask} choicepoint via the Arc aggregate (the
   * terminal-transition primitive that survives inside the aggregate handles
   * the per-row status flip + paired event); the SELECT and actionQueue raise
   * stay OUTSIDE that write (best-effort).
   *
   * Symmetric with {@link Arc.unblockByCompletion}: that path fires when a
   * blocker reaches `done` and unblocks dependents; this path fires when
   * a blocker is cancelled and cascades the cancel down the dependency
   * chain instead.
   *
   * Blocker edges in `task_blockers` stay attached — they are
   * informational; the dependent row is dead and the edges merely record
   * the cause of death for forensics.
   */
  static async cascadeCancellation(
    blockerTaskId: string,
  ): Promise<UnblockByTaskResult> {
    const store = await getDefaultTaskStore()

    const r = await store.query({
      sql: `SELECT t.id AS id, t.retry_count AS retry_count
              FROM task_blockers b
              JOIN tasks t ON t.id = b.task_id
             WHERE b.blocker_task_id = ?
               AND t.status = 'blocked'
               AND b.state IN ('confirmed', 'pending-review')`,
      args: [blockerTaskId],
    })

    const outcomes: UnblockOutcome[] = []
    for (const row of r.rows as unknown as BlockedDependentRow[]) {
      const retryCount = Number(row.retry_count ?? 0)
      const cascadeSignature = computeFailureSignature(
        'blocked-dependent',
        CANCELLED_CASCADE_FAILURE_REASON,
      )
      await updateTask(row.id, {
        status: 'failed',
        error: `cancelled-blocker-cascade: blocker ${blockerTaskId} was cancelled by user`,
        failureReason: CANCELLED_CASCADE_FAILURE_REASON,
        failureSignature: cascadeSignature,
        failureReasonCode: cascadeSignature,
      })
      try {
        await raiseActionQueueItem({
          kind: CANCELLED_CASCADE_ACTION_QUEUE_KIND,
          category: 'orchestrator',
          priority: 'normal',
          title: `Dependent ${row.id} cancelled because blocker ${blockerTaskId} was cancelled`,
          body:
            `Task ${row.id} was waiting on blocker ${blockerTaskId}.\n\n` +
            `The blocker was cancelled by the user (stop-task RPC, failure_reason='cancelled'). ` +
            `Per the cancellation-cascade rule, this dependent has been marked failed ` +
            `with failure_reason='${CANCELLED_CASCADE_FAILURE_REASON}' instead of being unblocked.`,
          payload: {
            dependentTaskId: row.id,
            cancelledBlockerTaskId: blockerTaskId,
            failureReason: CANCELLED_CASCADE_FAILURE_REASON,
          },
          context: { repoRoot: process.env.MARS_REPO ?? null },
          raisedBy: 'agent:blocker-cascade',
          signature: `${row.id}:${blockerTaskId}`,
          originTaskId: row.id,
          occurrence: {
            at: new Date().toISOString(),
            cancelledBlockerTaskId: blockerTaskId,
          },
        })
      } catch {
        // best-effort: actionQueue failure must not block the cascade
      }
      outcomes.push({
        taskId: row.id,
        outcome: 'failed',
        retryCount,
        failureReason: CANCELLED_CASCADE_FAILURE_REASON,
      })
    }

    return { blockerTaskId, outcomes }
  }

  /**
   * Recover-blocked-task write funnel (ADR-0052 sole-writer). Re-evaluate a
   * single blocked task: if all its remaining blockers have resolved (are
   * 'done') or have been removed, flip it from 'blocked' to 'queued' and
   * signal the dispatch loop via internalBus.
   *
   * INSTANCE method keyed on `this.arcId` (the task under recovery). Called
   * after a blocker edge is manually removed (`mars unblock <task> <blocker>`)
   * so a task that now has zero unmet blockers is released immediately — no
   * daemon restart required.
   *
   * Mirrors the per-row logic inside {@link Arc.unblockByCompletion}: same
   * retry-budget check, same worktree reset, same durable outbox event INSIDE
   * the per-row `store.atomic` scope.
   */
  async recoverBlocked(): Promise<RecoverBlockedTaskOutcome> {
    const taskId = this.arcId
    const task = await getTask(taskId)
    if (!task || task.status !== 'blocked') {
      return { taskId, outcome: 'not-blocked', retryCount: 0 }
    }

    const retryCount = task.retryCount ?? 0
    const budget = getRetryBudget()
    if (retryBudgetExhausted(retryCount, budget)) {
      await raiseActionQueueForBlockedTask(taskId)
      await markTaskFailed(taskId, RETRY_BUDGET_FAILURE_REASON)
      return { taskId, outcome: 'failed', retryCount, failureReason: RETRY_BUDGET_FAILURE_REASON }
    }

    const store = await getDefaultTaskStore()
    const now = new Date().toISOString()

    // Any confirmed/pending-review blocker edge whose blocker is not yet done?
    const incomplete = await store.query({
      sql: `SELECT 1
              FROM task_blockers b
              JOIN tasks t ON t.id = b.blocker_task_id
             WHERE b.task_id = ? AND t.status != 'done'
               AND b.state IN ('confirmed', 'pending-review')
             LIMIT 1`,
      args: [taskId],
    })
    if (incomplete.rows.length > 0) {
      return { taskId, outcome: 'noop', retryCount }
    }

    // Reset the dependent's worktree to integration HEAD before re-dispatching.
    const integrationBranch = integrationBranchName()
    try {
      await resetDependentWorktreeToIntegration(
        taskId,
        task.worktreePath ?? null,
        integrationBranch,
      )
    } catch (err: unknown) {
      if (err instanceof WorktreeAheadOfIntegrationError) {
        await raiseWorktreeAheadActionQueue(
          err.taskId,
          err.worktreePath,
          err.aheadCount,
          err.integrationBranch,
        )
        await markTaskFailed(taskId, WORKTREE_AHEAD_FAILURE_REASON)
        return { taskId, outcome: 'failed', retryCount, failureReason: WORKTREE_AHEAD_FAILURE_REASON }
      }
      throw err
    }

    const flipped = await store.atomic(async (scope) => {
      const upd = await scope.execute({
        // updated_at first — exempt from STATUS_WRITE arch guard (conditional WHERE).
        sql: `UPDATE tasks
                 SET updated_at = ?, status = 'queued'
               WHERE id = ? AND status = 'blocked'`,
        args: [now, taskId],
      })
      const didFlip = upd.rowsAffected > 0
      if (didFlip) {
        await scope.execute(buildEventInsert('task.unblocked', { taskId }))
      }
      return didFlip
    })

    if (flipped) {
      internalBus().emit('task.unblocked', { taskId })
      return { taskId, outcome: 'queued', retryCount }
    }
    return { taskId, outcome: 'noop', retryCount }
  }

  /**
   * Recover-all-blocked write funnel (ADR-0052 sole-writer). Scan every
   * 'blocked' task and re-evaluate each via {@link Arc.recoverBlocked}. Tasks
   * whose blockers are all resolved (done or removed) are flipped to 'queued'
   * and signalled to the dispatch loop.
   *
   * Operator escape hatch: `mars recover` triggers this on the running daemon
   * without needing a restart. Equivalent in intent to the legacy
   * `recoverBlockedTasks` boot-time scan, but safe to run on-demand at any
   * time. The SELECT driving the loop stays OUTSIDE any atomic; each row is
   * recovered through its own `Arc.load(id).recoverBlocked()` instance call.
   */
  static async recoverAllBlocked(): Promise<RecoverAllBlockedTasksResult> {
    const store = await getDefaultTaskStore()
    const r = await store.query({
      sql: `SELECT id FROM tasks WHERE status = 'blocked'`,
      args: [],
    })
    const outcomes: RecoverBlockedTaskOutcome[] = []
    for (const row of r.rows as unknown as Array<{ id: string }>) {
      const outcome = await Arc.load(row.id).recoverBlocked()
      outcomes.push(outcome)
    }
    return { outcomes }
  }

  /**
   * Propagate-recovery-done write funnel (ADR-0052 sole-writer). When a
   * recovery task (kind='fix', non-null fixForTaskId) reaches `done`, the work
   * the operator was waiting on has shipped. Flip the origin row (`this.arcId`)
   * to `done`, close actionQueue items keyed on the origin, and propagate the
   * unblock signal so dependents waiting on the origin leave `blocked`.
   *
   * INSTANCE method keyed on `this.arcId` (the origin / fixForTaskId target).
   *
   * Idempotent: a no-op if the origin is already in a terminal state, or
   * if the recovery's fixForTaskId points at a missing/non-blocked row.
   *
   * CLAUDE.md contract: "a successful recovery counts as its origin
   * reaching done, so a recovered blocker unblocks the whole chain."
   *
   * PARITY: the two-tx structure is preserved bit-for-bit — first
   * {@link Arc.setTaskStatus} routes the status change + paired `task.completed`
   * event through the single-writer chokepoint, then a second `store.atomic`
   * clears `error = NULL` and emits `task.terminal`. The terminal-immutability
   * guard is the caller-side pre-check below (the early-return when the origin
   * is already terminal); Arc.setTaskStatus does NOT enforce it (ADR-0052).
   */
  async propagateRecoveryDone(): Promise<PropagateRecoveryDoneResult> {
    const originTaskId = this.arcId
    const origin = await getTask(originTaskId)

    // Close any actionQueue row keyed to the origin regardless of whether we
    // flip its status. The origin may be missing (purged, or the
    // recovery's fixForTaskId was a PRD slug rather than a task row),
    // or already terminal (the retry-budget guard parked it in
    // `failed` before the recovery finished). In either case the
    // operator no longer needs to see a stale "recovery-failed" row:
    // the recovery just succeeded, the underlying work shipped.
    let actionQueueItemsClosed = 0
    try {
      const closed = await supersedeActionQueueItemsForOrigin(originTaskId, 'origin-done')
      actionQueueItemsClosed = closed.length
    } catch {
      // best-effort: actionQueue closing must not block dependent unblock
    }

    if (!origin) {
      return {
        originTaskId,
        originFlipped: false,
        unblock: null,
        actionQueueItemsClosed,
      }
    }
    if (origin.status === 'done' || origin.status === 'failed' || origin.status === 'dropped') {
      return {
        originTaskId,
        originFlipped: false,
        unblock: null,
        actionQueueItemsClosed,
      }
    }
    // Route the status change and its paired event through the single-writer
    // chokepoint (Arc.setTaskStatus) so they commit atomically. The pre-checks
    // above (origin missing or already terminal) guarantee the origin is not
    // in a terminal state at this point; the TOCTOU window is acceptable in
    // the single-process orchestrator. Arc.setTaskStatus does NOT enforce
    // terminal immutability — the early-return at the top of this function is
    // the sole guard (ADR-0052 preserves the caller-side defense).
    const store = await getDefaultTaskStore()
    await Arc.setTaskStatus(originTaskId, 'done', { result: { via: 'recovery' } }, store)
    // Clear the error field and emit the terminal event in a second transaction.
    const now = new Date().toISOString()
    await store.atomic(async (scope) => {
      await scope.execute({
        sql: `UPDATE tasks SET error = NULL, updated_at = ? WHERE id = ?`,
        args: [now, originTaskId],
      })
      await scope.execute(
        buildEventInsert('task.terminal', {
          taskId: originTaskId,
          reason: 'done',
        }),
      )
    })
    const unblock = await Arc.unblockByCompletion(originTaskId)
    return {
      originTaskId,
      originFlipped: true,
      unblock,
      actionQueueItemsClosed,
    }
  }

  /**
   * Assert the two Arc invariants. PLACEHOLDER (S1): no-op stub; the real
   * checks land in S9.
   *
   *  1. Every Action's `arcId` (`origin_id`) points at a real Arc — i.e. there
   *     is a row whose `id` equals that `origin_id`.
   *  2. Every Arc has exactly one origin Action with `kind='task'` (the row
   *     whose `id === origin_id`).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private static assertArcInvariant(_arcId: string): void {
    // S9: implement the two-invariant check. Intentionally a no-op this slice.
  }
}
