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
 * - `atomic(fn)` — callback-scoped write transaction. The libsql Transaction
 *   NEVER crosses the seam: `atomic` inverts control (you give a callback, you
 *   never get a handle) and the {@link Scope} it passes exposes only
 *   query/execute, is non-nestable, and is revoked the moment the callback
 *   settles. Returning commits; throwing rolls back and rethrows the original
 *   error.
 * - `arcStatus(originId, opts?)` — per-arc rollup predicate.
 *
 * Both side-door reads/writes and domain methods accept either the libsql
 * `InStatement` shape (`{ sql, args }` or a bare string) or the
 * `(sql, params)` two-argument form, so call sites can use whichever reads
 * cleanest.
 *
 * No raw libsql `Client` is ever exported from this seam. The composition
 * root constructs exactly one store per process via {@link getDefaultDomainTaskStore}
 * (production, file: client) or `createTaskStore(client)` with a `:memory:`/
 * file-URL client (tests).
 */

import type { Client, InStatement, InValue, ResultSet } from '@libsql/client'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  resolveQueueClient,
  migrateQueueSchema,
  getTask as queueGetTask,
  listTasks as queueListTasks,
  updateTask as queueUpdateTask,
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
import { Arc } from '../arc'

const execFileAsync = promisify(execFile)

/** Patch shape for `updateTask`, matching queue.ts's parameter exactly. */
export type UpdateTaskPatch = Parameters<typeof queueUpdateTask>[1]

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
 * `InStatement`. `query(stmt)` / `query(sql, params)` both resolve here.
 */
const toStatement = (
  stmt: InStatement | string,
  params?: InValue[],
): InStatement => {
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
  query(stmt: InStatement | string, params?: InValue[]): Promise<ResultSet>
  /** Execute a write statement inside the active transaction. */
  execute(stmt: InStatement | string, params?: InValue[]): Promise<ResultSet>
}

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
  enqueueTask(
    prompt: string,
    plan?: TaskPlan,
    opts?: EnqueueTaskOptions,
  ): Promise<Task>
  updateTask(id: string, patch: UpdateTaskPatch): Promise<void>
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

  // ── Transcripts ──────────────────────────────────────────────────────────
  upsertTranscript(input: UpsertTranscriptInput): Promise<void>
  getTranscript(taskId: string): Promise<TaskTranscriptRow | null>

  // ── Arc rollup ───────────────────────────────────────────────────────────
  /**
   * Compute the rollup status for the arc of tasks sharing `originId`.
   * Stateless: recomputes from the tasks table on every call.
   */
  arcStatus(originId: string, opts?: ArcStatusOptions): Promise<ArcStatus>

  // ── Generic SQL escape hatches ───────────────────────────────────────────
  /** Execute a single read in a read-only transaction. Non-null client. */
  query(stmt: InStatement | string, params?: InValue[]): Promise<ResultSet>
  /** Execute a single ad-hoc write. Non-null client. */
  execute(stmt: InStatement | string, params?: InValue[]): Promise<ResultSet>
  /**
   * Run all statements in one transaction under `mode` (default `'write'`);
   * rolls the whole batch back if any statement fails. Non-null client.
   */
  batch(
    stmts: InStatement[],
    mode?: 'write' | 'read' | 'deferred',
  ): Promise<ResultSet[]>
  /**
   * Run `fn` inside a write transaction. Commits when `fn` returns; rolls back
   * and rethrows when `fn` throws. The {@link Scope} is revoked the moment the
   * callback settles. Nesting is rejected. Non-null client.
   */
  atomic<T>(fn: (scope: Scope) => Promise<T>): Promise<T>
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
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        integrationBranch,
        `--grep=${originId}`,
        '--fixed-strings',
        '--format=%H',
      ],
      { cwd },
    )
    const shas = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return shas.reverse()
  } catch {
    return []
  }
}

/**
 * Return a lazy, once-per-instance memoised migration runner that drives
 * queue.db's schema migration on the passed client's database. The migration
 * lives behind the store per ADR-0021; callers no longer hand-sequence it.
 */
export const createRunMigrations = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _client: Client,
): (() => Promise<void>) => {
  let promise: Promise<void> | null = null
  return (): Promise<void> => {
    if (!promise) promise = migrateQueueSchema()
    return promise
  }
}

/**
 * Create a `DomainTaskStore` over the given libsql client.
 *
 * Passing `null` is supported for call sites that only use domain methods.
 * Calling a generic escape hatch on a null-client store throws a clear error.
 */
export const createTaskStore = (client: Client | null): DomainTaskStore => {
  let inTransaction = false

  const guardClient = (): Client => {
    if (!client)
      throw new Error(
        'TaskStore: a libsql Client is required for query/execute/batch/atomic — pass a non-null client to createTaskStore',
      )
    return client
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
    // Arc.createOrigin is the origin write funnel; pass `store` so persistence
    // routes through this seam rather than the process-wide default.
    enqueueTask: (prompt, plan, opts) =>
      Arc.createOrigin({ prompt, plan, opts }, store),
    // updateTask is the transition primitive *inside* the aggregate (ADR-0052):
    // Arc.transition wraps it. The facade keeps delegating to the primitive so
    // non-status PATCH columns (branch, worktreePath, sessionId, …) and the
    // rich atomic event set (terminal pairs, blocked, under_investigation) are
    // preserved; a status-only patch is exactly Arc.transition's funnel.
    updateTask: (id, patch) => queueUpdateTask(id, patch),
    dropTask: (id) => Arc.load(id, store).drop(),
    setTaskPriority: (id, priority) => queueSetTaskPriority(id, priority),
    insertReflectionTask: (corpusSize) =>
      Arc.load('reflect', store).insertReflection(corpusSize),
    promoteDraftToQueued: (taskId) => queuePromoteDraftToQueued(taskId),
    unblockTask: (taskId) => queueUnblockTask(taskId),

    // ── Blocker management ─────────────────────────────────────────────────
    addBlockers: (taskId, blockerIds) =>
      Arc.load(taskId, store).addBlocker(taskId, blockerIds),
    addPendingReviewBlockers: (taskId, blockerIds) =>
      queueAddPendingReviewBlockers(taskId, blockerIds),
    removeBlocker: (taskId, blockerId) =>
      Arc.load(taskId, store).removeBlocker(taskId, blockerId),
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
      return c.batch(stmts, mode ?? 'write')
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

  return store
}

let cachedDefaultStore: DomainTaskStore | null = null

/**
 * Compute the candidate `.mars/` stateDir for cross-boundary guard checks
 * WITHOUT calling `resolveContext()` (which has a `mkdirSync` side effect).
 *
 * - When `MARS_REPO` is explicitly set, derive stateDir from it directly.
 * - When `MARS_REPO` is absent and the CWD sits inside a worktree, infer the
 *   parent `.mars/` from the CWD path (the worktree path always contains
 *   `/.mars/worktrees/<id>`).
 * - Returns `null` when neither source is available (ordinary production daemon
 *   without an explicit repo binding — guard skips in that case).
 */
const computeStateDirForGuard = (): string | null => {
  const marsRepo = process.env.MARS_REPO
  if (marsRepo) return resolve(marsRepo) + sep + '.mars'

  const cwd = process.cwd()
  const marker = sep + '.mars' + sep + 'worktrees' + sep
  const idx = cwd.indexOf(marker)
  if (idx !== -1) return cwd.slice(0, idx) + sep + '.mars'

  return null
}

/**
 * Composition-root accessor: the single process-wide `DomainTaskStore` over
 * `.mars/mars.db`. Lazily runs the queue migration and constructs the store
 * around the seam-internal libsql client. This is the only sanctioned way for
 * production modules to obtain a store when one was not threaded in via DI.
 *
 * Two cross-boundary write guards are applied on the default-resolution path
 * BEFORE `resolveContext()` (which has a `mkdirSync` side effect) is called:
 *
 * 1. **Worktree guard**: if the process CWD is inside the SAME
 *    `<stateDir>/worktrees/<id>/` as the store would resolve to, we are a
 *    dispatched Worker about to contaminate the PARENT production database
 *    (forensic incident 2026-07-02). The stateDir is computed without side
 *    effects so this throws before any filesystem mutation.
 *
 * 2. **Vitest guard**: when running under vitest (`process.env.VITEST`) with
 *    `MARS_REPO` explicitly set, the resolved `.mars/` must reside inside the
 *    OS temp directory. A non-temp `MARS_REPO` means the test forgot to use an
 *    isolated store and would write to a real database. Use `createTaskStore()`
 *    or set `MARS_REPO` to a `mkdtempSync()` path.
 */
export const getDefaultTaskStore = async (): Promise<DomainTaskStore> => {
  if (cachedDefaultStore) return cachedDefaultStore

  const cwd = process.cwd()
  const stateDir = computeStateDirForGuard()

  if (stateDir !== null) {
    // ── Guard 1: worktree cross-boundary write prevention ──────────────────
    // Only fires when stateDir was INFERRED from CWD (i.e. MARS_REPO is not
    // explicitly set). When MARS_REPO is set — or when --repo was propagated
    // into MARS_REPO by makeProductionDeps() — the caller deliberately chose
    // the target repo and the guard must not block them. The guard is a
    // foot-gun protector for implicit CWD resolution, not an absolute veto.
    if (!process.env.MARS_REPO && cwd.startsWith(stateDir + sep + 'worktrees' + sep)) {
      throw new Error(
        `[mars] getDefaultTaskStore() refused: process CWD is inside a worktree ` +
          `(${cwd}). This would write to the PARENT production database at ` +
          `${stateDir}/mars.db. ` +
          `Use createTaskStore() with an isolated client, or inject the store via DI.`,
      )
    }

    // ── Guard 2: vitest hermetic store enforcement ─────────────────────────
    // Only applies when VITEST is running, blocking non-temp stores before
    // any write reaches the DB.
    if (process.env.VITEST) {
      const td = tmpdir()
      if (!stateDir.startsWith(td + sep) && !stateDir.startsWith(td + '/')) {
        throw new Error(
          `[mars] getDefaultTaskStore() resolved to ${stateDir}/mars.db which is NOT ` +
            `inside the system temp directory (${td}). ` +
            `Tests must use an isolated store: set MARS_REPO to a mkdtempSync() path ` +
            `or use createTaskStore() with a :memory: client.`,
        )
      }
    }
  }

  await migrateQueueSchema()
  cachedDefaultStore = createTaskStore(resolveQueueClient())
  return cachedDefaultStore
}

/**
 * Synchronous composition-root accessor for call sites that only need domain
 * methods and cannot await. The migration is driven on first domain call by
 * queue.ts's own defensive `migrateQueueSchema()` guards.
 *
 * Applies the same worktree cross-boundary guard as {@link getDefaultTaskStore}
 * to prevent dispatched Workers from writing to the parent production database.
 * The guard is skipped when `MARS_REPO` is explicitly set (or has been set by
 * `makeProductionDeps()` from a `--repo` flag) — explicit bindings are
 * intentional and must not be blocked.
 */
export const getDefaultDomainTaskStore = (): DomainTaskStore => {
  const cwd = process.cwd()
  // Guard only fires for the implicit/CWD-inferred path. An explicit MARS_REPO
  // (set directly or propagated from --repo by makeProductionDeps) signals that
  // the caller deliberately chose the target repo; honor that and skip the guard.
  if (!process.env.MARS_REPO) {
    const stateDir = computeStateDirForGuard()
    if (stateDir !== null && cwd.startsWith(stateDir + sep + 'worktrees' + sep)) {
      throw new Error(
        `[mars] getDefaultDomainTaskStore() refused: process CWD is inside a worktree ` +
          `(${cwd}). This would write to the PARENT production database at ` +
          `${stateDir}/mars.db. ` +
          `Use createTaskStore() with an isolated client, or inject the store via DI.`,
      )
    }
  }
  return createTaskStore(resolveQueueClient())
}

/**
 * Composition-root-only access to the underlying libsql `Client` for the
 * wire-bus / outbox subscriber layer (cursor reads on the `events` table,
 * which lives below the domain seam — ADR-0021 keeps the Outbox in queue.db).
 *
 * This is NOT a domain escape hatch: domain modules must use the store. The
 * only sanctioned importer is the daemon composition root, which threads this
 * client into `ensure*`/`drain*` subscriber wiring. Returning the raw client
 * here is the ADR's "constructor injection of a libsql Client at the
 * composition root" — the leak the ADR closes is *domain* modules importing a
 * raw `getClient`, not the root wiring the bus.
 */
export const getCompositionRootClient = (): Client => resolveQueueClient()

/**
 * Composition-root migration entry point. Runs the (memoised) queue schema
 * migration. The daemon calls this once at startup so the schema exists before
 * any subscriber or store touches the DB.
 */
export const runCompositionRootMigrations = (): Promise<void> =>
  migrateQueueSchema()

/**
 * Test-only: drop the cached default store so a subsequent
 * `getDefaultTaskStore()` rebuilds against whatever queue client is current.
 */
export const __resetDefaultTaskStoreForTests = (): void => {
  cachedDefaultStore = null
}
