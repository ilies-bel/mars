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
 * an injected {@link DomainTaskStore} (the deep seam over the shared DB) so
 * all persistence routes through the store rather than a raw DB client.
 */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { type DbStatement } from './lib/db'
import {
  coerceToString,
  validatePriority,
  isTaskTag,
  isMergeMode,
  MERGE_MODES,
  TASK_SEL,
  rowToTask,
  assertTaskKindInvariant,
  ensureQueueSchema,
  getTask,
  reopenTerminalTask,
  updateTask,
  resolveQueueClient,
  MAX_PRIORITY,
  UNSETTLED_BLOCKER_SQL,
  type Task,
  type TaskPlan,
  type TaskStatus,
  type TaskDropReason,
  type TaskKind,
  type TaskTag,
  type EnqueueTaskOptions,
  type DropTaskResult,
  type UnblockTaskResult,
} from './queue'
import {
  getDefaultTaskStore,
  getDefaultDomainTaskStore,
  type DomainTaskStore,
} from './store/task-store'
import { getStateDir, getRepoRoot } from './context'
import { removeWorktree } from './lib/git/worktree'
import { provisionWorktreeDeps } from './lib/worktree-deps'
import { getRecipeOrGeneric, type FixRecipeContext } from './lib/fix-recipes'
import { buildEventInsert, publish, withWriteTx } from './lib/outbox'
import { assertNotRecoveryEdge } from './lib/blocker-invariant'
import {
  MAIN_COMMITER_RECIPE,
  parseMainCommiterPayload,
  SOURCE_ERROR_SUMMARY,
  VERIFY_MAIN_DIRTY_CODE,
  serialiseMainCommiterPayload,
  type MainCommiterPayload,
} from './lib/main-dirty'
import type { TraceEventStore } from './lib/trace-events-store'
import { internalBus } from '../internal-bus'
import { hintDispatch } from './daemon/dispatch-hint'
import { getProposal } from './proposals'
import { markTaskFailed } from './queue-retry'
import { computeFailureSignature } from './lib/failure-signature'
import { linkTaskToThread } from './daemon/chat-thread-tasks'
import {
  raiseActionQueueItem,
  resolveAllRowsForTask,
  supersedeActionQueueItemsForOrigin,
} from './lib/action-queue'
import {
  CANCELLED_CASCADE_ACTION_QUEUE_KIND,
  CANCELLED_CASCADE_FAILURE_REASON,
  composeOriginRecoveryFailedReason,
  ORPHANED_ORIGIN_FAILURE_REASON,
  PREREQUISITE_FAILED_ACTION_QUEUE_KIND,
  WORKTREE_AHEAD_FAILURE_REASON,
  WorktreeAheadOfIntegrationError,
  integrationBranchName,
  raiseOrphanedOriginActionQueue,
  raiseWorktreeAheadActionQueue,
  resetDependentWorktreeToIntegration,
  type BlockByFailureOutcome,
  type BlockByFailureResult,
  type BlockedDependentRow,
  type FailStrandedOriginOutcome,
  type FailStrandedOriginResult,
  type PropagateRecoveryDoneResult,
  type RecoverAllBlockedTasksResult,
  type RecoverBlockedTaskOutcome,
  type UnblockByTaskResult,
  type UnblockOutcome,
} from './blocker-resolution'

const execFileP = promisify(execFile)

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

/**
 * Thrown when an Arc-aggregate write would leave (or has left) the task graph
 * in a state that violates one of the two Arc invariants checked by
 * {@link Arc.assertArcInvariant} (ADR-0052):
 *
 *  A. every Action's `origin_id` resolves to a real Arc root row;
 *  B. every Arc root is a non-recovery origin Action (`kind` ∈ {'task',
 *     'diagnose'}, `fix_for_task_id IS NULL`).
 *
 * This is a *construction guard*, not a runtime recovery path: a throw means
 * the aggregate produced a stranded entity, which is a bug in a write method,
 * not an operator-actionable condition.
 */
export class ArcInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArcInvariantError'
  }
}

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
  /**
   * Optional QA note from `mars release --abort <id> --note '<text>'`.
   * When present, it is appended verbatim to the fix-task prompt under a
   * `## QA note` heading so the recovery agent sees the operator's
   * feedback without querying the database.
   */
  qaNote?: string
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

/**
 * A single progress journal entry (Foreground-session discipline).
 * Written by {@link Arc.appendProgress}; read by {@link Arc.listProgress}.
 */
export interface ProgressEntry {
  id: string
  taskId: string
  createdAt: number
  author: string
  kind: 'note' | 'check' | 'uncheck'
  body: string
  criterionIndex: number | null
}

/**
 * Parameters for {@link Arc.appendProgress}.
 *
 * `criterionIndex` is 1-based and required for 'check'/'uncheck' kinds.
 * For 'note' entries it must be omitted or null.
 */
export interface AppendProgressParams {
  taskId: string
  author: string
  kind: 'note' | 'check' | 'uncheck'
  body: string
  criterionIndex?: number | null
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
    await ensureQueueSchema()
    const id = `mars-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const status: TaskStatus = opts?.skipTriage ? 'queued' : 'draft'
    const authorKind = opts?.author?.kind ?? null
    const authorName = opts?.author?.name ?? null

    // ── Supersede preamble ────────────────────────────────────────────────
    // When opts.supersedes is set: release the superseded task's worktree,
    // mark it dropped, and inherit its branch + originId for the new task.
    // Sequence is guarded so a mid-way failure (worktree creation fails)
    // leaves an explicit, recoverable state: superseded task stays dropped,
    // no new task row is created, and the error surfaces with the branch
    // name so the operator can retry with --supersede <oldId>.
    let inheritedBranch: string | null = null
    let inheritedWorktreePath: string | null = null
    let supersedeDerivedOriginId: string | null = null

    if (opts?.supersedes) {
      const supersededId = opts.supersedes
      const superseded = await getTask(supersededId)
      if (!superseded) {
        throw new Error(`supersede: task ${supersededId} not found`)
      }
      // The new task inherits the arc of the superseded task.
      supersedeDerivedOriginId = superseded.originId

      // Step 1: release the old worktree (keep branch — we reuse it).
      if (superseded.worktreePath !== null && superseded.branch !== null) {
        await removeWorktree(
          { path: superseded.worktreePath, branch: superseded.branch },
          true,  // force
          true,  // keepBranch — reuse branch for new task
        ).catch(() => {
          // worktree already gone on disk — continue; the git pruning in
          // createWorktree / git worktree add would surface a real error.
        })
      }

      // Step 2: mark superseded task dropped + clear its worktree_path in
      // one atomic transaction (updateTask → Arc.applyStatusWrite).
      await updateTask(supersededId, {
        status: 'dropped',
        worktreePath: null,
        failureReason: `superseded by new task ${id}`,
      })

      // Step 3: create new worktree on superseded branch at new task's path.
      // If this fails, the superseded task remains dropped, no new row is
      // created, and the caller gets a descriptive error with the branch name.
      if (superseded.branch !== null) {
        const newWorktreePath = resolve(getStateDir(), 'worktrees', id)
        await mkdir(resolve(newWorktreePath, '..'), { recursive: true })
        try {
          await execFileP(
            'git',
            ['worktree', 'add', newWorktreePath, superseded.branch],
            { cwd: getRepoRoot() },
          )
          await provisionWorktreeDeps({ worktreeRoot: newWorktreePath })
          inheritedBranch = superseded.branch
          inheritedWorktreePath = newWorktreePath
        } catch (cause) {
          throw new Error(
            `supersede: released worktree for ${supersededId} on branch ${superseded.branch} ` +
              `but failed to create new worktree: ${cause instanceof Error ? cause.message : String(cause)}. ` +
              `Re-run 'mars task add --supersede ${supersededId}' to retry.`,
          )
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    let originId = supersedeDerivedOriginId ?? (opts?.originId ?? id)
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
    if (taskSpec !== null && !isMergeMode(taskSpec.mergeMode)) {
      throw new Error(
        `spec.mergeMode must be one of ${MERGE_MODES.join(', ')}; got '${String(taskSpec.mergeMode)}'`,
      )
    }
    const verifyCmd = taskSpec ? taskSpec.verifyCmd : null
    const mergeMode = taskSpec ? taskSpec.mergeMode : null
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
    // Derive intent from opts or from the first sentence of prompt (split on
    // '. ' or newline, capped at 200 chars). Inlined — single call site.
    let intent: string
    if (opts?.intent !== undefined && opts.intent !== '') {
      intent = opts.intent.slice(0, 200)
    } else {
      const nlIdx = promptText.indexOf('\n')
      const dotIdx = promptText.indexOf('. ')
      let end: number
      if (dotIdx !== -1 && (nlIdx === -1 || dotIdx < nlIdx)) {
        end = dotIdx + 1 // include the '.'
      } else if (nlIdx !== -1) {
        end = nlIdx // exclude the newline
      } else {
        end = promptText.length
      }
      intent = promptText.slice(0, Math.min(end, 200))
    }
    const originSessionId = opts?.originSessionId ?? null
    const workflow = opts?.workflow ?? null
    const compensatesArcId = opts?.compensatesArcId ?? null
    const followupDedupKey = opts?.followupDedupKey ?? null
    const qa: 'auto' | 'manual' = opts?.qa === 'manual' ? 'manual' : 'auto'
    const deferrable = opts?.deferrable === true ? 1 : 0
    await resolvedStore.atomic(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, author_kind, author_name, origin_id, priority, parent_proposal_id, slice_index, tags_json, kind, verify_cmd, merge_mode, read_first_json, prescriptive_action, slice_kind, sub_deliverable_json, intent, origin_session_id, workflow, compensates_arc_id, followup_dedup_key, qa, "deferrable", created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          mergeMode,
          readFirstJson,
          prescriptiveAction,
          sliceKindVal,
          subDeliverableJson,
          intent,
          originSessionId,
          workflow,
          compensatesArcId,
          followupDedupKey,
          qa,
          deferrable,
          now,
          now,
        ],
      })
      // Write spec.files to task_spec_files junction table.
      if (taskSpec?.files && taskSpec.files.length > 0) {
        for (let i = 0; i < taskSpec.files.length; i++) {
          await tx.execute({
            sql: `INSERT INTO task_spec_files (task_id, path, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            args: [id, taskSpec.files[i], i],
          })
        }
      }
      // Write spec.doneCriteria to task_done_criteria junction table.
      if (taskSpec?.doneCriteria && taskSpec.doneCriteria.length > 0) {
        for (let i = 0; i < taskSpec.doneCriteria.length; i++) {
          await tx.execute({
            sql: `INSERT INTO task_done_criteria (task_id, criterion, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            args: [id, taskSpec.doneCriteria[i], i],
          })
        }
      }
      if (opts?.chatThreadId) await linkTaskToThread(opts.chatThreadId, id, tx)
    })
    // Supersede: if we inherited a branch + worktree from the superseded task,
    // stamp them onto the new task row so the dispatcher sees a ready worktree.
    if (inheritedBranch !== null && inheritedWorktreePath !== null) {
      const updNow = new Date().toISOString()
      await resolvedStore.execute({
        sql: `UPDATE tasks SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?`,
        args: [inheritedBranch, inheritedWorktreePath, updNow, id],
      })
    }
    const r = await resolvedStore.execute({
      sql: `${TASK_SEL} WHERE t.id = ?`,
      args: [id],
    })
    await Arc.maybeAssertArcInvariant(id, resolvedStore)
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
   *     the event INSERTs in one transaction.
   */
  static async applyStatusWrite(input: {
    id: string
    fields: string[]
    args: unknown[]
    eventStmts: DbStatement[]
    store?: DomainTaskStore
    appendSessionId?: boolean
    sessionIdStmt?: DbStatement
  }): Promise<void> {
    const updateStmt: DbStatement = {
      sql: `UPDATE tasks SET ${input.fields.join(', ')} WHERE id = ?`,
      args: input.args as never,
    }

    if (input.appendSessionId) {
      // Atomically (a) apply the field updates, (b) insert the new session id
      // into task_claude_sessions (ON CONFLICT DO NOTHING deduplicates), and (c) insert the
      // outbox event row.  All three writes share one write transaction so a
      // crash between any two leaves the DB consistent (either everything
      // committed or nothing).
      const sessionIdStmt = input.sessionIdStmt as DbStatement
      await withWriteTx(resolveQueueClient(), async (tx) => {
        await tx.execute(updateStmt)
        await tx.execute(sessionIdStmt)
        // Event INSERTs share the same transaction: if any throws the whole
        // transaction rolls back (no orphan state row without event).
        for (const stmt of input.eventStmts) await tx.execute(stmt)
      })
    } else if (input.store) {
      // store.batch runs all statements atomically (BEGIN … COMMIT) so the
      // state write and event inserts are in the same commit.
      await input.store.batch([updateStmt, ...input.eventStmts], 'write')
    } else {
      // Common path: wrap state write and event inserts in a single write
      // transaction so a failure between the two never drops the event.
      // TODO(mars-8a44f22d): once all callers thread a `store`, retire this
      // fallback and route through `store.atomic(scope => ...)` like the
      // `appendSessionId` branch above.
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
    await ensureQueueSchema()
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
                     WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
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
    // TODO(mars-8a44f22d): this is the legacy no-store path. Once all callers
    // of Arc.promoteDraftToQueued / queue.promoteDraftToQueued thread a store,
    // retire this branch and have them always take the `if (store)` path above
    // (which uses store.atomic and eliminates this resolveQueueClient() usage).
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
                   WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
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
    // Read the freshly-promoted row back through the typed getTask seam instead
    // of a raw resolveQueueClient() SELECT (mars-8a44f22d: close direct-client
    // escape hatches in arc.ts).
    return getTask(taskId)
  }

  /**
   * Guarded `'draft' → 'triaging'` promote (ADR-0052 sole-writer). Relocated
   * bit-for-bit from `queue.ts:promoteDraftToTriaging`. The dispatcher calls
   * this immediately after picking a draft task so it is observable in the
   * transient `'triaging'` phase while the Linker runs. The conditional WHERE
   * (`AND status = 'draft'`) cannot be expressed through the column-patch
   * {@link Arc.applyStatusWrite} funnel, so it lives as its own primitive here.
   *
   * PARITY: the historic body emitted NO lifecycle event for the
   * draft→triaging flip (it is an internal staging transition the Invalidator
   * does not track), so this relocation issues the guarded UPDATE only — no
   * publish/buildEventInsert. The `updated_at`-first SET ordering is preserved.
   *
   * Returns the updated {@link Task} on success; `null` if the row did not flip
   * (missing, or not currently in `'draft'`).
   */
  static async promoteDraftToTriaging(taskId: string): Promise<Task | null> {
    await ensureQueueSchema()
    const now = new Date().toISOString()
    // TODO(mars-8a44f22d): this guarded UPDATE uses a conditional WHERE
    // (AND status = 'draft') and checks rowsAffected to distinguish a no-op
    // from a real flip. The `store.atomic(scope => scope.execute(...))` path
    // (used by promoteDraftToQueued when a store is injected) would express this
    // cleanly. A store parameter should be threaded through promoteDraftToTriaging
    // and its callers (dispatcher) to retire this resolveQueueClient() usage.
    const upd = await resolveQueueClient().execute({
      sql: `UPDATE tasks
               SET updated_at = ?, status = 'triaging'
             WHERE id = ?
               AND status = 'draft'`,
      args: [now, taskId],
    })
    if (upd.rowsAffected === 0) return null
    // Read the freshly-promoted row back through the typed getTask seam instead
    // of a raw resolveQueueClient() SELECT (mars-8a44f22d: close direct-client
    // escape hatches in arc.ts).
    return getTask(taskId)
  }

  /**
   * Manual unblock escape hatch (ADR-0052 sole-writer). Relocated bit-for-bit
   * from `queue.ts:unblockTask`. Flips a `blocked`-or-`queued` task to `failed`,
   * clears its `task_blockers` rows, and emits `task.failed` + `task.terminal`
   * — all in ONE write transaction (ADR-0030) so the status write is never a
   * silent bypass of the event substrate. Used by `mars unblock <id>` so users
   * do not reach for raw SQL when a row has slipped into an inconsistent state.
   *
   * PARITY (preserved bit-for-bit from the historic `unblockTask`):
   *   - `'queued'` is accepted alongside `'blocked'` (drop a not-yet-dispatched
   *     row); any other status returns `{ outcome: 'noop' }`;
   *   - the guarded UPDATE uses the `updated_at`-first SET ordering;
   *   - the terminal event fires with reason `'failed'`; per ADR-0028 the
   *     Invalidator deliberately does NOT close action-queue rows on `failed`.
   */
  static async unblockTask(taskId: string): Promise<UnblockTaskResult> {
    await ensureQueueSchema()
    // TODO(mars-8a44f22d): unblockTask drives a write transaction via the raw
    // client.  Thread a `store?: DomainTaskStore` parameter and use
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

  /**
   * Atomic single-writer chokepoint for task status changes (ADR-0052).
   *
   * Relocated bit-for-bit from `queue.ts:setTaskStatus`. Wraps the raw
   * `UPDATE tasks SET status` and the matching outbox event in one commit so
   * the event id is allocated in the same SQLite transaction as the row change
   * (ADR-0030 same-commit guarantee). Callers that need additional column
   * updates (e.g. `drop_reason`, `failure_reason`) or additional events (e.g.
   * `task.terminal`) are appended to the same transaction for terminal
   * statuses. This keeps every terminal status write observable by durable
   * subscribers without a crash window between the row change and its event.
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
   *     pre-check ({@link Arc.propagateRecoveryDone} returns early only when
   *     the origin is already `done` — the true idempotent case; `failed` and
   *     `dropped` origins are intentionally reconciled to `done`). Keep that
   *     defense at the call site.
   *
   * Store routing (ADR-0021 / ADR-0030): when `store` is provided the row
   * UPDATE + event INSERT run via `store.batch([updateStmt, ...eventStmts],
   * 'write')` (one BEGIN … COMMIT); otherwise the body is the historic
   * `withWriteTx(resolveQueueClient(), …)` form preserved bit-for-bit.
   */
  static async setTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    extras?: { error?: string; result?: unknown; dropReason?: TaskDropReason },
    store?: DomainTaskStore,
  ): Promise<void> {
    const now = new Date().toISOString()
    const eventType = mapStatusToEvent(newStatus)
    if (store) {
      // Transitioning to 'done': clear stale failure fields from any prior
      // failed attempt so done rows never carry a misleading failure_reason.
      const updateStmt: DbStatement = {
        sql:
          newStatus === 'done'
            ? 'UPDATE tasks SET status = ?, updated_at = ?, failure_reason = NULL, failure_signature = NULL, failure_reason_code = NULL WHERE id = ?'
            : 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
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
      let eventStmt: DbStatement
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
      const terminalStmt =
        newStatus === 'done' || newStatus === 'dropped' || newStatus === 'failed'
          ? buildEventInsert('task.terminal', {
              taskId,
              reason: newStatus,
            })
          : null
      // Row change + lifecycle event(s) share one commit (ADR-0030).
      await store.batch(
        terminalStmt ? [updateStmt, eventStmt, terminalStmt] : [updateStmt, eventStmt],
        'write',
      )
      return
    }
    await withWriteTx(resolveQueueClient(), async (tx) => {
      // Transitioning to 'done': clear stale failure fields from any prior
      // failed attempt so done rows never carry a misleading failure_reason.
      await tx.execute({
        sql:
          newStatus === 'done'
            ? 'UPDATE tasks SET status = ?, updated_at = ?, failure_reason = NULL, failure_signature = NULL, failure_reason_code = NULL WHERE id = ?'
            : 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
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
      if (newStatus === 'done' || newStatus === 'dropped' || newStatus === 'failed') {
        await publish(tx, 'task.terminal', { taskId, reason: newStatus })
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
   * `extras` mirrors the historic `setTaskStatus`/`updateTask` extras shape so
   * callers that carried an `error`/`dropReason` payload — and the richer
   * forensic columns the cascade/terminal funnels write — map cleanly onto
   * `updateTask`'s patch columns:
   *   - `error`            → `patch.error`            (rides the failure payload),
   *   - `dropReason`       → `patch.failureReason`    (rides the `task.dropped`
   *     payload),
   *   - `failureReason`    → `patch.failureReason`    (free-text archive; takes
   *     precedence over `dropReason` when both are given),
   *   - `failureReasonCode`→ `patch.failureReasonCode`(typed catalog code),
   *   - `failureSignature` → `patch.failureSignature` (structured signature).
   * `result` is accepted for shape-compatibility but is not a persisted column;
   * `updateTask` emits `task.completed` with `result: null` (unchanged).
   */
  async transition(
    taskId: string,
    to: TaskStatus,
    extras?: {
      error?: string
      result?: unknown
      dropReason?: TaskDropReason
      failureReason?: string | null
      failureReasonCode?: string | null
      failureSignature?: string | null
    },
  ): Promise<void> {
    const failureReason =
      extras?.failureReason !== undefined
        ? extras.failureReason
        : extras?.dropReason
    await updateTask(taskId, {
      status: to,
      ...(extras?.error !== undefined ? { error: extras.error } : {}),
      ...(extras?.dropReason !== undefined ? { dropReason: extras.dropReason } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(extras?.failureReasonCode !== undefined
        ? { failureReasonCode: extras.failureReasonCode }
        : {}),
      ...(extras?.failureSignature !== undefined
        ? { failureSignature: extras.failureSignature }
        : {}),
    })
  }

  /**
   * Park a task in `'awaiting-human'` with an operator-owned worktree lease
   * (ADR-0052 sole-writer). The pipeline resumes when the lease is released
   * (see `releaseLease`). Compatible with ADR-0063 (no-attach): the human
   * opens their own interactive session; the daemon never attaches to a running
   * pty. No managed subprocess — the phantom watchdog MUST NOT sweep this task.
   *
   * Raises an `'awaiting-human'` action-queue item so the operator can see the
   * parked task and its lease state. The item is level-triggered (ADR-0048):
   * re-detection on an expired lease bumps `seen_count` rather than spawning a
   * sibling row.
   */
  async parkForHuman(
    taskId: string,
    options: {
      leaseOwner: string
      leaseNote?: string | null
      stepName?: string | null
      stepGuide?: string | null
    },
  ): Promise<void> {
    const now = new Date().toISOString()
    await updateTask(taskId, {
      status: 'awaiting-human',
      leaseOwner: options.leaseOwner,
      leasedAt: now,
      leaseNote: options.leaseNote ?? null,
      currentStepName: options.stepName ?? null,
      currentStepGuide: options.stepGuide ?? null,
    })
    await raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'daemon',
      priority: 'normal',
      title: `Task ${taskId} parked — awaiting human`,
      body:
        options.stepGuide ??
        `Task ${taskId} is parked in its worktree. ` +
        `Lease holder: ${options.leaseOwner}. ` +
        `Work in the worktree interactively, then release the lease to resume the pipeline.` +
        (options.leaseNote ? ` Note: ${options.leaseNote}` : ''),
      payload: {
        taskId,
        leaseOwner: options.leaseOwner,
        leasedAt: now,
        leaseNote: options.leaseNote ?? null,
      },
      context: { taskId },
      raisedBy: 'arc:park-for-human',
      signature: taskId,
      originTaskId: taskId,
      occurrence: {
        leaseOwner: options.leaseOwner,
        leasedAt: now,
        parkedAt: now,
      },
    }).catch(() => {
      // Non-fatal: task is already parked and the action-queue write failed.
      // The task row itself reflects the parked state; the operator can still
      // discover it via list/status.
    })
  }

  /**
   * Release the worktree lease on an `'awaiting-human'` task and re-queue it
   * for pipeline continuation (ADR-0052 sole-writer).
   *
   * Default (`mars release`): clears all lease fields — the human is done
   * with this task. With `keepLease` (`mars step done`): the lease identity
   * survives the continuation, so when the pipeline parks at the task's NEXT
   * manual step, `awaitHuman` re-grants the lease to the same owner and the
   * Foreground session walks the runbook without re-attaching.
   *
   * Throws if the task is not currently in `'awaiting-human'`.
   */
  async releaseLease(
    taskId: string,
    opts?: { keepLease?: boolean },
  ): Promise<void> {
    const task = await getTask(taskId)
    if (!task) throw new Error(`task ${taskId} not found`)
    if (task.status !== 'awaiting-human') {
      throw new Error(
        `task ${taskId} is in status '${task.status}'; can only release a lease on an 'awaiting-human' task`,
      )
    }
    await updateTask(taskId, {
      status: 'queued',
      ...(opts?.keepLease
        ? {}
        : { leaseOwner: null, leasedAt: null, leaseNote: null }),
    })
  }

  /**
   * Reprioritize a pre-dispatch or blocked task (ADR-0052 sole-writer).
   * Relocated from `queue.ts:setTaskPriority`: the priority `UPDATE tasks SET
   * priority = …, updated_at = …` is a non-lifecycle column write (no status
   * change, no outbox event), but it must still live behind the Arc aggregate
   * so the task table has exactly one writer (ADR-0052) — `setTaskPriority` in
   * queue.ts is now a thin wrapper that delegates here.
   *
   * Priority is a dispatch-ordering attribute: it is read when a task becomes
   * eligible to dispatch, so setting it on `'draft'`, `'triaging'`, or
   * `'blocked'` tasks is meaningful and harmless — the value takes effect the
   * moment the task becomes `'queued'`. Terminal states (`'done'`, `'failed'`,
   * `'dropped'`) and in-flight states (`'running'`, `'verifying'`, `'merging'`,
   * etc.) are rejected with a state-specific message. Returns the re-selected
   * {@link Task}.
   */
  async reprioritize(priority: number): Promise<Task> {
    validatePriority(priority)
    await ensureQueueSchema()
    const id = this.arcId
    const s = this.store
    const before = await s.execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [id],
    })
    if (before.rows.length === 0) {
      throw new Error(`task ${id} not found`)
    }
    const status = (before.rows[0] as unknown as { status: string }).status
    const TERMINAL = ['done', 'failed', 'dropped']
    const IN_FLIGHT = [
      'running',
      'verifying',
      'merging',
      'awaiting-validation',
      'awaiting-human',
      'vega-reconciling',
      'under_investigation',
    ]
    if (TERMINAL.includes(status)) {
      throw new Error(
        `task ${id} is ${status}; priority has no effect on terminal tasks`,
      )
    }
    if (IN_FLIGHT.includes(status)) {
      throw new Error(
        `task ${id} is ${status}; priority cannot be changed while the task is in-flight`,
      )
    }
    // Allowed: draft, triaging, queued, blocked
    const now = new Date().toISOString()
    await s.execute({
      sql: `UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`,
      args: [priority, now, id],
    })
    await Arc.maybeAssertArcInvariant(id, s)
    const r = await s.execute({
      sql: `${TASK_SEL} WHERE t.id = ?`,
      args: [id],
    })
    return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
  }

  /**
   * Reflection-task insert (ADR-0052). Writes a single self-arc reflection row
   * (`origin_id = self`, status `'done'`) capturing a `mars reflect` run over
   * `corpusSize` task(s). Returns the new task id. Routed through the Arc
   * aggregate so the reflect arc is created by the same write funnel as every
   * other origin; the `origin_id = self` semantics are preserved.
   */
  async insertReflection(corpusSize: number): Promise<string> {
    await ensureQueueSchema()
    const id = `reflect-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const prompt = `mars reflect run over ${corpusSize} task(s) at ${now}`
    await this.store.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)`,
      args: [id, prompt, id, now, now],
    })
    await Arc.maybeAssertArcInvariant(id, this.store)
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
   * Every regular-task failure spawns a fix, even with no registered recipe
   * (ADR: uniform failure→fix spawn, supersedes ADR-0002). The signature is
   * resolved via `getRecipeOrGeneric`, which falls back to the
   * signature-agnostic generic recovery recipe when none is registered — so
   * an unknown signature no longer dead-ends, it recovers from first
   * principles. `getRecipeOrGeneric` never throws.
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

    const recipe = getRecipeOrGeneric(input.failureSignature)
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
    const blockerCreatedAt = Date.now()

    if (existingId) {
      // Attach this source to the existing fix-task and park it.
      await s.batch(
        [
          {
            sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at)
                VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            args: [input.sourceTaskId, existingId, blockerCreatedAt],
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
      await Arc.maybeAssertArcInvariant(input.sourceTaskId, s)
      return { fixTaskId: existingId, created: false }
    }

    // Inline the source task's prompt so recipes that re-do the original
    // work (e.g. verify:has-diff/no-commits-ahead) don't burn turns
    // re-fetching it from the database. Handlers should already set
    // `originalPrompt`; backfill from the source row if a direct caller
    // forgot. Default to '' only when the source genuinely has no prompt.
    const incomingPrompt = input.recipeContext.originalPrompt
    const recipeContextWithSource: FixRecipeContext = {
      ...input.recipeContext,
      // Thread the failure signature into the context so the generic recipe
      // can branch on gate failures (verify: prefix) vs work failures without
      // resorting to statusOutput heuristics.
      failureSignature: input.failureSignature,
      originalPrompt:
        incomingPrompt && incomingPrompt.trim().length > 0
          ? incomingPrompt
          : source.prompt ?? '',
    }
    const basePrompt = recipe.buildPrompt(recipeContextWithSource)
    // Append the optional QA note verbatim under a ## QA note heading so
    // the recovery agent sees the operator's feedback from `mars release
    // --abort --note '<text>'` without having to query the database.
    const prompt =
      input.qaNote && input.qaNote.trim().length > 0
        ? `${basePrompt}\n\n## QA note\n\n${input.qaNote}\n`
        : basePrompt
    const fixTaskId = `fix-${randomUUID().slice(0, 8)}`
    // All recovery tasks run at top priority — recovery resumes already-started
    // work and should preempt fresh queued tasks. Shared recipes additionally
    // reuse a single in-flight fix-task across multiple sources (e.g. a clean
    // main blocks everyone); that deduplication behaviour is orthogonal to the
    // priority and is unchanged.
    const fixPriority = MAX_PRIORITY

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
          sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at)
              VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [input.sourceTaskId, fixTaskId, blockerCreatedAt],
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
          args: [
            input.sourceTaskId,
            input.failureSignature,
            fixTaskId,
            blockerCreatedAt,
          ],
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
    hintDispatch(fixTaskId, 'implement')

    await Arc.maybeAssertArcInvariant(input.sourceTaskId, s)
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
   * (`ON CONFLICT DO NOTHING` on the edge).
   */
  async attachToRecovery(input: AttachToExistingFixTaskInput): Promise<void> {
    const s = this.store
    const source = await getTask(input.sourceTaskId, s)
    if (!source) {
      throw new Error(`source task ${input.sourceTaskId} not found`)
    }
    const now = new Date().toISOString()
    const blockerCreatedAt = Date.now()
    const truncatedError = truncate(input.errorSummary, 1000)
    await s.batch(
      [
        {
          // F.1 exemption: this insert reaches `task_blockers` directly because
          // the legitimate origin → recovery edge writer (`spawnRecovery`) is
          // the documented bypass of the ADR-0040 guard, and this helper is its
          // dedup sibling. See ADR-0040 clarification: the origin → recovery
          // edge is the canonical attach mechanism.
          sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
                VALUES (?, ?, 'confirmed', ?) ON CONFLICT DO NOTHING`,
          args: [input.sourceTaskId, input.fixTaskId, blockerCreatedAt],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                   SET updated_at = ?,
                       status = 'blocked',
                       error = ?,
                       failure_reason = NULL,
                       failure_reason_code = NULL,
                       failure_signature = NULL
                 WHERE id = ?`,
          args: [
            now,
            truncatedError,
            input.sourceTaskId,
          ],
        },
        // Durable task.blocked in the same atomic batch (ADR-0030).
        buildEventInsert('task.blocked', {
          taskId: input.sourceTaskId,
          fixTaskId: input.fixTaskId,
          failureSignature: VERIFY_MAIN_DIRTY_CODE,
          failingStep: 'dispatch:main-dirty',
          originId: source.originId,
        }),
      ],
      'write',
    )
    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId: input.fixTaskId,
      failureSignature: VERIFY_MAIN_DIRTY_CODE,
      failingStep: 'dispatch:main-dirty',
      originId: source.originId,
    })
    await Arc.maybeAssertArcInvariant(input.sourceTaskId, s)
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
   *   2. Insert (ON CONFLICT DO NOTHING) the origin → recovery `task_blockers` edge
   *      (`state='confirmed'`) — the F.1 ADR-0040 leaf-node exemption mirror;
   *   3. UPDATE the source to `status='blocked'`, writing its readable
   *      `error` and clearing all failure metadata
   *      (updated_at first — exempt from the STATUS_WRITE arch guard);
   *   4. the durable `task.blocked` outbox event.
   *
   * PARITY (preserved bit-for-bit):
   *   - a single `now` timestamp threaded through every statement;
   *   - a fresh `fix-${randomUUID().slice(0, 8)}` fix-task id per call;
   *   - `recovery_payload` IS written (unlike {@link Arc.spawnRecovery}, which
   *     leaves it NULL — the two writers coexist);
   *   - NO `self_heal_attempts` ledger append (intentional, slice F.2 — the
   *     branch-keyed singleton (ADR-0071), not the per-(parent,signature) cap,
   *     governs committer identity);
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
    integrationBranch: string
    dispatchPhase: 'dispatch' | 'verify' | 'merge'
    recipePrompt: string
    sourceOriginId: string
    traceStore: TraceEventStore
  }): Promise<{ fixTaskId: string }> {
    const s = this.store
    const fixTaskId = `fix-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const blockerCreatedAt = Date.now()
    const payload: MainCommiterPayload = {
      recipe: MAIN_COMMITER_RECIPE,
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
          sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
              VALUES (?, ?, 'confirmed', ?) ON CONFLICT DO NOTHING`,
          args: [input.sourceTaskId, fixTaskId, blockerCreatedAt],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                 SET updated_at = ?,
                     status = 'blocked',
                     error = ?,
                     failure_reason = NULL,
                     failure_reason_code = NULL,
                     failure_signature = NULL
               WHERE id = ?`,
          args: [
            now,
            SOURCE_ERROR_SUMMARY(input.integrationBranch, input.dispatchPhase),
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
        phase: input.dispatchPhase === 'verify' ? 'verify' : input.dispatchPhase === 'merge' ? 'merge' : 'setup',
        payload: {
          recipe: MAIN_COMMITER_RECIPE,
          sourceTaskId: input.sourceTaskId,
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
    hintDispatch(fixTaskId, 'implement')

    await Arc.maybeAssertArcInvariant(input.sourceTaskId, s)
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
    options?: { provenance?: 'file-overlap' | 'inferred' },
  ): Promise<void> {
    if (blockerIds.length === 0) return
    await ensureQueueSchema()
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
    await s.batch(stmts, 'write')
    await Arc.maybeAssertArcInvariant(taskId, s)
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
    await ensureQueueSchema()
    const r = await this.store.execute({
      sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
      args: [taskId, blockerId],
    })
    return { removed: r.rowsAffected > 0 }
  }

  /**
   * Remove all outbound blocker edges for `taskId` (ADR-0052). Used by
   * terminal-transition paths (`markTaskDropped`, `markTaskFailed`) to clear
   * the task's dependent edges before or after the status flip. Status is
   * unchanged; callers update status separately via `updateTask`.
   */
  async clearBlockers(taskId: string): Promise<void> {
    await ensureQueueSchema()
    await this.store.execute({
      sql: `DELETE FROM task_blockers WHERE task_id = ?`,
      args: [taskId],
    })
  }

  /**
   * Write Linker-candidate blocker rows in `'pending-review'` state (ADR-0052,
   * ADR-0006). The Linker is the sole *deriver* of lexical-overlap edges; this
   * Arc method is the sole *writer*, so Arc remains the only code that runs SQL
   * against `task_blockers`. Mirrors {@link addBlocker} but stamps
   * `state='pending-review'` so the dispatcher gates on the row before the
   * operator confirms it.
   */
  async addPendingReviewBlockers(
    taskId: string,
    blockerIds: readonly string[],
  ): Promise<void> {
    if (blockerIds.length === 0) return
    await ensureQueueSchema()
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
    // ADR-0040 leaf-node guard: even pending-review Linker rows are subject to
    // the recovery leaf rule. A recovery task is never the candidate of a
    // keyword-overlap edge.
    for (const blockerId of unique) {
      await assertNotRecoveryEdge(taskId, blockerId, { client: s })
    }
    const now = Date.now()
    const stmts = unique.map((blockerId) => ({
      sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'pending-review', ?) ON CONFLICT DO NOTHING`,
      args: [taskId, blockerId, now],
    }))
    await s.batch(stmts, 'write')
  }

  /**
   * ADR-0015 promote-transfer, executed as a single write batch (ADR-0052).
   * For every task in `dependents` blocked by `proposalId` in
   * `task_proposal_blockers`, atomically deletes that proposal-blocker row and
   * inserts a `'confirmed'` `task_blockers` row pointing at `newBlockerTaskId`,
   * preserving the never-observably-zero-blockers invariant via
   * insert-before-delete ordering within the batch.
   *
   * Static: this operation spans multiple task IDs so no single Arc instance
   * owns it. Uses the process-wide default store.
   */
  static async transferProposalEdges(
    dependents: string[],
    newBlockerTaskId: string,
    proposalId: string,
  ): Promise<{ transferred: string[] }> {
    if (dependents.length === 0) return { transferred: [] }
    const store = getDefaultDomainTaskStore()
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
      // mirroring addBlocker.
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
  async drop(opts?: { releaseOrphanedDependents?: boolean }): Promise<DropTaskResult> {
    await ensureQueueSchema()
    const id = this.arcId

    // Belt-and-suspenders: close action-queue rows for this task and its
    // cascaded fix tasks inline, before the task row is deleted. The primary
    // path is event-driven: drop() emits task.dropped in the same atomic tx
    // as DELETE FROM tasks (below), and the Invalidator drains that event to
    // resolve open rows (ADR-0027/0030). This inline call ensures stale cards
    // clear immediately even if the daemon's event drain has not run yet.
    // supersedeActionQueueItemsForOrigin uses the arc fingerprint so it also
    // covers cascaded fix tasks that share the same origin_id as this task.
    // Both calls are idempotent with the event-based closures (a row already
    // resolved is a silent no-op).
    await resolveAllRowsForTask(id)
    await supersedeActionQueueItemsForOrigin(id, 'origin-dropped', 'drop:pre-delete')

    // Populated inside the atomic; consumed after so the action-queue raise
    // remains best-effort and is intentionally separated from the DB transaction.
    const orphanedDeps: { depId: string; originId: string }[] = []

    // Accumulates the count of merge_jobs rows deleted across the origin task
    // and any cascade-deleted fix tasks. Initialised outside the atomic so the
    // return value type is DropTaskResult (not the Awaited<> of the closure).
    let mergeJobsDeleted = 0

    const result = await this.store.atomic(async (scope) => {
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
      // Pre-pass: any blocked dependent whose origin_id === id (the purged
      // task) is an orphan — its arc root is being deleted. Fail it inline
      // rather than re-queueing it, so the operator gets one action-queue
      // item and a coder is never dispatched against a vanished target.
      // Self-origin dependents (origin_id === dep.id) are arc roots and
      // follow the normal re-queue path (ADR-0040).
      const orphanedDepIds = new Set<string>()
      const failNow = new Date().toISOString()
      for (const depId of dependentIds) {
        const depRow = await scope.execute({
          sql: `SELECT origin_id FROM tasks WHERE id = ? AND status = 'blocked'`,
          args: [depId],
        })
        if (depRow.rows.length === 0) continue
        const originId = (depRow.rows[0] as unknown as { origin_id: string | null }).origin_id
        // Not orphaned: NULL origin (treat as self), self-origin, or origin ≠ purged task.
        if (
          opts?.releaseOrphanedDependents ||
          !originId ||
          originId === depId ||
          originId !== id
        ) continue
        // Orphaned: remove the blocker edge, mark failed, emit terminal events,
        // and clear remaining outbound edges (mirrors markTaskFailed/clearBlockers).
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
          args: [depId, id],
        })
        await scope.execute({
          sql: `UPDATE tasks SET updated_at = ?, status = 'failed', failure_reason = ? WHERE id = ? AND status = 'blocked'`,
          args: [failNow, ORPHANED_ORIGIN_FAILURE_REASON, depId],
        })
        await scope.execute(
          buildEventInsert('task.failed', {
            taskId: depId,
            error: ORPHANED_ORIGIN_FAILURE_REASON,
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', { taskId: depId, reason: 'failed' }),
        )
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ?`,
          args: [depId],
        })
        orphanedDepIds.add(depId)
        orphanedDeps.push({ depId, originId: id })
      }
      const releaseNow = new Date().toISOString()
      for (const depId of dependentIds) {
        // Already failed as an orphaned dependent — skip the re-queue path.
        if (orphanedDepIds.has(depId)) continue
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
      // task row is deleted so the FK constraint never fires. The execute is
      // safe because ensureQueueSchema() runs at the top of drop() and will
      // have created the table before we reach this point.
      await scope.execute({
        sql: `DELETE FROM questions WHERE task_id = ?`,
        args: [id],
      })
      // Null out fix_for_task_id pointers in both directions:
      //   (a) rows pointing AT the victim — prevents the self-referential FK on
      //       tasks.fix_for_task_id from blocking the origin DELETE when a fix
      //       task still exists in the table (e.g. if its own DELETE failed).
      //   (b) the victim's own pointer — belt-and-suspenders for fix tasks
      //       dropped directly; no-op for origin tasks (already NULL).
      // These UPDATEs are idempotent and safe regardless of which direction
      // the caller is purging (fix→origin or origin→fix cascade).
      await scope.execute({
        sql: `UPDATE tasks SET fix_for_task_id = NULL WHERE fix_for_task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `UPDATE tasks SET fix_for_task_id = NULL WHERE id = ?`,
        args: [id],
      })
      // Explicit deletes for every junction table whose FK to tasks(id) lacks
      // ON DELETE CASCADE on older DB snapshots (CREATE TABLE IF NOT EXISTS
      // never rebuilds an existing table, so the CASCADE may be absent).
      // Belt-and-suspenders even on up-to-date schemas where CASCADE fires
      // automatically — an explicit DELETE is idempotent.
      await scope.execute({
        sql: `DELETE FROM task_acceptance WHERE task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `DELETE FROM task_claude_sessions WHERE task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `DELETE FROM task_spec_files WHERE task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `DELETE FROM task_done_criteria WHERE task_id = ?`,
        args: [id],
      })
      // task_progress has a FK on task_id → tasks(id) without ON DELETE CASCADE
      // on older schemas (CREATE TABLE IF NOT EXISTS never rebuilds an existing
      // table). Explicit delete guards against FK violations on pre-migration DBs.
      await scope.execute({
        sql: `DELETE FROM task_progress WHERE task_id = ?`,
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
        // Explicit child-table cleanup for each fix task — mirrors the origin
        // cleanup above so the DELETE FROM tasks below never hits a stale FK.
        await scope.execute({
          sql: `DELETE FROM task_acceptance WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_claude_sessions WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_spec_files WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_done_criteria WHERE task_id = ?`,
          args: [fixId],
        })
        // task_progress FK guard — mirrors the origin cleanup above.
        await scope.execute({
          sql: `DELETE FROM task_progress WHERE task_id = ?`,
          args: [fixId],
        })
        // self_heal_attempts.fix_task_id has ON DELETE CASCADE (post-migration)
        // but an explicit delete guards against pre-migration schemas.
        await scope.execute({
          sql: `DELETE FROM self_heal_attempts WHERE fix_task_id = ?`,
          args: [fixId],
        })
        // merge_jobs.task_id has no ON DELETE CASCADE — explicit delete required
        // before the tasks row disappears or the FK fires (same class of bug as
        // task_progress above). Count is accumulated into mergeJobsDeleted below.
        const fixMergeJobsDel = await scope.execute({
          sql: `DELETE FROM merge_jobs WHERE task_id = ?`,
          args: [fixId],
        })
        mergeJobsDeleted += Number(fixMergeJobsDel.rowsAffected ?? 0)
        await scope.execute({
          sql: `DELETE FROM tasks WHERE id = ?`,
          args: [fixId],
        })
      }

      // merge_jobs.task_id has no ON DELETE CASCADE — delete before the tasks
      // row is removed. Explicit delete keeps cleanup visible in the summary
      // line ("merge-jobs=N") and avoids silently discarding merge history on
      // future delete paths that should not cascade.
      const originMergeJobsDel = await scope.execute({
        sql: `DELETE FROM merge_jobs WHERE task_id = ?`,
        args: [id],
      })
      mergeJobsDeleted += Number(originMergeJobsDel.rowsAffected ?? 0)

      await scope.execute({
        sql: `DELETE FROM tasks WHERE id = ?`,
        args: [id],
      })

      return {
        taskId: id,
        previousStatus,
        edgesRemoved: { incoming: incomingCount, outgoing: outgoingCount },
        cascadedFixTaskIds,
        mergeJobsDeleted,
      }
    })

    // Best-effort: push one action-queue item per orphaned dependent so the
    // operator is notified. This intentionally runs AFTER the atomic so a
    // transient action-queue failure never rolls back the drop itself.
    for (const { depId, originId } of orphanedDeps) {
      await raiseOrphanedOriginActionQueue(depId, originId).catch(() => {
        /* best-effort — action-queue failure must not surface to the caller */
      })
    }

    return result
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
    dropReason: TaskDropReason,
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
    dropReason: TaskDropReason,
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
   * SETTLES — reaches `done` or `dropped`, see
   * {@link SETTLED_BLOCKER_STATUSES} — look up every task that has it listed
   * as a blocker in `task_blockers` and transition each from `blocked` ->
   * `queued`. A dependent only flips if every one of its blockers has settled.
   *
   * "Completion" here means the blocker's lifecycle completed WITHOUT failing:
   * `dropped` is as final as `done` and can never become `done`, so a
   * dependent left waiting on it is stranded permanently. `failed` is NOT
   * settled and is not routed here — a failed blocker keeps its dependents in
   * `blocked` for operator resolution (the failure does not cascade).
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
    // The verdict branch only owns a diagnose Chore that actually SUCCEEDED —
    // a dropped diagnose Chore produced no verdict to act on, so it falls
    // through to the ordinary settlement loop below (which releases the
    // parent instead of consulting a verdict that does not exist).
    const completingTask = await getTask(blockerTaskId)
    if (completingTask?.kind === 'diagnose' && completingTask.status === 'done') {
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

    const outcomes: UnblockOutcome[] = []
    const integrationBranch = integrationBranchName()

    for (const row of r.rows as unknown as BlockedDependentRow[]) {
      const retryCount = Number(row.retry_count ?? 0)
      // An unblocked dependent always proceeds to re-dispatch, regardless of
      // retry_count. (No retry-budget gate: it used to fail eligible
      // dependents at unblock time — mars-3d63fe52.)
      const incomplete = await store.query({
        sql: `SELECT 1
                FROM task_blockers b
                JOIN tasks t ON t.id = b.blocker_task_id
               WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
                 AND b.state IN ('confirmed', 'pending-review')
               LIMIT 1`,
        args: [row.id],
      })
      if (incomplete.rows.length > 0) {
        outcomes.push({ taskId: row.id, outcome: 'noop', retryCount })
        continue
      }
      // Fetch the dependent task once; the same row is used for both the
      // orphaned-origin guard below and the worktree-reset path further down.
      const dep = await getTask(row.id)
      // Guard: if the dependent's origin_id points at a different task that no
      // longer exists in the tasks table, fail it rather than re-dispatching a
      // coder against a vanished target.
      //
      // NOTE: origin_id intentionally has no FK and may hold proposal ids (or
      // other non-task arc identifiers) — tasks produced by `mars proposal
      // slice` carry origin_id = proposal_id. Check the proposals table before
      // declaring the origin orphaned; only fail when neither namespace owns
      // the id.
      if (dep?.originId && dep.originId !== dep.id) {
        const originTask = await getTask(dep.originId)
        if (!originTask) {
          const originProposal = await getProposal(dep.originId)
          if (!originProposal) {
            await raiseOrphanedOriginActionQueue(row.id, dep.originId)
            await markTaskFailed(row.id, ORPHANED_ORIGIN_FAILURE_REASON)
            outcomes.push({
              taskId: row.id,
              outcome: 'failed',
              retryCount,
              failureReason: ORPHANED_ORIGIN_FAILURE_REASON,
            })
            continue
          }
        }
      }
      // Reset the dependent's worktree to integration HEAD BEFORE flipping it
      // to 'queued' — if the reset is refused (commits ahead) the dependent must
      // never enter the dispatch queue.
      //
      // EXCEPT for a human-owned continuation: `mars step done` keeps the
      // lease identity on the row precisely to mark that a Foreground session
      // owns this worktree's commits — they ARE the work product, headed for
      // verify. Resetting would destroy human work; refusing would fail the
      // task for being in exactly the state the live loop puts it in.
      if (dep?.leaseOwner == null) {
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
   * Dead-recovery write funnel (ADR-0040 / ADR-0052 sole-writer). When a
   * recovery Chore lands `failed`, the ORIGIN it was spawned for must land
   * `failed` too — CLAUDE.md § Blockers: "A recovery task is itself
   * non-recoverable: if it fails for any reason … the origin goes to `failed`
   * with one actionable action queue item and the operator resolves it
   * explicitly (e.g. `mars restart`)."
   *
   * Without this the origin sat in `blocked` forever, waiting on the one
   * blocker edge that can never reach `done` (a recovery Chore is a leaf and is
   * never re-run). `blocked` is not terminal, so `mars purge` and `mars
   * restart` both refuse it: the arc was unrecoverable without raw SQL.
   *
   * Scope — the origin↔its-own-recovery edge ONLY:
   *  - the completing task must be a recovery (`fix_for_task_id` set) that is
   *    actually `failed`; anything else is a no-op;
   *  - only the recovery's own origin (`fix_for_task_id`) is failed, and only
   *    while it is still `blocked`. Other dependents of the recovery — and the
   *    origin's own dependents — are untouched. The failure does NOT cascade
   *    down the chain; a failed blocker leaving its dependents waiting in
   *    `blocked` is existing intended behaviour.
   *
   * Excluded — `main-commiter` recoveries. A main-committer does NOT carry the
   * origin's work; it cleans the integration branch. Its failure keeps the
   * source parked behind its failed committer and raises an aggregated operator
   * alert; a later dirty episode reparents the cohort onto a fresh committer.
   *
   * Escalation is NOT raised here: `handleTaskFailureWithFixTask` already
   * raises the origin-keyed `Fix and retry <recovery>, or abandon <origin>` row
   * (and the repopulator's origin-fingerprint dedup bumps `seen_count` rather
   * than inserting a second row when the origin's own `task.failed` lands).
   * Only the status transition was missing.
   *
   * Idempotent: the transition is guarded on `status = 'blocked'`, so a replay
   * (or the startup reconcile sweep running over an already-repaired row)
   * reports `noop`.
   */
  static async failStrandedOriginOnRecoveryFailure(
    recoveryTaskId: string,
  ): Promise<FailStrandedOriginResult> {
    const outcomes: FailStrandedOriginOutcome[] = []

    const recovery = await getTask(recoveryTaskId)
    // Only a genuinely failed recovery Chore strands an origin. A recovery that
    // is still running, or that reached `done`, is handled by the ordinary
    // unblock-by-completion path.
    if (!recovery || recovery.fixForTaskId === null || recovery.status !== 'failed') {
      return { recoveryTaskId, outcomes }
    }

    // Main-committers are branch janitors, not carriers of the origin's work —
    // their failure is released, not propagated. See the docblock.
    if (parseMainCommiterPayload(recovery.recoveryPayload)?.recipe === MAIN_COMMITER_RECIPE) {
      return { recoveryTaskId, outcomes }
    }

    const originId = recovery.fixForTaskId
    const origin = await getTask(originId)
    // `blocked` is the only state this repair owns. An origin that already
    // reached a terminal state (or was restarted back into the queue) is not
    // stranded, and the terminal-transition trigger would reject the write.
    if (!origin || origin.status !== 'blocked') {
      outcomes.push({ originTaskId: originId, recoveryTaskId, outcome: 'noop' })
      return { recoveryTaskId, outcomes }
    }

    // Route through the audited terminal seam: `markTaskFailed` -> `updateTask`
    // (the single validated status chokepoint, which also emits the paired
    // `task.failed` + `task.terminal` events), then clears the origin's now-dead
    // outbound blocker edges and blocks any QUEUED downstreams. `blocked` is not
    // terminal, so the `reject_terminal_task_transition` trigger permits it.
    await markTaskFailed(
      originId,
      composeOriginRecoveryFailedReason(recoveryTaskId),
      recovery.failureSignature ?? recovery.failureReasonCode ?? null,
    )
    outcomes.push({ originTaskId: originId, recoveryTaskId, outcome: 'failed' })
    return { recoveryTaskId, outcomes }
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
      // Route the terminal flip through the Arc.transition funnel (ADR-0052):
      // the one status funnel, wrapping updateTask. The patch is preserved
      // bit-for-bit — transition maps failureReason/failureReasonCode/
      // failureSignature straight onto updateTask's columns.
      await Arc.load(row.id).transition(row.id, 'failed', {
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
    const store = await getDefaultTaskStore()

    // A task whose blockers have all resolved always proceeds to re-dispatch,
    // regardless of retry_count. (No retry-budget gate: it used to fail
    // eligible dependents at unblock time — mars-3d63fe52.)
    const now = new Date().toISOString()

    // Any confirmed/pending-review blocker edge whose blocker has not settled
    // (SETTLED_BLOCKER_STATUSES: done or dropped)? This is also the boot-time
    // heal for rows already stranded behind a `dropped` blocker: the
    // `orphaned-blocked-scan` reconciler drives every `blocked` row through
    // here via Arc.recoverAllBlocked on each daemon start.
    const incomplete = await store.query({
      sql: `SELECT 1
              FROM task_blockers b
              JOIN tasks t ON t.id = b.blocker_task_id
             WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
               AND b.state IN ('confirmed', 'pending-review')
             LIMIT 1`,
      args: [taskId],
    })
    if (incomplete.rows.length > 0) {
      // Extra lookup for the presentation layer: classify each unsettled blocker
      // as live (queued/running/blocked) or stranded (failed/MISSING).  We use
      // a LEFT JOIN so deleted blockers appear with status 'MISSING' — the
      // operator can then distinguish "still in progress" from "needs rescue".
      const blockerRows = await store.query({
        sql: `SELECT b.blocker_task_id AS blocker_id,
                     COALESCE(t.status, 'MISSING') AS status
                FROM task_blockers b
                LEFT JOIN tasks t ON t.id = b.blocker_task_id
               WHERE b.task_id = ? AND b.state IN ('confirmed', 'pending-review')
                 AND (t.id IS NULL OR ${UNSETTLED_BLOCKER_SQL})`,
        args: [taskId],
      })
      const blockerStatuses = (
        blockerRows.rows as unknown as Array<{ blocker_id: string; status: string }>
      ).map((r) => ({ blockerId: r.blocker_id, status: r.status }))
      return { taskId, outcome: 'noop', retryCount, blockerStatuses }
    }

    // Reset the dependent's worktree to integration HEAD before re-dispatching.
    // Skipped for a human-owned continuation (`mars step done` keeps the lease
    // identity): its commits ahead ARE the work product, headed for verify —
    // see the identical guard in the sweep above.
    const integrationBranch = integrationBranchName()
    if (task.leaseOwner == null) {
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
   * Missed-success main-committer completion repair (ADR-0052 sole-writer).
   *
   * After a committer reaches SUCCESS, release every task currently `blocked` solely because
   * of `committerTaskId`: per dependent, in ONE atomic transaction, delete the
   * completed committer's `task_blockers` edge then flip the dependent `blocked` ->
   * `queued` only when no other non-terminal blocker remains, emitting
   * `task.unblocked` in the same commit (ADR-0030). The driving SELECT, the
   * `internalBus().emit` wake-hints, and the per-row logging stay OUTSIDE the
   * atomic (best-effort), exactly as the historic helper structured them.
   *
   * This method is deliberately a reconciliation seam only. Failed committers
   * retain their blocker edges so a fresh dirty-main episode can reparent them.
   *
   * Returns `{ released }` (count of dependents re-queued) so the caller can
   * log the same `released/total` summary it logged before.
   */
  static async releaseMainCommitterDependentsAfterSuccess(
    committerTaskId: string,
    log: (msg: string) => void,
  ): Promise<{ released: number; total: number }> {
    const s = await getDefaultTaskStore()
    const now = new Date().toISOString()

    // Find all tasks currently `blocked` on this committer.
    const r = await s.query({
      sql: `SELECT t.id AS id
              FROM task_blockers tb
              JOIN tasks t ON t.id = tb.task_id
             WHERE tb.blocker_task_id = ?
               AND t.status = 'blocked'`,
      args: [committerTaskId],
    })

    const dependents = r.rows as unknown as Array<{ id: string }>
    if (dependents.length === 0) return { released: 0, total: 0 }

    let released = 0

    for (const row of dependents) {
      const flipped = await s.atomic(async (scope) => {
        // Remove the dead committer's blocker edge. Within this transaction the
        // deletion is immediately visible to the subquery in the UPDATE below.
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
          args: [row.id, committerTaskId],
        })
        // Re-queue only when no other non-terminal blocker still exists. This
        // release path is deliberately wider than UNSETTLED_BLOCKER_SQL: a
        // dead committer's siblings are being rescued, so `failed` blockers
        // are ignored here too. `dropped` belongs in the same list for the
        // same reason it belongs in SETTLED_BLOCKER_STATUSES — it is terminal
        // and can never reach `done`.
        // updated_at precedes status in the SET clause — the conditional WHERE
        // cannot be expressed through setTaskStatus; the task.unblocked event is
        // emitted atomically in the same transaction (ADR-0030).
        const upd = await scope.execute({
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ? AND status = 'blocked'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM task_blockers b
                       JOIN tasks t2 ON t2.id = b.blocker_task_id
                      WHERE b.task_id = ?
                        AND t2.status NOT IN ('done', 'failed', 'dropped')
                        AND b.state IN ('confirmed', 'pending-review')
                   )`,
          args: [now, row.id, row.id],
        })
        const didFlip = (upd.rowsAffected ?? 0) > 0
        if (didFlip) {
          await scope.execute(
            buildEventInsert('task.unblocked', {
              taskId: row.id,
              blockerTaskId: committerTaskId,
            }),
          )
        }
        return didFlip
      })
      if (flipped) {
        internalBus().emit('task.unblocked', {
          taskId: row.id,
          blockerTaskId: committerTaskId,
        })
        released++
        log(
          `[main-dirty] re-queued task ${row.id} released after successful committer ${committerTaskId}`,
        )
      } else {
        log(
          `[main-dirty] task ${row.id}: successful committer edge removed but other active blockers remain; left blocked`,
        )
      }
    }

    log(
      `[main-dirty] released ${released}/${dependents.length} dependent(s) after successful committer ${committerTaskId}`,
    )
    return { released, total: dependents.length }
  }

  /**
   * Re-parent stranded dependents from prior failed main-committers onto a
   * freshly-spawned committer (ADR-0040 leaf-node exemption, slice F.3).
   *
   * When a main-committer fails, its tasks remain parked on its blocker edge.
   * When a new dirty episode spawns a replacement, this method collects every
   * task still `blocked` on the failed committer and:
   *
   * 1. Inserts `task_blockers(task_id=stranded, blocker_task_id=newCommitterId,
   *    state='confirmed')` — ON CONFLICT DO NOTHING so it's idempotent.
   * 2. Deletes the old failed-committer edge so `unblockByCompletion` can
   *    release the stranded tasks when the new committer succeeds.
   *
   * Writes directly to `task_blockers` without calling `assertNotRecoveryEdge`,
   * mirroring the F.1 exemption used by `spawnMainCommitterRecovery`. The new
   * committer IS a recovery task (kind='fix'), but this edge is legitimate: it
   * is the continuation of the prior committer's responsibility.
   *
   * Returns `{ reparented: N }` where N is the count of unique stranded tasks
   * that received a new edge. Returns `{ reparented: 0 }` when none are found.
   */
  static async reparentStrandedDependentsOntoNewCommitter(
    newCommitterId: string,
    integrationBranch: string,
  ): Promise<{ reparented: number }> {
    const s = await getDefaultTaskStore()
    const now = Date.now()

    // Find all (stranded_task_id, failed_committer_id) pairs where the task is
    // still `blocked` on a prior FAILED main-committer for this integration branch.
    const r = await s.query({
      sql: `SELECT tb.task_id AS id, tb.blocker_task_id AS old_committer
              FROM task_blockers tb
              JOIN tasks failed ON failed.id = tb.blocker_task_id
              JOIN tasks dep    ON dep.id    = tb.task_id
             WHERE failed.kind = 'fix'
               AND failed.status = 'failed'
               AND (failed.recovery_payload::jsonb ->> 'recipe') = ?
               AND (failed.recovery_payload::jsonb ->> 'integrationBranch') = ?
               AND dep.status = 'blocked'`,
      args: [MAIN_COMMITER_RECIPE, integrationBranch],
    })

    const rows = r.rows as unknown as Array<{ id: string; old_committer: string }>
    if (rows.length === 0) return { reparented: 0 }

    // Collect unique task IDs (a task may have been blocked by multiple failed
    // committers; ON CONFLICT DO NOTHING handles the duplicate-insert case).
    const uniqueTaskIds = [...new Set(rows.map((row) => row.id))]

    // Batch: add new edge to new committer (idempotent) + delete each old
    // failed-committer edge so unblockByCompletion can release the task.
    const stmts = [
      ...uniqueTaskIds.map((taskId) => ({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?) ON CONFLICT DO NOTHING`,
        args: [taskId, newCommitterId, now],
      })),
      ...rows.map(({ id, old_committer }) => ({
        sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
        args: [id, old_committer],
      })),
    ]
    await s.batch(stmts, 'write')

    return { reparented: uniqueTaskIds.length }
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
   * Idempotent only for `done`: returns early when origin is already `done`.
   * For `failed` and `dropped` origins this function proceeds to reconcile
   * status to `done` — a successful recovery is authoritative regardless of
   * what the retry-budget guard previously stamped (fix: mars-f109e203 /
   * commit 834fdaa1 — late recovery success must resurrect its origin to done).
   * If the fixForTaskId points at a missing row the method is a no-op.
   *
   * CLAUDE.md contract: "a successful recovery counts as its origin
   * reaching done, so a recovered blocker unblocks the whole chain."
   *
   * PARITY: the two-tx structure is preserved bit-for-bit — first
   * {@link Arc.setTaskStatus} routes the status change + paired `task.completed`
   * event through the single-writer chokepoint, then a second `store.atomic`
   * clears `error = NULL` and emits `task.terminal`. The sole immutability
   * guard is the caller-side pre-check for `done` (the only true idempotent
   * case); Arc.setTaskStatus does NOT enforce terminal immutability (ADR-0052).
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
    if (origin.status === 'done') {
      // A completed origin is the only true idempotent case. A successful
      // recovery remains authoritative for origins previously marked failed
      // or dropped, so those statuses are reconciled to done below.
      return {
        originTaskId,
        originFlipped: false,
        unblock: null,
        actionQueueItemsClosed,
      }
    }
    // Route the status change and its paired event through the single-writer
    // chokepoint (Arc.setTaskStatus) so they commit atomically. We intentionally
    // reconcile 'failed' and 'dropped' origins to 'done' here — a successful
    // recovery shipping the work is the authoritative signal that the origin
    // reached done, regardless of what the retry-budget guard or any other
    // upstream writer previously stamped. Failed and dropped rows must first
    // cross the audited reopen seam so the database trigger permits the
    // terminal transition.
    const store = await getDefaultTaskStore()
    if (origin.status === 'failed' || origin.status === 'dropped') {
      await reopenTerminalTask(originTaskId, 'successful recovery', store)
    }
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
   * Assert the two Arc invariants for the Action `arcId` (ADR-0052). This is a
   * debug-assert seam: it issues two cheap SELECTs against the just-committed
   * state and throws {@link ArcInvariantError} if the aggregate produced a
   * stranded entity. It is invoked at the TAIL of every mutating Arc write
   * method (after the batch/atomic commit) but is GATED behind
   * `MARS_ARC_INVARIANT_CHECK === '1'` so production transaction latency is
   * untouched; the vitest setup sets the flag so the suite enforces it on every
   * arc-mutating test.
   *
   * INVARIANT A — *every Action has its own row*. Resolve the row for `arcId`.
   * A missing Action row means the aggregate's write did not persist (or was
   * partially committed) — a stranded Action. This is the strong, always-on half
   * of the invariant: the write method just claimed to create/mutate `arcId`, so
   * its row MUST exist post-commit.
   *
   * INVARIANT B — *a TASK-rooted Arc root is a non-recovery origin Action*. The
   * Arc root is the row whose `id === origin_id`. When the arc is self-rooted
   * (`origin_id === id`) OR `origin_id` resolves to a real `tasks` row, that root
   * MUST have `kind` in `('task', 'diagnose')` AND `fix_for_task_id IS NULL`: a
   * recovery (fix) row can never be an Arc root. The PK on `tasks.id` guarantees
   * uniqueness, so "exactly one origin Action" collapses to existence + kind.
   *
   * `origin_id` is deliberately NOT a foreign key (see queue.ts: "origin_id can
   * hold proposal IDs or other non-task arc identifiers; REFERENCES tasks(id)
   * would reject them"). A proposal-originated task carries `origin_id =
   * <proposalId>` — a row in the `proposals` table, not `tasks` — so an
   * `origin_id` that resolves to NO `tasks` row is a legitimate, documented
   * shape (a proposal-rooted / external-grouping arc), NOT a strand. INVARIANT B
   * therefore fires only when the root is a genuine task row; a non-task origin
   * pointer is a soft grouping key and carries no `kind` to check.
   *
   * {@link Arc.drop} is EXEMPT (it deletes the row, so post-commit the arcId no
   * longer resolves and INVARIANT A would always throw) — `drop` therefore does
   * NOT call this method.
   */
  private static async assertArcInvariant(
    arcId: string,
    store: DomainTaskStore,
  ): Promise<void> {
    // INVARIANT A: the Action's own row exists post-commit.
    const actionRes = await store.query({
      sql: `SELECT id, origin_id, kind FROM tasks WHERE id = ?`,
      args: [arcId],
    })
    if (actionRes.rows.length === 0) {
      throw new ArcInvariantError(`Action ${arcId} has no row`)
    }
    const actionRow = actionRes.rows[0] as unknown as {
      id: string
      origin_id: string | null
      kind: string | null
    }
    const oid = actionRow.origin_id ?? actionRow.id
    // INVARIANT B: only when origin_id names a real TASK row. A proposal-id /
    // external grouping origin (no tasks-row) is a documented non-FK shape, not
    // a strand — there is nothing in `tasks` to kind-check, so we skip silently.
    const rootRes = await store.query({
      sql: `SELECT kind, fix_for_task_id FROM tasks WHERE id = ?`,
      args: [oid],
    })
    if (rootRes.rows.length === 0) {
      return
    }
    const rootRow = rootRes.rows[0] as unknown as {
      kind: string | null
      fix_for_task_id: string | null
    }
    const rootKind = rootRow.kind ?? 'task'
    if (rootKind !== 'task' && rootKind !== 'diagnose') {
      throw new ArcInvariantError(
        `Arc root ${oid} (for Action ${arcId}) has kind='${rootKind}'; an Arc root must be kind 'task' or 'diagnose'`,
      )
    }
    if (rootRow.fix_for_task_id !== null) {
      throw new ArcInvariantError(
        `Arc root ${oid} (for Action ${arcId}) has fix_for_task_id='${rootRow.fix_for_task_id}'; a recovery row can never be an Arc root`,
      )
    }
  }

  /**
   * Run {@link Arc.assertArcInvariant} only when `MARS_ARC_INVARIANT_CHECK === '1'`.
   * Centralises the env gate so every call site is a single `await` and the
   * production tx path pays no SELECT round-trip.
   */
  private static async maybeAssertArcInvariant(
    arcId: string,
    store: DomainTaskStore,
  ): Promise<void> {
    if (process.env.MARS_ARC_INVARIANT_CHECK === '1') {
      await Arc.assertArcInvariant(arcId, store)
    }
  }

  /**
   * Append a journal entry to the progress journal for the given task.
   *
   * The Arc aggregate is the sole writer to task_progress (ADR-0052 extension).
   * Validates that the task exists; for 'check'/'uncheck' kinds, validates that
   * `criterionIndex` is a positive integer in range for the task's doneCriteria.
   *
   * @param params.criterionIndex 1-based index into the task's doneCriteria array.
   *   Required for 'check'/'uncheck'; must be omitted or null for 'note'.
   */
  static async appendProgress(
    params: AppendProgressParams,
    store?: DomainTaskStore,
  ): Promise<ProgressEntry> {
    await ensureQueueSchema()
    const resolvedStore = store ?? getDefaultDomainTaskStore()
    const task = await getTask(params.taskId, resolvedStore)
    if (!task) {
      throw new Error(`task ${params.taskId} not found`)
    }
    if (params.kind === 'check' || params.kind === 'uncheck') {
      const idx = params.criterionIndex
      if (idx === undefined || idx === null || !Number.isInteger(idx) || idx < 1) {
        throw new Error(
          `criterionIndex must be a positive integer for '${params.kind}'; got ${idx}`,
        )
      }
      const criteria = task.spec?.doneCriteria ?? []
      if (idx > criteria.length) {
        throw new Error(
          `criterionIndex ${idx} is out of range; task has ${criteria.length} done criteria`,
        )
      }
    }
    const id = `prog-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const body = params.body ?? ''
    const criterionIndex =
      params.kind === 'note' ? null : (params.criterionIndex ?? null)
    await resolvedStore.execute({
      sql: `INSERT INTO task_progress (id, task_id, created_at, author, kind, body, criterion_index)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, params.taskId, now, params.author, params.kind, body, criterionIndex],
    })
    return {
      id,
      taskId: params.taskId,
      createdAt: now,
      author: params.author,
      kind: params.kind,
      body,
      criterionIndex,
    }
  }

  /**
   * List journal entries for a task, ordered oldest→newest.
   *
   * @param opts.limit Maximum number of entries to return (default: unbounded).
   */
  static async listProgress(
    taskId: string,
    opts?: { limit?: number },
    store?: DomainTaskStore,
  ): Promise<ProgressEntry[]> {
    await ensureQueueSchema()
    const resolvedStore = store ?? getDefaultDomainTaskStore()
    const limitClause =
      opts?.limit !== undefined ? ` LIMIT ${Math.floor(opts.limit)}` : ''
    const r = await resolvedStore.query({
      sql: `SELECT id, task_id, created_at, author, kind, body, criterion_index
              FROM task_progress
             WHERE task_id = ?
             ORDER BY created_at ASC${limitClause}`,
      args: [taskId],
    })
    return r.rows.map((row) => {
      const rec = row as unknown as {
        id: string
        task_id: string
        created_at: number
        author: string
        kind: string
        body: string
        criterion_index: number | null
      }
      return {
        id: rec.id,
        taskId: rec.task_id,
        createdAt: rec.created_at,
        author: rec.author,
        kind: rec.kind as ProgressEntry['kind'],
        body: rec.body,
        criterionIndex: rec.criterion_index,
      }
    })
  }

  /**
   * Derive the current checklist state from a list of journal entries.
   *
   * State is computed as a fold: for each criterion_index the latest
   * 'check' or 'uncheck' entry wins. 'note' entries are ignored.
   *
   * @param entries Journal entries (any ordering; the fold picks the latest per index).
   * @param doneCriteria The ordered list of criteria from the task spec.
   * @returns One entry per criterion with its current checked state.
   */
  static deriveChecklist(
    entries: ProgressEntry[],
    doneCriteria: readonly string[],
  ): Array<{ criterion: string; checked: boolean }> {
    // Map from 1-based index → most recent entry timestamp
    const stateMap = new Map<number, { checked: boolean; createdAt: number }>()
    for (const entry of entries) {
      if (entry.kind !== 'check' && entry.kind !== 'uncheck') continue
      if (entry.criterionIndex === null) continue
      const existing = stateMap.get(entry.criterionIndex)
      if (existing === undefined || entry.createdAt >= existing.createdAt) {
        stateMap.set(entry.criterionIndex, {
          checked: entry.kind === 'check',
          createdAt: entry.createdAt,
        })
      }
    }
    return doneCriteria.map((criterion, i) => {
      const state = stateMap.get(i + 1)
      return { criterion, checked: state?.checked ?? false }
    })
  }
}
