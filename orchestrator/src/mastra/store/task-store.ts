/**
 * TaskStore — typed domain facade over queue.ts.
 *
 * `createTaskStore(client)` returns a `DomainTaskStore` whose every method
 * is a thin pass-through to the corresponding `queue.ts` function: same
 * signature, same return value, no behavioural change.
 *
 * `createRunMigrations(client)` returns a lazy, once-per-instance memoised
 * runner that drives queue.ts's `initQueue()`. The factory signature accepts
 * a `client` so the API is stable for the next slice, which will execute DDL
 * directly on the passed client and remove the `initQueue()` delegation.
 *
 * No callers of queue.ts are migrated in this slice. `getClient` and
 * `initQueue` remain exported from queue.ts unchanged.
 */

import type { Client } from '@libsql/client'
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
 * Typed domain interface over queue.db. Every method mirrors the
 * corresponding queue.ts export with an identical signature and return
 * type — no extra options, no narrowed constraints. This is the stable
 * seam callers will target after the migration; implementations move
 * to direct client execution in subsequent slices.
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
 * Create a `DomainTaskStore` over the given libsql client. Each method is a
 * thin pass-through to the corresponding queue function — identical signature,
 * identical return value, no extra behaviour. The `client` parameter is
 * accepted to establish the stable factory signature; queue functions resolve
 * their own client from the runtime context in this slice.
 */
export const createTaskStore = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: Client,
): DomainTaskStore => ({
  // Core task CRUD
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

  // Blocker management
  addBlockers: (taskId, blockerIds) => queueAddBlockers(taskId, blockerIds),
  addPendingReviewBlockers: (taskId, blockerIds) =>
    queueAddPendingReviewBlockers(taskId, blockerIds),
  removeBlocker: (taskId, blockerId) => queueRemoveBlocker(taskId, blockerId),
  clearBlockers: (taskId) => queueClearBlockers(taskId),
  listBlockers: (taskId) => queueListBlockers(taskId),
  hasIncompleteBlockers: (taskId) => queueHasIncompleteBlockers(taskId),
  listAllBlockers: (taskId) => queueListAllBlockers(taskId),

  // Proposal blockers
  addProposalBlockers: (taskId, proposalIds) =>
    queueAddProposalBlockers(taskId, proposalIds),
  removeProposalBlocker: (taskId, proposalId) =>
    queueRemoveProposalBlocker(taskId, proposalId),
  listProposalBlockers: (taskId) => queueListProposalBlockers(taskId),
  listTasksBlockedByProposal: (proposalId) =>
    queueListTasksBlockedByProposal(proposalId),
  transferProposalBlockerToTask: (proposalId, newBlockerTaskId) =>
    queueTransferProposalBlockerToTask(proposalId, newBlockerTaskId),

  // Relations
  listSiblings: (originId, excludeTaskId) =>
    queueListSiblings(originId, excludeTaskId),
  listTasksForProposal: (proposalId) => queueListTasksForProposal(proposalId),

  // Transcripts
  upsertTranscript: (input) => queueUpsertTranscript(input),
  getTranscript: (taskId) => queueGetTranscript(taskId),
})
