/**
 * TaskStore — typed domain facade over queue.ts.
 *
 * `createTaskStore(client)` returns a `DomainTaskStore` whose every method
 * is a thin pass-through to the corresponding `queue.ts` function: same
 * signature, same return value, no behavioural change.
 *
 * In addition to the typed domain methods, the store exposes three generic
 * SQL escape hatches:
 *
 * - `query(sql, params)` — executes a single read in a read-only batch
 *   transaction and returns the ResultSet.
 * - `execute(sql, params)` — runs a single ad-hoc write statement and
 *   returns the ResultSet.
 * - `atomic(fn)` — opens a write transaction, passes a revocable Scope to
 *   the callback, and commits on return or rolls back on throw, rethrowing
 *   the original error. The Scope is revoked the moment the callback
 *   settles; any retained reference used afterwards throws a clear error.
 *   Nesting atomic() inside an active atomic() callback is rejected.
 *
 * `createRunMigrations(client)` returns a lazy, once-per-instance memoised
 * runner that drives queue.ts's `initQueue()`. The factory signature accepts
 * a `client` so the API is stable for the next slice, which will execute DDL
 * directly on the passed client and remove the `initQueue()` delegation.
 *
 * No callers of queue.ts are migrated in this slice. `getClient` and
 * `initQueue` remain exported from queue.ts unchanged.
 */

import type { Client, InValue, ResultSet } from '@libsql/client'
import {
  initQueue,
  getTask as queueGetTask,
  listTasks as queueListTasks,
  enqueueTask as queueEnqueueTask,
  updateTask as queueUpdateTask,
  dropTask as queueDropTask,
  deleteTask as queueDeleteTask,
  setTaskPriority as queueSetTaskPriority,
  insertReflectionTask as queueInsertReflectionTask,
  addBlockers as queueAddBlockers,
  addPendingReviewBlockers as queueAddPendingReviewBlockers,
  removeBlocker as queueRemoveBlocker,
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

/** Patch shape for `updateTask`, matching queue.ts's parameter exactly. */
export type UpdateTaskPatch = Parameters<typeof queueUpdateTask>[1]

/**
 * The callback argument for {@link DomainTaskStore.atomic}.
 *
 * Exposes only `query` and `execute` — no raw client, no transaction handle,
 * no commit/rollback controls. The scope is revoked the moment the callback
 * settles; any use afterwards throws a clear 'revoked' error.
 */
export interface Scope {
  /** Execute a read statement inside the active transaction. */
  query(sql: string, params?: InValue[]): Promise<ResultSet>
  /** Execute a write statement inside the active transaction. */
  execute(sql: string, params?: InValue[]): Promise<ResultSet>
}

/**
 * Typed domain interface over queue.db. Every method mirrors the
 * corresponding queue.ts export with an identical signature and return
 * type — no extra options, no narrowed constraints. This is the stable
 * seam callers will target after the migration; implementations move
 * to direct client execution in subsequent slices.
 *
 * In addition to the domain methods, three generic SQL escape hatches are
 * available on every store created with a non-null client:
 * `query`, `execute`, and `atomic`.
 */
export interface DomainTaskStore {
  // ── Core task CRUD ───────────────────────────────────────────────────────
  getTask(id: string): Promise<Task | null>
  listTasks(status?: TaskStatus): Promise<Task[]>
  enqueueTask(
    prompt: string,
    plan?: TaskPlan,
    opts?: EnqueueTaskOptions,
  ): Promise<Task>
  updateTask(id: string, patch: UpdateTaskPatch): Promise<void>
  dropTask(id: string): Promise<DropTaskResult>
  deleteTask(id: string): Promise<void>
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

  // ── Transcripts ──────────────────────────────────────────────────────────
  upsertTranscript(input: UpsertTranscriptInput): Promise<void>
  getTranscript(taskId: string): Promise<TaskTranscriptRow | null>

  // ── Generic SQL escape hatches ───────────────────────────────────────────
  /**
   * Execute a single read statement in a read-only transaction and return
   * the full ResultSet. Requires a non-null client.
   */
  query(sql: string, params?: InValue[]): Promise<ResultSet>
  /**
   * Execute a single ad-hoc write statement and return the full ResultSet.
   * Requires a non-null client.
   */
  execute(sql: string, params?: InValue[]): Promise<ResultSet>
  /**
   * Run `fn` inside a write transaction. Commits when `fn` returns;
   * rolls back and rethrows when `fn` throws. The {@link Scope} passed to
   * `fn` is revoked the moment the callback settles — any retained reference
   * used afterwards throws a clear 'revoked' error. Nesting `atomic` inside
   * an active `atomic` callback is rejected immediately. Requires a non-null
   * client.
   */
  atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T>
}

/**
 * Return a lazy, once-per-instance memoised migration runner.
 *
 * The runner delegates to `initQueue()` from queue.ts, which is the
 * authoritative migration source in this slice. The `client` parameter
 * establishes the stable factory signature that the next slice will activate
 * (executing DDL directly on the passed client, removing the delegation).
 *
 * Callers that want a guaranteed-initialised store can `await runner()`
 * before the first domain call; queue functions already call `initQueue()`
 * internally so the explicit `await` is optional when going through the store.
 */
export const createRunMigrations = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: Client,
): (() => Promise<void>) => {
  let promise: Promise<void> | null = null
  return (): Promise<void> => {
    if (!promise) promise = initQueue()
    return promise
  }
}

/**
 * Create a `DomainTaskStore` over the given libsql client.
 *
 * Domain methods (getTask, listTasks, …) are thin pass-throughs to the
 * corresponding queue functions — identical signature, identical return value,
 * no extra behaviour. The `client` parameter is used by the generic escape
 * hatches (`query`, `execute`, `atomic`); domain methods resolve their own
 * client from the runtime context in this slice.
 *
 * Passing `null` as the client is supported for call sites that only use
 * domain methods. Calling `query`, `execute`, or `atomic` on a null-client
 * store throws a clear error.
 */
export const createTaskStore = (client: Client | null): DomainTaskStore => {
  let inTransaction = false

  /** Asserts the client is non-null; throws a descriptive error otherwise. */
  const guardClient = (): Client => {
    if (!client)
      throw new Error(
        'TaskStore: a libsql Client is required for query/execute/atomic — pass a non-null client to createTaskStore',
      )
    return client
  }

  return {
    // ── Core task CRUD ─────────────────────────────────────────────────────
    getTask: (id) => queueGetTask(id),
    listTasks: (status) => queueListTasks(status),
    enqueueTask: (prompt, plan, opts) => queueEnqueueTask(prompt, plan, opts),
    updateTask: (id, patch) => queueUpdateTask(id, patch),
    dropTask: (id) => queueDropTask(id),
    deleteTask: (id) => queueDeleteTask(id),
    setTaskPriority: (id, priority) => queueSetTaskPriority(id, priority),
    insertReflectionTask: (corpusSize) => queueInsertReflectionTask(corpusSize),
    promoteDraftToQueued: (taskId) => queuePromoteDraftToQueued(taskId),
    unblockTask: (taskId) => queueUnblockTask(taskId),

    // ── Blocker management ─────────────────────────────────────────────────
    addBlockers: (taskId, blockerIds) => queueAddBlockers(taskId, blockerIds),
    addPendingReviewBlockers: (taskId, blockerIds) =>
      queueAddPendingReviewBlockers(taskId, blockerIds),
    removeBlocker: (taskId, blockerId) => queueRemoveBlocker(taskId, blockerId),
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

    // ── Transcripts ────────────────────────────────────────────────────────
    upsertTranscript: (input) => queueUpsertTranscript(input),
    getTranscript: (taskId) => queueGetTranscript(taskId),

    // ── Generic SQL escape hatches ─────────────────────────────────────────

    query: async (sql, params) => {
      const c = guardClient()
      const [result] = await c.batch([{ sql, args: params ?? [] }], 'read')
      return result
    },

    execute: async (sql, params) => {
      const c = guardClient()
      return c.execute({ sql, args: params ?? [] })
    },

    atomic: async <T>(fn: (scope: Scope) => Promise<T>): Promise<T> => {
      const c = guardClient()
      if (inTransaction) {
        throw new Error(
          'TaskStore: atomic() cannot be nested inside another atomic() call',
        )
      }
      inTransaction = true
      const tx = await c.transaction('write')
      let revoked = false

      const scope: Scope = {
        query: async (sql, params) => {
          if (revoked)
            throw new Error(
              'TaskStore: Scope has been revoked — cannot use scope after atomic() has settled',
            )
          return tx.execute({ sql, args: params ?? [] })
        },
        execute: async (sql, params) => {
          if (revoked)
            throw new Error(
              'TaskStore: Scope has been revoked — cannot use scope after atomic() has settled',
            )
          return tx.execute({ sql, args: params ?? [] })
        },
      }

      try {
        const result = await fn(scope)
        await tx.commit()
        return result
      } catch (err) {
        try {
          await tx.rollback()
        } catch {
          // Swallow rollback errors; the original error is what matters.
        }
        throw err
      } finally {
        revoked = true
        inTransaction = false
        tx.close()
      }
    },
  }
}

/**
 * Return a DomainTaskStore that routes through the queue module's singleton
 * client. Used as the fallback when no store is injected via RequestContext.
 *
 * Domain methods work without a real client (queue functions resolve their
 * own client internally). The generic escape hatches (query/execute/atomic)
 * are not available on this store — callers that need them should obtain a
 * store via `createTaskStore(client)` with a real client.
 */
export const getDefaultDomainTaskStore = (): DomainTaskStore => createTaskStore(null)
