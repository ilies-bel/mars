/**
 * TaskStore — the deep seam over `.mars/mars.db` (ADR-0021).
 *
 * `createTaskStore(client)` returns a `DomainTaskStore` whose typed domain
 * methods are the front door (each a thin pass-through to the corresponding
 * `queue.ts` function) and whose generic SQL escape hatches are the side door:
 *
 * - `query(stmt | sql, params?)` — single read in a read-only batch.
 * - `execute(stmt | sql, params?)` — single ad-hoc write.
 * - `batch(stmts, mode?)` — multi-statement transaction (all-or-nothing).
 * - `atomic(fn)` — callback-scoped write transaction. The transaction handle
 *   NEVER crosses the seam: `atomic` inverts control (you give a callback, you
 *   never get a handle) and the {@link Scope} it passes exposes only
 *   query/execute, is non-nestable, and is revoked the moment the callback
 *   settles. Returning commits; throwing rolls back and rethrows the original
 *   error.
 * - `arcStatus(originId, opts?)` — per-arc rollup predicate.
 *
 * Both side-door reads/writes and domain methods accept either the
 * `DbStatement` shape (`{ sql, args }` or a bare string) or the
 * `(sql, params)` two-argument form, so call sites can use whichever reads
 * cleanest.
 *
 * No raw `DbClient` is ever exported from this seam. The composition root
 * constructs exactly one store per process via {@link getDefaultDomainTaskStore}
 * (production, DSN from `.mars/pg.dsn`) or `createTaskStore(client)` with an
 * isolated client (tests, PGlite backend).
 */

import type { DbClient, DbStatement, DbInValue, DbResultSet } from '../lib/db.js'
import { withTransaction } from '../lib/db.js'
import { ensureSchema } from '../lib/pg-schema.js'
import { ReviewPacketSchema } from '../lib/review-packet.js'
import type { ReviewPacket } from '../lib/review-packet.js'
import {
  getTask as queueGetTask,
  listTasks as queueListTasks,
  listTasksPaged as queueListTasksPaged,
  listNonDoneTasks as queueListNonDoneTasks,
  filterExistingTaskIds as queueFilterExistingTaskIds,
  updateTask as queueUpdateTask,
  reopenTerminalTask as queueReopenTerminalTask,
  setTaskPriority as queueSetTaskPriority,
  addPendingReviewBlockers as queueAddPendingReviewBlockers,
  clearBlockers as queueClearBlockers,
  listBlockers as queueListBlockers,
  hasIncompleteBlockers as queueHasIncompleteBlockers,
  listAllBlockers as queueListAllBlockers,
  unblockTask as queueUnblockTask,
  promoteDraftToQueued as queuePromoteDraftToQueued,
  addProposalBlockers as queueAddProposalBlockers,
  removeProposalBlocker as queueRemoveProposalBlocker,
  listProposalBlockers as queueListProposalBlockers,
  listTasksBlockedByProposal as queueListTasksBlockedByProposal,
  transferProposalBlockerToTask as queueTransferProposalBlockerToTask,
  listSiblings as queueListSiblings,
  listTasksForProposal as queueListTasksForProposal,
  upsertTranscript as queueUpsertTranscript,
  getTranscript as queueGetTranscript,
  getArcWriter,
  TASK_SEL,
  rowToTask,
} from '../queue'
import type {
  Task,
  TaskStatus,
  TaskPlan,
  EnqueueTaskOptions,
  Blocker,
  DropTaskResult,
  UnblockTaskResult,
  UpsertTranscriptInput,
  TaskTranscriptRow,
} from '../queue'
import { resolveVcs } from '../ports/vcs/registry'
import { addBlockerEdges, removeBlockerEdge } from '../arc/blockers'


/** Patch shape for `updateTask`, matching queue.ts's parameter exactly. */
export type UpdateTaskPatch = Parameters<typeof queueUpdateTask>[1]

/** Status values for a task deployment row. */
export type DeploymentStatus = 'pending' | 'ready' | 'failed'

/** Domain representation of a `task_deployments` row. */
export interface TaskDeployment {
  deploymentId: string
  taskId: string
  provider: string
  url: string | null
  status: DeploymentStatus
  error: string | null
  /** ISO-8601 string (coerced from Date when using the pg backend). */
  createdAt: string
  /** ISO-8601 string (coerced from Date when using the pg backend). */
  updatedAt: string
}

/** Input shape for `writeDeployment`. */
export interface WriteDeploymentInput {
  taskId: string
  provider: string
  deploymentId: string
  url?: string | null
  status: DeploymentStatus
}

/** Patch shape for `updateDeploymentStatus`. */
export interface UpdateDeploymentStatusPatch {
  status: DeploymentStatus
  /** When present (including null), the stored url is replaced. */
  url?: string | null
  /** When present (including null), the stored error is replaced. */
  error?: string | null
}

/**
 * Rollup verdict for an arc of tasks sharing one `origin_id`. See
 * {@link DomainTaskStore.arcStatus} for the predicate semantics.
 *
 *   - `'in-progress'`: at least one task is in a non-terminal status.
 *   - `'arc-done'`   : every task is terminal AND at least one reached `'done'`.
 *   - `'arc-failed'` : every task is terminal but none reached `'done'`.
 */
export type ArcRollupStatus = 'in-progress' | 'arc-done' | 'arc-failed'

export interface ArcTaskSummary {
  id: string
  status: TaskStatus
}

export interface ArcStatus {
  status: ArcRollupStatus
  tasks: ArcTaskSummary[]
  /**
   * Commit SHAs on the integration branch attributable to this arc, oldest →
   * newest. Best-effort — `[]` when no integration branch / repo is reachable.
   */
  landedCommits: string[]
}

export interface ArcStatusOptions {
  /** Defaults to `'main'`. */
  integrationBranch?: string
  /** Defaults to `process.env.MARS_REPO`. */
  cwd?: string
}

/** Terminal statuses for the arc rollup. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'done',
  'failed',
  'dropped',
])

/**
 * Normalise the two accepted side-door call shapes into a single
 * `DbStatement`. `query(stmt)` / `query(sql, params)` both resolve here.
 */
const toStatement = (
  stmt: DbStatement | string,
  params?: DbInValue[],
): DbStatement => {
  if (typeof stmt === 'string') {
    return params === undefined ? stmt : { sql: stmt, args: params }
  }
  return stmt
}

/**
 * The callback argument for {@link DomainTaskStore.atomic}.
 *
 * Exposes only `query` and `execute` — no raw client, no transaction handle,
 * no commit/rollback controls. The scope is revoked the moment the callback
 * settles; any use afterwards throws a clear 'revoked' error.
 */
export interface Scope {
  /** Execute a read statement inside the active transaction. */
  query(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  /** Execute a write statement inside the active transaction. */
  execute(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
}

/**
 * The small, prompt-free task projection shared by arc-level operations.
 * Keeping arc enumeration on this shape prevents diagnostic flows from
 * accidentally loading every task prompt or transcript-sized failure blob.
 */
export type ArcMember = Pick<
  Task,
  | 'id'
  | 'branch'
  | 'status'
  | 'failureSignature'
  | 'failureReason'
  | 'createdAt'
  | 'fixForTaskId'
>

/**
 * Typed domain interface over mars.db (tasks side). Every domain method mirrors
 * the corresponding queue.ts export. In addition, the generic SQL escape
 * hatches (`query`, `execute`, `batch`, `atomic`) and the `arcStatus` rollup
 * are available on every store created with a non-null client.
 */
export interface DomainTaskStore {
  // ── Core task CRUD ───────────────────────────────────────────────────────
  getTask(id: string): Promise<Task | null>
  listTasks(status?: TaskStatus): Promise<Task[]>
  listTasksPaged(
    status?: TaskStatus,
    limit?: number,
  ): Promise<{ tasks: Task[]; total: number }>
  /**
   * Return up to `limit` non-done tasks excluding `excludeId`, ordered
   * newest-first (`ORDER BY created_at DESC`).  Callers that need oldest-first
   * display order should reverse the result.
   */
  listNonDoneTasks(excludeId: string, limit: number): Promise<Task[]>
  /** Return every task id without loading task prompts or metadata. */
  listAllTaskIds(): Promise<string[]>
  /**
   * Return the subset of `ids` that refer to existing task rows.  Returns `[]`
   * without issuing a query when `ids` is empty.  Callers must pre-filter and
   * slice `ids` to at most `MAX_BLOCKERS` before calling so the query never
   * receives more than that many ids.
   */
  filterExistingTaskIds(ids: readonly string[]): Promise<string[]>
  enqueueTask(
    prompt: string,
    plan?: TaskPlan,
    opts?: EnqueueTaskOptions,
  ): Promise<Task>
  updateTask(id: string, patch: UpdateTaskPatch): Promise<void>
  reopenTerminalTask(id: string, reason: string): Promise<void>
  dropTask(id: string): Promise<DropTaskResult>
  setTaskPriority(id: string, priority: number): Promise<Task>
  insertReflectionTask(corpusSize: number): Promise<string>
  promoteDraftToQueued(taskId: string): Promise<Task | null>
  unblockTask(taskId: string): Promise<UnblockTaskResult>

  // ── Blocker management ───────────────────────────────────────────────────
  addBlockers(taskId: string, blockerIds: readonly string[]): Promise<void>
  addPendingReviewBlockers(
    taskId: string,
    blockerIds: readonly string[],
  ): Promise<void>
  removeBlocker(
    taskId: string,
    blockerId: string,
  ): Promise<{ removed: boolean }>
  clearBlockers(taskId: string): Promise<void>
  listBlockers(taskId: string): Promise<string[]>
  hasIncompleteBlockers(taskId: string): Promise<boolean>
  listAllBlockers(taskId: string): Promise<Blocker[]>

  // ── Proposal (cross-graph) blockers ──────────────────────────────────────
  addProposalBlockers(
    taskId: string,
    proposalIds: readonly string[],
  ): Promise<void>
  removeProposalBlocker(
    taskId: string,
    proposalId: string,
  ): Promise<{ removed: boolean }>
  listProposalBlockers(taskId: string): Promise<string[]>
  listTasksBlockedByProposal(proposalId: string): Promise<string[]>
  transferProposalBlockerToTask(
    proposalId: string,
    newBlockerTaskId: string,
  ): Promise<{ transferred: string[] }>

  // ── Relations ────────────────────────────────────────────────────────────
  listSiblings(originId: string, excludeTaskId: string): Promise<string[]>
  listTasksForProposal(
    proposalId: string,
  ): Promise<Array<{ id: string; status: string }>>

  // ── Arc membership / fix-task queries ────────────────────────────────────
  /**
   * List every fix task for a given origin task id
   * (i.e. `tasks WHERE fix_for_task_id = originId`).
   *
   * Used by {@link corePurgeTask} to clean up on-disk git artifacts for
   * cascade fix tasks before the DB row is dropped. Replaces the direct
   * `resolveQueueClient().execute()` call in daemon/purge-task.ts.
   */
  listFixTasksByOrigin(
    originId: string,
  ): Promise<Array<{ id: string; worktreePath: string | null; branch: string | null }>>

  /**
   * List every task sharing the given `origin_id`
   * (i.e. all arc members including the origin itself).
   *
   * Returns a prompt-free summary suitable for arc-level operations. Used by
   * {@link coreArcPurge}, arc verification, and rescue prompt assembly.
   */
  listArcMembers(originId: string): Promise<ArcMember[]>

  /**
   * List every done fix task with a non-null `fix_for_task_id`
   * (kind='fix', status='done', fix_for_task_id IS NOT NULL).
   *
   * Used by the `recovery-done-propagation` reconciler to drive origin
   * task promotion. Replaces the dynamic `resolveQueueClient().execute()`
   * call in daemon/reconcilers.ts.
   */
  listDoneFixTasks(): Promise<Task[]>

  // ── Transcripts ──────────────────────────────────────────────────────────
  upsertTranscript(input: UpsertTranscriptInput): Promise<void>
  getTranscript(taskId: string): Promise<TaskTranscriptRow | null>

  // ── Arc rescue counter ───────────────────────────────────────────────────
  /**
   * Return the number of times the rescue operator has run against the arc
   * keyed by `originId`. The durable counter works for task-id and proposal
   * slug arcs alike. Throws when `originId` identifies a recovery/fix task.
   */
  getArcRescueAttempts(originId: string): Promise<number>

  /**
   * Atomically increment the durable counter for `originId` and return the
   * new value. Throws when `originId` identifies a recovery/fix task.
   */
  incrementArcRescueAttempts(originId: string): Promise<number>

  // ── Arc rollup ───────────────────────────────────────────────────────────
  /**
   * Compute the rollup status for the arc of tasks sharing `originId`.
   * Stateless: recomputes from the tasks table on every call.
   */
  arcStatus(originId: string, opts?: ArcStatusOptions): Promise<ArcStatus>

  // ── Deployments ──────────────────────────────────────────────────────────
  /**
   * Insert a new deployment row for `input.taskId` and return the persisted
   * row. `deployment_id` is the caller-supplied primary key.
   */
  writeDeployment(input: WriteDeploymentInput): Promise<TaskDeployment>
  /**
   * Return the newest deployment row for `taskId` (ordered by `created_at
   * DESC`), or `null` when no rows exist yet.
   */
  getLatestDeployment(taskId: string): Promise<TaskDeployment | null>
  /**
   * Update `status` (and optionally `url` / `error`) on the deployment row
   * identified by `deploymentId`, bumping `updated_at` to `now()`.
   * Fields absent from `patch` are left unchanged.
   */
  updateDeploymentStatus(
    deploymentId: string,
    patch: UpdateDeploymentStatusPatch,
  ): Promise<void>
  /**
   * Return all deployment rows for `taskId`, newest-first.
   */
  listDeploymentsForTask(taskId: string): Promise<TaskDeployment[]>

  // ── Review packet ─────────────────────────────────────────────────────────
  /**
   * Return the persisted `ReviewPacket` for `taskId`, or `null` when none has
   * been stored yet. Parses via `ReviewPacketSchema` on read.
   */
  getReviewPacket(taskId: string): Promise<ReviewPacket | null>
  /**
   * Persist `packet` for `taskId` as JSON in `review_packet_json`.
   */
  setReviewPacket(taskId: string, packet: ReviewPacket): Promise<void>

  // ── QA report ───────────────────────────────────────────────────────────
  getQaReport(taskId: string): Promise<import('../queue').QaReport | null>
  setQaReport(taskId: string, report: import('../queue').QaReport): Promise<void>

  // ── Generic SQL escape hatches ───────────────────────────────────────────
  /** Execute a single read in a read-only transaction. Non-null client. */
  query(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  /** Execute a single ad-hoc write. Non-null client. */
  execute(stmt: DbStatement | string, params?: DbInValue[]): Promise<DbResultSet>
  /**
   * Run all statements in one transaction; rolls the whole batch back if any
   * statement fails. `mode` is accepted for call-shape compatibility and
   * ignored (PostgreSQL has no read/write batch distinction). Non-null client.
   */
  batch(
    stmts: DbStatement[],
    mode?: 'write' | 'read' | 'deferred',
  ): Promise<DbResultSet[]>
  /**
   * Run `fn` inside a write transaction. Commits when `fn` returns; rolls back
   * and rethrows when `fn` throws. The {@link Scope} is revoked the moment the
   * callback settles. Nesting is rejected. Non-null client.
   */
  atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T>
}

/**
 * Coerce a `timestamptz` value to an ISO-8601 string regardless of backend.
 * - pg (embedded) returns `Date` objects for timestamptz columns.
 * - PGlite returns ISO strings directly.
 */
const coerceTimestamp = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString()
  return v as string
}

/** Map a raw DB row to the `TaskDeployment` domain shape. */
const rowToDeployment = (row: unknown): TaskDeployment => {
  const r = row as Record<string, unknown>
  return {
    deploymentId: r['deployment_id'] as string,
    taskId: r['task_id'] as string,
    provider: r['provider'] as string,
    url: (r['url'] as string | null) ?? null,
    status: r['status'] as DeploymentStatus,
    error: (r['error'] as string | null) ?? null,
    createdAt: coerceTimestamp(r['created_at']),
    updatedAt: coerceTimestamp(r['updated_at']),
  }
}

/**
 * Best-effort read of integration-branch commits attributable to an arc.
 */
const readLandedCommits = async (
  originId: string,
  opts?: ArcStatusOptions,
): Promise<string[]> => {
  const cwd = opts?.cwd ?? process.env.MARS_REPO
  if (!cwd) return []
  const integrationBranch = opts?.integrationBranch ?? 'main'
  try {
    const commits = await resolveVcs().searchCommits({
      cwd,
      rev: integrationBranch,
      grep: originId,
    })
    return commits.map((c) => c.sha).reverse()
  } catch {
    return []
  }
}

/**
 * Return a lazy, once-per-instance memoised migration runner that applies the
 * canonical schema (`ensureSchema`, pg-schema.ts) on the passed client's
 * database. The migration lives behind the store per ADR-0021; callers no
 * longer hand-sequence it.
 */
export const createRunMigrations = (
  client: DbClient,
): (() => Promise<void>) => {
  let promise: Promise<void> | null = null
  return (): Promise<void> => {
    if (!promise) promise = ensureSchema(client)
    return promise
  }
}

/**
 * Create a `DomainTaskStore` over the given DB client.
 *
 * Passing `null` is supported for call sites that only use domain methods.
 * Calling a generic escape hatch on a null-client store throws a clear error.
 */
export const createTaskStore = (client: DbClient | null): DomainTaskStore => {
  let inTransaction = false

  const guardClient = (): DbClient => {
    if (!client)
      throw new Error(
        'TaskStore: a DbClient is required for query/execute/batch/atomic — pass a non-null client to createTaskStore',
      )
    return client
  }

  const assertArcOrigin = async (c: DbClient, originId: string): Promise<void> => {
    const result = await c.execute({
      sql: `SELECT fix_for_task_id FROM tasks WHERE id = ?`,
      args: [originId],
    })
    const row = result.rows[0] as unknown as { fix_for_task_id: string | null } | undefined
    if (row !== undefined && row.fix_for_task_id !== null) {
      throw new Error(
        'arc rescue counter can only be read on an origin task, not a recovery/fix task',
      )
    }
  }

  // The facade is inverted onto the Arc aggregate (ADR-0052): domain methods
  // that have an arc-shaped write funnel route through {@link Arc} directly,
  // bound to THIS store's client (so a `:memory:`/file-URL test store hits its
  // own DB). Read-only and non-arc methods stay thin pass-throughs to queue.ts.
  // `store` is captured here so the Arc factories receive the same seam.
  const store: DomainTaskStore = {
    // ── Core task CRUD ─────────────────────────────────────────────────────
    getTask: (id) => queueGetTask(id),
    listTasks: (status) => queueListTasks(status),
    listTasksPaged: (status, limit) => queueListTasksPaged(status, limit),
    listNonDoneTasks: (excludeId, limit) => queueListNonDoneTasks(excludeId, limit),
    listAllTaskIds: async () => {
      const r = await guardClient().execute('SELECT id FROM tasks')
      return r.rows.map((row) => (row as { id: string }).id)
    },
    filterExistingTaskIds: (ids) => queueFilterExistingTaskIds(ids),
    // Arc.createOrigin is the origin write funnel; pass `store` so persistence
    // routes through this seam rather than the process-wide default.
    enqueueTask: (prompt, plan, opts) =>
      getArcWriter().createOrigin({ prompt, plan, opts }, store),
    // updateTask is the transition primitive *inside* the aggregate (ADR-0052):
    // Arc.transition wraps it. The facade keeps delegating to the primitive so
    // non-status PATCH columns (branch, worktreePath, sessionId, …) and the
    // rich atomic event set (terminal pairs, blocked, under_investigation) are
    // preserved; a status-only patch is exactly Arc.transition's funnel.
    updateTask: (id, patch) => queueUpdateTask(id, patch),
    reopenTerminalTask: (id, reason) => queueReopenTerminalTask(id, reason, store),
    dropTask: (id) => getArcWriter().drop(id, store),
    setTaskPriority: (id, priority) => queueSetTaskPriority(id, priority),
    insertReflectionTask: (corpusSize) =>
      getArcWriter().insertReflection(corpusSize, store),
    promoteDraftToQueued: (taskId) => queuePromoteDraftToQueued(taskId),
    unblockTask: (taskId) => queueUnblockTask(taskId),

    // ── Blocker management ─────────────────────────────────────────────────
    addBlockers: (taskId, blockerIds) =>
      addBlockerEdges(store, taskId, blockerIds),
    addPendingReviewBlockers: (taskId, blockerIds) =>
      queueAddPendingReviewBlockers(taskId, blockerIds),
    removeBlocker: (taskId, blockerId) =>
      removeBlockerEdge(store, taskId, blockerId),
    clearBlockers: (taskId) => queueClearBlockers(taskId),
    listBlockers: (taskId) => queueListBlockers(taskId),
    hasIncompleteBlockers: (taskId) => queueHasIncompleteBlockers(taskId),
    listAllBlockers: (taskId) => queueListAllBlockers(taskId),

    // ── Proposal blockers ──────────────────────────────────────────────────
    addProposalBlockers: (taskId, proposalIds) =>
      queueAddProposalBlockers(taskId, proposalIds),
    removeProposalBlocker: (taskId, proposalId) =>
      queueRemoveProposalBlocker(taskId, proposalId),
    listProposalBlockers: (taskId) => queueListProposalBlockers(taskId),
    listTasksBlockedByProposal: (proposalId) =>
      queueListTasksBlockedByProposal(proposalId),
    transferProposalBlockerToTask: (proposalId, newBlockerTaskId) =>
      queueTransferProposalBlockerToTask(proposalId, newBlockerTaskId),

    // ── Relations ──────────────────────────────────────────────────────────
    listSiblings: (originId, excludeTaskId) =>
      queueListSiblings(originId, excludeTaskId),
    listTasksForProposal: (proposalId) => queueListTasksForProposal(proposalId),

    // ── Arc membership / fix-task queries ──────────────────────────────────
    listFixTasksByOrigin: async (originId) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `SELECT id, worktree_path, branch FROM tasks WHERE fix_for_task_id = ?`,
        args: [originId],
      })
      return r.rows.map((row) => {
        const r0 = row as unknown as {
          id: string
          worktree_path: string | null
          branch: string | null
        }
        return { id: r0.id, worktreePath: r0.worktree_path, branch: r0.branch }
      })
    },

    listArcMembers: async (originId) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `SELECT id, branch, status, failure_signature, failure_reason, created_at, fix_for_task_id
              FROM tasks WHERE origin_id = ? ORDER BY created_at DESC`,
        args: [originId],
      })
      return r.rows.map((row) => {
        const r0 = row as unknown as {
          id: string
          branch: string | null
          status: TaskStatus
          failure_signature: string | null
          failure_reason: string | null
          created_at: string
          fix_for_task_id: string | null
        }
        return {
          id: r0.id,
          branch: r0.branch,
          status: r0.status,
          failureSignature: r0.failure_signature,
          failureReason: r0.failure_reason,
          createdAt: r0.created_at,
          fixForTaskId: r0.fix_for_task_id,
        }
      })
    },

    listDoneFixTasks: async () => {
      const c = guardClient()
      const r = await c.execute(
        `${TASK_SEL} WHERE t.kind = 'fix' AND t.status = 'done' AND t.fix_for_task_id IS NOT NULL`,
      )
      return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
    },

    // ── Transcripts ────────────────────────────────────────────────────────
    upsertTranscript: (input) => queueUpsertTranscript(input),
    getTranscript: (taskId) => queueGetTranscript(taskId),

    // ── Arc rescue counter ─────────────────────────────────────────────────
    // Arcs can be rooted by either a task id or a proposal slug. The counter is
    // therefore stored independently of tasks; only an actual recovery/fix
    // task id is invalid input for these origin-oriented accessors.
    getArcRescueAttempts: async (originId) => {
      const c = guardClient()
      await assertArcOrigin(c, originId)
      const result = await c.execute({
        sql: `SELECT attempts FROM arc_rescue_attempts WHERE origin_id = ?`,
        args: [originId],
      })
      if (result.rows.length === 0) return 0
      return Number((result.rows[0] as unknown as { attempts: number | bigint }).attempts)
    },

    incrementArcRescueAttempts: async (originId) => {
      const c = guardClient()
      await assertArcOrigin(c, originId)
      const result = await c.execute({
        sql: `INSERT INTO arc_rescue_attempts (origin_id, attempts)
              VALUES (?, 1)
              ON CONFLICT (origin_id) DO UPDATE
                SET attempts = arc_rescue_attempts.attempts + 1,
                    updated_at = now()
              RETURNING attempts`,
        args: [originId],
      })
      return Number((result.rows[0] as unknown as { attempts: number | bigint }).attempts)
    },

    // ── Arc rollup ─────────────────────────────────────────────────────────
    arcStatus: async (originId, opts) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `SELECT id, status FROM tasks
                WHERE origin_id = ?
                ORDER BY created_at ASC`,
        args: [originId],
      })
      const tasks: ArcTaskSummary[] = r.rows.map((row) => {
        const r0 = row as unknown as { id: string; status: string }
        return { id: r0.id, status: r0.status as TaskStatus }
      })

      let status: ArcRollupStatus
      if (tasks.length === 0) {
        status = 'in-progress'
      } else {
        const allTerminal = tasks.every((t) => TERMINAL_STATUSES.has(t.status))
        if (!allTerminal) {
          status = 'in-progress'
        } else {
          const anyDone = tasks.some((t) => t.status === 'done')
          status = anyDone ? 'arc-done' : 'arc-failed'
        }
      }

      const landedCommits = await readLandedCommits(originId, opts)
      return { status, tasks, landedCommits }
    },

    // ── Deployments ────────────────────────────────────────────────────────

    writeDeployment: async (input) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `INSERT INTO task_deployments (deployment_id, task_id, provider, url, status)
              VALUES (?, ?, ?, ?, ?) RETURNING *`,
        args: [
          input.deploymentId,
          input.taskId,
          input.provider,
          input.url ?? null,
          input.status,
        ],
      })
      return rowToDeployment(r.rows[0])
    },

    getLatestDeployment: async (taskId) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `SELECT * FROM task_deployments
              WHERE task_id = ?
              ORDER BY created_at DESC
              LIMIT 1`,
        args: [taskId],
      })
      return r.rows.length === 0 ? null : rowToDeployment(r.rows[0])
    },

    updateDeploymentStatus: async (deploymentId, patch) => {
      const c = guardClient()
      const setClauses: string[] = ['status = ?', 'updated_at = now()']
      const args: DbInValue[] = [patch.status]
      if (patch.url !== undefined) {
        setClauses.push('url = ?')
        args.push(patch.url ?? null)
      }
      if (patch.error !== undefined) {
        setClauses.push('error = ?')
        args.push(patch.error ?? null)
      }
      args.push(deploymentId)
      await c.execute({
        sql: `UPDATE task_deployments SET ${setClauses.join(', ')} WHERE deployment_id = ?`,
        args,
      })
    },

    listDeploymentsForTask: async (taskId) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `SELECT * FROM task_deployments
              WHERE task_id = ?
              ORDER BY created_at DESC`,
        args: [taskId],
      })
      return r.rows.map(rowToDeployment)
    },

    // ── Review packet ──────────────────────────────────────────────────────

    getReviewPacket: async (taskId) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `SELECT review_packet_json FROM tasks WHERE id = ?`,
        args: [taskId],
      })
      if (r.rows.length === 0) return null
      const row = r.rows[0] as unknown as { review_packet_json: string | null }
      if (row.review_packet_json === null || row.review_packet_json === undefined) return null
      return ReviewPacketSchema.parse(JSON.parse(row.review_packet_json))
    },

    // The `review_packet_json` write funnels through the Arc aggregate — the
    // sole task-table writer (ADR-0052 is column-agnostic, so a payload
    // column counts) — bound to THIS store so a test store hits its own DB.
    setReviewPacket: (taskId, packet) => getArcWriter().setReviewPacket(taskId, packet, store),

    // ── QA report ─────────────────────────────────────────────────────────

    getQaReport: async (taskId) => {
      const c = guardClient()
      const r = await c.execute({
        sql: `SELECT qa_report_json FROM tasks WHERE id = ?`,
        args: [taskId],
      })
      if (r.rows.length === 0) return null
      const row = r.rows[0] as unknown as { qa_report_json: string | null }
      if (row.qa_report_json === null || row.qa_report_json === undefined) return null
      return JSON.parse(row.qa_report_json)
    },

    // Same funnel as setReviewPacket: `qa_report_json` is a payload column,
    // still covered by the column-agnostic ADR-0052 sole-writer rule.
    setQaReport: (taskId, report) => getArcWriter().setQaReport(taskId, report, store),

    // ── Generic SQL escape hatches ─────────────────────────────────────────

    query: async (stmt, params) => {
      const c = guardClient()
      const [result] = await c.batch([toStatement(stmt, params)], 'read')
      return result
    },

    execute: async (stmt, params) => {
      const c = guardClient()
      return c.execute(toStatement(stmt, params))
    },

    batch: (stmts, mode) => {
      const c = guardClient()
      // 'deferred' was a libsql mode; the seam only distinguishes read/write
      // (and ignores even that) — collapse it to 'write'.
      return c.batch(stmts, mode === 'read' ? 'read' : 'write')
    },

    atomic: async <T>(fn: (scope: Scope) => Promise<T>): Promise<T> => {
      const c = guardClient()
      if (inTransaction) {
        throw new Error(
          'TaskStore: atomic() cannot be nested inside another atomic() call',
        )
      }
      inTransaction = true
      let revoked = false
      try {
        return await withTransaction(c, async (tx) => {
          const scope: Scope = {
            query: async (stmt, params) => {
              if (revoked)
                throw new Error(
                  'TaskStore: Scope has been revoked — cannot use scope after atomic() has settled',
                )
              return tx.execute(toStatement(stmt, params))
            },
            execute: async (stmt, params) => {
              if (revoked)
                throw new Error(
                  'TaskStore: Scope has been revoked — cannot use scope after atomic() has settled',
                )
              return tx.execute(toStatement(stmt, params))
            },
          }
          return fn(scope)
        })
      } finally {
        revoked = true
        inTransaction = false
      }
    },
  }

  return store
}

// Composition-root accessors (getDefaultTaskStore, getDefaultDomainTaskStore,
// getCompositionRootClient, runCompositionRootMigrations,
// __resetDefaultTaskStoreForTests) live in ./task-store-default.ts.
// Import them from there, not here. See ADR-0101 edge 2.
