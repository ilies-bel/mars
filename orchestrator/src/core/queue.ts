import { type Client, type InStatement } from '@libsql/client'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { resolveContext } from './context'
import { parseClaudeSessionIds } from './lib/claude-session-ids'
import type { Author, AuthorKind } from './author'
import { openLibsql } from './lib/libsql'
import { buildEventInsert } from './lib/outbox'
import { Arc } from './arc'
import type { DomainTaskStore as TaskStore } from './store/task-store'
import { raiseActionQueueItem } from './lib/action-queue'

const execFileP = promisify(execFile)
const gzipAsyncQ = promisify(gzip)

export type TaskStatus =
  | 'draft'
  | 'triaging'
  | 'queued'
  | 'running'
  | 'verifying'
  // Parked after a clean verify when the task carries a preview command: a
  // live dev server is running off the worktree and the task waits for a human
  // to Validate (→ merge) or Reject (→ failed) via the action queue. Like
  // 'blocked', this is a non-dispatchable parking status; the gate is a
  // workflow boundary (the worker returns and holds no merge lock) so it
  // survives daemon restarts. See the awaiting-validation action-queue kind.
  | 'awaiting-validation'
  // Parked for operator-owned interactive work in the task's worktree. A
  // human holds a lease (leaseOwner / leasedAt / leaseNote) and works in
  // their own session; the pipeline resumes when the lease is released.
  // No managed subprocess — the phantom watchdog MUST NOT sweep this status.
  // Compatible with ADR-0063 (no-attach): the human opens their own session;
  // the daemon never attaches to a running pty.
  | 'awaiting-human'
  | 'merging'
  | 'vega-reconciling'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'blocked'
  | 'under_investigation'

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
 * Thrown by {@link updateTask} when a caller attempts to move a task out of a
 * terminal status (`'done'` or `'dropped'`). Terminal tasks are immutable —
 * any status write that bypasses this guard would silently corrupt lifecycle
 * invariants tracked by subscribers (Invalidator, daemon dispatcher, UI).
 */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(
      `Illegal task status transition: task ${taskId} is in terminal status '${fromStatus}' and cannot transition to '${toStatus}'`,
    )
    this.name = 'IllegalTransitionError'
  }
}

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
  createdAt: string
}

/**
 * Distinguishes the different roles a row can play in the queue. The value
 * is mirrored by, and must agree with, the `fixForTaskId` pointer (only
 * `'fix'` may carry a non-null pointer):
 *
 *   - `'task'`     → ordinary work; `fixForTaskId` MUST be null
 *   - `'fix'`      → recovery fix-task; `fixForTaskId` MUST be non-null
 *   - `'diagnose'` → terminal investigate-only Chore. Reads heavily
 *                    without acting, records a verdict through
 *                    `mars diagnose set`, and parks the original task
 *                    behind itself. Never spawns another diagnose Chore
 *                    (see PRD 06e677fb / ADR). `fixForTaskId` MUST be
 *                    null; the link to the origin stuck task is via
 *                    `origin_id`.
 *
 * The field is declared optional on the TypeScript type for backwards
 * compatibility with existing `Task` literals in tests and fixtures; every
 * persistence path defaults `undefined` to `'task'`.
 */
export type TaskKind = 'task' | 'fix' | 'diagnose'

/**
 * Routing hint that selects which Worker implements a Task. Authored by the
 * slicer/planner (or `mars task add --tag`) and consumed by the implement
 * workflow to pick a Worker from the registry. Adding a tag never widens
 * what a Worker can do — each tag maps to a single, pinned Worker.
 *
 * Free-form string: any non-empty string is valid. Well-known values:
 *   - `'coder'` → default. Routes to the Coder Worker (sonnet, bypass,
 *                 full tool surface).
 *
 * Untagged rows default to `['coder']` at the read boundary, preserving the
 * "quick escape hatch" behaviour for hand-written `mars task add` calls.
 */
export type TaskTag = string

/** Well-known built-in tags. Not exhaustive — any string is a valid tag. */
export const TASK_TAGS: readonly string[] = ['coder'] as const

export const isTaskTag = (value: unknown): value is TaskTag =>
  typeof value === 'string' && value.length > 0

/**
 * The phase that stamped a `'failed'` task. Set on the failure transition
 * by the implement workflow and consumed by `mars continue <id>` to decide
 * which step to resume from. `'code'` is reserved for failures that occur
 * before any verifiable artefact exists (e.g. install errors): such tasks
 * cannot be continued and must be restarted from scratch.
 */
export type FailedPhase = 'code' | 'verify' | 'merge'

/**
 * Structured-task contract (gsd-executor-style). When a task ships with a
 * spec, the implementor agent receives the prompt rendered as four explicit
 * sections — `<files>` (in-scope paths), `<verify>` (verification command),
 * `<done>` (boolean done criteria), and `task_type` — instead of free prose.
 *
 * `task_type='auto'` is the default: the agent executes end-to-end and
 * commits. `task_type='checkpoint'` pauses before merge for explicit human
 * verification (mirrors gsd's `checkpoint:human-verify`). Direct
 * `mars task add` rows without `--type` default to `'auto'`.
 *
 * Every field is optional on the type to preserve legacy free-form rows:
 * an empty/NULL spec degrades cleanly to the pre-existing prompt-only
 * behaviour. Slicer emissions always populate a full spec.
 */
export type TaskType = 'auto' | 'checkpoint'

export const TASK_TYPES: readonly TaskType[] = ['auto', 'checkpoint'] as const

export const isTaskType = (value: unknown): value is TaskType =>
  value === 'auto' || value === 'checkpoint'

/**
 * Coder-dispatchable artifact spec attached to an HITL slice. The slicer
 * emits this to describe a verify script (or similar artifact) a Coder can
 * build so the human operator has a runnable tool for the HITL step.
 */
export interface SubDeliverableSpec {
  title: string
  whatToBuild: string
  acceptanceCriteria: readonly string[]
  files?: readonly string[]
}

export interface TaskSpec {
  files: readonly string[]
  verifyCmd: string | null
  /**
   * Human-in-the-loop preview command. When non-null, the merge step does NOT
   * merge automatically: after a clean verify it starts this command as a live
   * dev server off the task's worktree, parks the task in 'awaiting-validation',
   * and raises an action-queue row with a clickable URL plus Validate / Reject
   * buttons. The exact command is authored on the task definition
   * (`mars task add ... --preview "npm run dev"`); tasks with no preview command
   * merge as before. Distinct from `verifyCmd`, which runs to completion and
   * gates on exit code; the preview command is long-running and gates on a human.
   */
  previewCmd: string | null
  doneCriteria: readonly string[]
  taskType: TaskType
  /**
   * Ordered list of files the implementor should read before editing.
   * Populated by the slicer; absent or empty on ad-hoc rows.
   */
  readFirst?: readonly string[]
  /**
   * Prescriptive action description for the implementor, may contain concrete
   * identifiers, file paths, and code-shaped language. Absent or null on
   * ad-hoc rows.
   */
  prescriptiveAction?: string | null
  /**
   * Slice routing kind. 'coder' (default) routes to the Coder worker;
   * 'hitl' routes to the human operator. Populated by the slicer; absent
   * on ad-hoc rows. Distinct from TaskKind ('task' | 'fix' | 'diagnose').
   */
  sliceKind?: 'coder' | 'hitl'
  /**
   * Coder-dispatchable sub-deliverable attached by the slicer to hitl slices.
   * Describes the artifact (typically a verify script) the operator will use.
   * Absent on coder slices and ad-hoc rows.
   */
  subDeliverable?: SubDeliverableSpec
}

export const EMPTY_TASK_SPEC: TaskSpec = {
  files: [],
  verifyCmd: null,
  previewCmd: null,
  doneCriteria: [],
  taskType: 'auto',
}

export interface TaskPlan {
  functional: string
  technical: string
}

export interface Task {
  id: string
  prompt: string
  status: TaskStatus
  plan: TaskPlan | null
  branch: string | null
  worktreePath: string | null
  claudeSessionId: string | null
  /**
   * Append-only history of every Claude session ID seen for this task,
   * in order of arrival. The latest entry mirrors {@link claudeSessionId}
   * (kept for backwards compatibility with callers that only want the
   * most recent pointer). Retries append; existing entries are never
   * dropped, so transcripts on disk remain reachable for `mars reflect`
   * and `mars arc reflect` across the full retry chain.
   */
  claudeSessionIds: string[]
  error: string | null
  author: Author | null
  dropReason: string | null
  failureReason: string | null
  /**
   * Typed catalog code (e.g. `verify:typecheck`) for the failure. Companion
   * to the loose-string `failureReason`. Slice G writes it on every failure
   * path; the legacy column stays for forensic continuity. Null on legacy
   * rows landed before slice G.
   */
  failureReasonCode: string | null
  retryCount: number
  fixForTaskId: string | null
  failureSignature: string | null
  /**
   * Marker for the task's role in the queue. See {@link TaskKind}. Optional
   * on the type but always populated at the persistence boundary; reads
   * derive a value via {@link deriveTaskKind} when the column is missing.
   */
  kind?: TaskKind
  /**
   * Routing hints that pick the Worker. See {@link TaskTag}. Always populated
   * at the persistence boundary (defaults to `['coder']` for tagless rows).
   * The implement workflow uses the first element as the primary routing tag.
   */
  tags: TaskTag[]
  originId: string
  priority: number
  /**
   * Set on the `'failed'` transition by the implement workflow's verify
   * and merge steps. `'code'` is reserved for setup-time failures that
   * cannot be continued. `null` for non-failed tasks and for legacy rows
   * that failed before this column existed.
   */
  failedPhase: FailedPhase | null
  /**
   * Structured-task contract. NULL on legacy rows where `prompt` is the
   * complete brief. When populated, `composePrompt` renders the spec on
   * top of `prompt` so the agent sees a typed checklist instead of free
   * prose. Slicer emissions and `mars task add --files/--verify/--done`
   * always populate this; ad-hoc `mars task add "..."` does not.
   */
  spec: TaskSpec | null
  /**
   * The integration-branch HEAD commit SHA captured the moment the task's
   * worktree was created at setup time. Null for tasks dispatched before
   * this column was added, or for resumed tasks that skip worktree creation.
   * A populated value is always a 40-character hex string.
   */
  integrationHeadSha: string | null
  /**
   * Live URL of the preview dev server for a task parked in
   * 'awaiting-validation' (e.g. `http://127.0.0.1:4321`). NULL whenever no
   * preview server is running. Persisted so the action-queue row's clickable
   * link survives a daemon restart.
   */
  devServerUrl: string | null
  /**
   * OS process id of the running preview dev server, NULL whenever none is
   * running. Persisted so the process can be reaped on Validate/Reject or by
   * the startup reconciler after a crash.
   */
  devServerPid: number | null
  /**
   * True once the operator clicked Validate on this task's preview gate. The
   * merge step gates only while this is false; after Validate the daemon flips
   * it true and re-queues, and the re-dispatched merge runs past the gate.
   * False on every task that never carries a preview command.
   */
  previewValidated: boolean
  /**
   * Recipe-specific payload preserved with a recovery task. NULL for every
   * non-recovery row. Slice F.2 stores `{ recipe, dirtyMainHash }` here for
   * `main-commiter` recoveries; later recipes that need typed sidecar state
   * can reuse the same column with their own JSON shape. The persistence
   * layer treats it as an opaque string; recipe code parses it.
   */
  recoveryPayload: string | null
  /**
   * One-line statement of what the task sets out to do, authored at creation
   * time and stored verbatim. Defaults to the first sentence of `prompt` when
   * not provided explicitly. Always a non-null string ('' on legacy rows that
   * predate the column but have not been backfilled yet).
   */
  intent: string
  /**
   * Owner identifier for a task parked in 'awaiting-human' (e.g. a username or
   * process label). NULL on every non-parked row and when no explicit owner was
   * supplied.
   */
  leaseOwner: string | null
  /**
   * ISO timestamp when the current worktree lease was acquired. NULL when no
   * active lease is held (i.e. the task is not in 'awaiting-human').
   */
  leasedAt: string | null
  /**
   * Optional human note attached to the lease describing the intended work.
   * NULL when none was provided.
   */
  leaseNote: string | null
  /**
   * UUID of the originating Claude Code operator session that enqueued this
   * task, captured from `CLAUDE_CODE_SESSION_ID` at the CLI boundary.
   * `null` when the task was created outside of a Claude Code session or
   * before this column existed.
   */
  originSessionId: string | null
  /**
   * Which user-owned pipeline runs this task: the dispatcher loads
   * `.mars/workflows/<workflow>-workflow.js`. `null` means default-by-kind
   * (the dispatcher resolves it to {@link kind}). Selected at enqueue via
   * `mars task add --workflow <name>`; orthogonal to `kind` by design.
   */
  workflow: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Derive the canonical `kind` for a task from its `fix-for` pointer. Used
 * during backfill of old rows and as the read-time default when a row is
 * fetched before the migration has run.
 */
export const deriveTaskKind = (fixForTaskId: string | null): TaskKind =>
  fixForTaskId === null ? 'task' : 'fix'

/**
 * Enforce the invariant that ties `kind` and `fixForTaskId` together.
 * Throws a precise message naming the bad combination; callers should let it
 * propagate so the writer sees the rejection.
 */
export const assertTaskKindInvariant = (
  kind: TaskKind,
  fixForTaskId: string | null,
): void => {
  if (kind === 'fix' && fixForTaskId === null) {
    throw new Error(
      `task kind 'fix' requires a non-null fix-for pointer; got null`,
    )
  }
  if (kind === 'task' && fixForTaskId !== null) {
    throw new Error(
      `task kind 'task' requires a null fix-for pointer; got ${fixForTaskId}`,
    )
  }
  if (kind === 'diagnose' && fixForTaskId !== null) {
    throw new Error(
      `task kind 'diagnose' requires a null fix-for pointer; got ${fixForTaskId}`,
    )
  }
}

export const MIN_PRIORITY = 0
export const MAX_PRIORITY = 3

export const validatePriority = (value: number): void => {
  if (!Number.isInteger(value) || value < MIN_PRIORITY || value > MAX_PRIORITY) {
    throw new Error(
      `priority must be an integer in ${MIN_PRIORITY}..${MAX_PRIORITY}; got ${value}`,
    )
  }
}

let clientSingleton: Client | null = null

/**
 * Seam-internal libsql client resolver for `.mars/mars.db` (ADR-0034: tasks
 * and proposals share one file). NOT part of the public surface (ADR-0021):
 * the only sanctioned importer is the TaskStore seam (`store/task-store.ts`),
 * which threads it to callers via the injected store. No live module outside
 * the store may import this — `getClient` is gone.
 */
export const resolveQueueClient = (): Client => {
  if (!clientSingleton) {
    const { queueDbPath } = resolveContext()
    clientSingleton = openLibsql({ url: `file:${queueDbPath}` })
  }
  return clientSingleton
}

/**
 * Seam-internal, idempotent schema migration for queue.db (ADR-0021: the
 * migration lives behind the store). The TaskStore drives this lazily and
 * memoises it; queue's own domain functions call it defensively. NOT public
 * — `initQueue` is gone.
 */
export const migrateQueueSchema = async (): Promise<void> => {
  const c = resolveQueueClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_functional TEXT,
      plan_technical TEXT,
      branch TEXT,
      worktree_path TEXT,
      claude_session_id TEXT,
      error TEXT,
      drop_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  // Migrate existing databases: add columns if missing.
  const cols = await c.execute(`PRAGMA table_info(tasks)`)
  const names = new Set(cols.rows.map((r) => (r as unknown as { name: string }).name))
  if (!names.has('plan_functional')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN plan_functional TEXT`)
  }
  if (!names.has('plan_technical')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN plan_technical TEXT`)
  }
  if (!names.has('claude_session_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN claude_session_id TEXT`)
  }
  // claude_session_ids was a legacy JSON-array column; it is now replaced by
  // the task_claude_sessions junction table. The ADD COLUMN migration has been
  // removed; the DROP COLUMN migration runs in the junction-tables section below.
  if (!names.has('author_kind')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN author_kind TEXT`)
  }
  if (!names.has('author_name')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN author_name TEXT`)
  }
  if (!names.has('drop_reason')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN drop_reason TEXT`)
  }
  if (!names.has('failure_reason')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN failure_reason TEXT`)
  }
  // failure_reason_code: typed, catalog-resolvable companion to the legacy
  // `failure_reason` string. Introduced in slice D; no path writes it yet
  // (slice F starts populating it for `verify:main-dirty`, later slices
  // rewire every other failure path). The legacy column stays as a loose-
  // string archive for forensic continuity during the rollout.
  if (!names.has('failure_reason_code')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN failure_reason_code TEXT`)
  }
  // recovery_payload: JSON blob populated only on recovery (kind='fix') rows
  // that need recipe-specific context preserved across restarts. Slice F.2
  // introduces it as the home of the dirty-main diff hash + recipe ref for
  // `main-commiter` recoveries; future recipes can co-opt the same column
  // rather than adding one per recipe. NULL on every non-recovery row and
  // on legacy recovery rows that predate this column. Schema-level type is
  // TEXT (libsql/sqlite has no JSON column type); application code parses
  // the JSON shape per recipe.
  if (!names.has('recovery_payload')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN recovery_payload TEXT`)
  }
  // branch, worktree_path, error were in the original CREATE TABLE but were
  // never guarded by ALTER TABLE add-if-missing checks.  Legacy minimal test
  // fixtures can omit them, so we add guards here so the FK-rebuild INSERT
  // SELECT always finds these columns in the source table.
  if (!names.has('branch')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN branch TEXT`)
  }
  if (!names.has('worktree_path')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT`)
  }
  if (!names.has('error')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN error TEXT`)
  }
  if (!names.has('retry_count')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`)
  }
  if (!names.has('fix_for_task_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN fix_for_task_id TEXT`)
  }
  if (!names.has('failure_signature')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN failure_signature TEXT`)
  }
  // kind: explicit marker for the task's role. Backfill from fix_for_task_id
  // so legacy rows match the invariant (`fix` iff fix_for_task_id IS NOT
  // NULL). SQLite cannot add a NOT NULL column without a DEFAULT to an
  // existing table reliably across libsql versions, so the column is
  // declared nullable at the schema level; the application-level
  // `assertTaskKindInvariant()` is the source of truth on writes, and the
  // read path coerces NULL via {@link deriveTaskKind}.
  if (!names.has('kind')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN kind TEXT`)
    // arch-guard:migration-write — ADR-0052 exemption. Backfill `kind` on legacy
    // rows; the marker is on the same physical line as the `UPDATE tasks SET`
    // token so the line-scoped strip exempts it (the trailing WHERE clause on
    // the next line carries no `UPDATE tasks SET`, so it is never matched).
    await c.execute(
      `UPDATE tasks SET kind = 'fix' WHERE kind IS NULL AND fix_for_task_id IS NOT NULL`, // arch-guard:migration-write
    )
    await c.execute(
      `UPDATE tasks SET kind = 'task' WHERE kind IS NULL AND fix_for_task_id IS NULL`, // arch-guard:migration-write
    )
  }
  // ADR-0049: purge pre-existing orphan fix rows — kind='fix' with a NULL
  // origin pointer. These violate the by-construction invariant introduced by
  // ADR-0049. The upsertFixTask path now always writes kind='fix' explicitly
  // and assertTaskKindInvariant guards the enqueueTask path; this idempotent
  // DELETE removes any surviving legacy anomalies so the invariant holds.
  //
  // First drop any task_blockers edges that reference these orphan fix rows.
  // task_blockers.{task_id,blocker_task_id} → tasks(id) are NO ACTION FKs, so
  // with foreign_keys=ON the DELETE below would fail with SQLITE_CONSTRAINT
  // while a child edge still points at a row being deleted. Legacy data has
  // had recovery (`fix`) tasks wired in as blockers (an ADR-0040 leaf-guard
  // violation), so such edges do exist; clearing them first lets the purge
  // proceed without leaving dangling references (which a foreign_keys=OFF
  // bracket would silently allow).
  //
  // `task_blockers` is created later in this same migration (see below), so on
  // a fresh DB it does not yet exist here — and a fresh DB has no orphan edges
  // to clear anyway. Guard the cleanup on the table being present so the
  // ordering holds for both fresh installs and legacy DBs.
  const hasTaskBlockers = (
    await c.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_blockers'`,
    )
  ).rows.length > 0
  if (hasTaskBlockers) {
    // arch-guard:migration-delete — ADR-0052 exemption. Removes ADR-0040
    // leaf-guard violation edges (fix tasks wired as blockers) from legacy DBs.
    await c.execute(`DELETE FROM task_blockers WHERE blocker_task_id IN (SELECT id FROM tasks WHERE kind = 'fix' AND fix_for_task_id IS NULL)`) // arch-guard:migration-delete
    await c.execute(`DELETE FROM task_blockers WHERE task_id IN (SELECT id FROM tasks WHERE kind = 'fix' AND fix_for_task_id IS NULL)`) // arch-guard:migration-delete
  }
  // arch-guard:migration-delete — ADR-0052 sole-writer exemption. This orphan
  // cleanup (kind='fix' rows with a NULL origin pointer, an ADR-0049
  // by-construction violation that can only exist on legacy DBs) is the ONE
  // genuinely-flaggable lifecycle DELETE inside migrateQueueSchema. The marker
  // is line-scoped: arc-sole-writer.test.ts drops only the SAME physical line
  // carrying it (the DELETE statement itself), so the marker cannot blanket-
  // disable the DELETE pattern elsewhere. It is migration-only; a real
  // lifecycle delete on a marked line would be a visible review red flag.
  await c.execute(
    `DELETE FROM tasks WHERE kind = 'fix' AND fix_for_task_id IS NULL`, // arch-guard:migration-delete
  )
  if (!names.has('priority')) {
    // CHECK constraint cannot be added via ALTER TABLE in SQLite; the
    // application-level validatePriority() guards inserts/updates instead.
    await c.execute(
      `ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
    )
  }
  // tag: Worker-routing hint. NULL on legacy rows; the read path coerces
  // NULL to 'coder' via {@link rowToTask}. New rows always carry a value;
  // the application-level {@link isTaskTag} guards writes.
  if (!names.has('tag')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN tag TEXT`)
    await c.execute(`UPDATE tasks SET tag = 'coder' WHERE tag IS NULL`) // arch-guard:migration-write
  }
  // tags_json: JSON-encoded string[] that supersedes the singular `tag` column.
  // Old rows carry only `tag`; new rows write only `tags_json`. The read path
  // in {@link rowToTask} parses `tags_json` and falls back to `[tag]` for
  // legacy rows. Both branches default to `['coder']` when the value is absent.
  if (!names.has('tags_json')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN tags_json TEXT`)
    // Backfill legacy rows: wrap the existing `tag` value (defaulting to 'coder') in a JSON array.
    await c.execute(
      `UPDATE tasks SET tags_json = json_array(COALESCE(tag, 'coder')) WHERE tags_json IS NULL`, // arch-guard:migration-write
    )
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks(priority DESC, created_at ASC)`,
  )
  // origin_id: stable id of the originating row (proposal or self-task) for
  // an arc of work. @libsql/client does not honour `DEFAULT (id)`
  // self-reference reliably, so the column is added without a default and
  // back/forward-filled explicitly: backfill old rows below, populate new
  // rows in enqueueTask.
  if (!names.has('origin_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN origin_id TEXT`)
    await c.execute(`UPDATE tasks SET origin_id = id WHERE origin_id IS NULL`) // arch-guard:migration-write
  }
  // parent_proposal_id: link from a task to the PRD it slices. NULL for
  // direct `mars task add` rows. slice_index records which slice this is
  // within the PRD (1..N), again NULL for direct tasks. Legacy DBs carry
  // this column as `parent_idea_id`; rename it in place (pure DDL, no data
  // move) before the add-column guard runs.
  if (names.has('parent_idea_id') && !names.has('parent_proposal_id')) {
    await c.execute(
      `ALTER TABLE tasks RENAME COLUMN parent_idea_id TO parent_proposal_id`,
    )
  }
  if (!names.has('parent_proposal_id') && !names.has('parent_idea_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN parent_proposal_id TEXT`)
  }
  if (!names.has('slice_index')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN slice_index INTEGER`)
  }
  // failed_phase: which step stamped the failure ('code' | 'verify' | 'merge').
  // Backed by application-level writes only on the failure transition; the
  // CHECK constraint is enforced in TypeScript (see {@link FailedPhase}).
  if (!names.has('failed_phase')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN failed_phase TEXT`)
  }
  // resume_from: LEGACY. It was the `mars continue` hint that told the old
  // Mastra dispatcher which step to skip into. Resume is now engine-driven —
  // the @mars/workflow engine resumes by re-dispatching with runId=task.id and
  // skipping already-`completed` step records — so this column is no longer
  // read or written. The CREATE is retained (no migration to drop it) so an
  // existing queue.db keeps its schema; new code simply ignores the column.
  if (!names.has('resume_from')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN resume_from TEXT`)
  }
  // Structured-task spec sidecar columns. The files_json and done_criteria_json
  // columns have been replaced by task_spec_files and task_done_criteria junction
  // tables respectively; their ADD COLUMN migrations are removed and the DROP
  // COLUMN migration runs in the junction-tables section below.
  if (!names.has('verify_cmd')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN verify_cmd TEXT`)
  }
  // preview_cmd: human-in-the-loop preview command (e.g. 'npm run dev'). When
  // set, the merge step starts it as a live dev server off the worktree and
  // parks the task in 'awaiting-validation' until the operator Validates or
  // Rejects via the action queue. NULL on tasks that merge automatically.
  if (!names.has('preview_cmd')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN preview_cmd TEXT`)
  }
  // dev_server_url / dev_server_pid: live coordinates of the preview dev server
  // for a task parked in 'awaiting-validation'. Persisted (not just in-memory)
  // so the clickable URL survives a daemon restart and the process can be
  // reaped on Validate/Reject or on startup reconcile. Both NULL otherwise.
  if (!names.has('dev_server_url')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN dev_server_url TEXT`)
  }
  if (!names.has('dev_server_pid')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN dev_server_pid INTEGER`)
  }
  // preview_validated: durable, restart-safe marker that the operator clicked
  // Validate on the preview gate. The merge step gates only when previewCmd is
  // set AND this is 0/NULL; once the daemon's validate handler flips it to 1
  // and re-queues, the re-dispatched merge re-enters past the gate and merges.
  // Stays 0/NULL on tasks that never gate.
  if (!names.has('preview_validated')) {
    await c.execute(
      `ALTER TABLE tasks ADD COLUMN preview_validated INTEGER NOT NULL DEFAULT 0`,
    )
  }
  if (!names.has('task_type')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN task_type TEXT`)
  }
  // read_first_json: ordered list of files the implementor should read before
  // editing. Populated by the slicer; NULL on ad-hoc rows.
  if (!names.has('read_first_json')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN read_first_json TEXT`)
  }
  // prescriptive_action: prescriptive action text for the implementor. NULL on
  // ad-hoc rows.
  if (!names.has('prescriptive_action')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN prescriptive_action TEXT`)
  }
  // slice_kind: routing hint emitted by the slicer ('coder' | 'hitl'). NULL on
  // ad-hoc rows and legacy slicer rows. 'hitl' marks slices that require a
  // human operator; 'coder' (default) dispatches to the Coder worker.
  if (!names.has('slice_kind')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN slice_kind TEXT`)
  }
  // sub_deliverable_json: JSON-encoded SubDeliverableSpec attached by the slicer
  // to hitl slices. Describes the Coder-dispatchable artifact (typically a
  // verify script) the operator will use. NULL on coder slices and ad-hoc rows.
  if (!names.has('sub_deliverable_json')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN sub_deliverable_json TEXT`)
  }
  // integration_head_sha: integration-branch HEAD SHA captured at setup time.
  // Null for tasks created before this column was added or that bypassed the
  // worktree creation path (e.g. resumed tasks). A populated value is always
  // a 40-character hex string.
  if (!names.has('integration_head_sha')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN integration_head_sha TEXT`)
  }
  // followup_dedup_key: the once-only dedup key for context-exhausted /
  // exploration-loop follow-up tasks, in the form 'followup:<originTaskId>:<kind>'.
  // This column replaces the old approach of stuffing the dedup key into origin_id,
  // allowing origin_id to carry genuine arc identity instead (ADR-0050). NULL on
  // every non-follow-up row.
  if (!names.has('followup_dedup_key')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN followup_dedup_key TEXT`)
  }
  // intent: one-line statement of what the task sets out to do, authored at
  // creation time. Backfilled from the first sentence of prompt for existing
  // rows so the field is never blank in practice.
  if (!names.has('intent')) {
    await c.execute(
      `ALTER TABLE tasks ADD COLUMN intent TEXT NOT NULL DEFAULT ''`,
    )
    // Backfill: intent = first sentence of prompt (split on '. ' or newline,
    // capped at 200 chars). Single-line so the line-scoped
    // `arch-guard:migration-write` marker (ADR-0052 exemption) can sit on the
    // same physical line as the `UPDATE tasks SET` token.
    await c.execute(
      `UPDATE tasks SET intent = SUBSTR(CASE WHEN INSTR(prompt, '. ') > 0 AND (INSTR(prompt, CHAR(10)) = 0 OR INSTR(prompt, '. ') < INSTR(prompt, CHAR(10))) THEN SUBSTR(prompt, 1, INSTR(prompt, '. ')) WHEN INSTR(prompt, CHAR(10)) > 0 THEN SUBSTR(prompt, 1, INSTR(prompt, CHAR(10)) - 1) ELSE prompt END, 1, 200) WHERE intent = ''`, // arch-guard:migration-write
    )
  }
  // lease_owner / leased_at / lease_note: operator-owned worktree lease fields
  // for tasks parked in 'awaiting-human'. All three are NULL on non-parked rows
  // and when the task has never held a lease.
  if (!names.has('lease_owner')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN lease_owner TEXT`)
  }
  if (!names.has('leased_at')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN leased_at TEXT`)
  }
  if (!names.has('lease_note')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN lease_note TEXT`)
  }
  // origin_session_id: UUID of the Claude Code operator session that enqueued
  // the task, captured from CLAUDE_CODE_SESSION_ID at the CLI boundary. NULL
  // on every row created outside a Claude Code session and on legacy rows.
  if (!names.has('origin_session_id')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN origin_session_id TEXT`)
  }
  // workflow: which user-owned pipeline file runs this task
  // (.mars/workflows/<workflow>-workflow.js). NULL means "default by kind" —
  // the dispatcher resolves NULL to the task's kind. A first-class axis,
  // deliberately NOT folded into `kind` (kind stays semantic: task|fix|diagnose).
  if (!names.has('workflow')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN workflow TEXT`)
  }
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_fix_for ON tasks(fix_for_task_id, failure_signature)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_origin_id ON tasks(origin_id)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_followup_dedup_key ON tasks(followup_dedup_key)`,
  )
  await c.execute(`DROP INDEX IF EXISTS idx_tasks_parent_idea_id`)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_parent_proposal_id ON tasks(parent_proposal_id)`,
  )
  // ADR-0050: migrate existing rows whose origin_id holds a synthetic
  // 'followup:<originTaskId>:<kind>' dedup key. Re-point origin_id at the
  // real arc origin (the originTaskId's own resolved origin_id) and move the
  // synthetic key into the dedicated followup_dedup_key column.
  const syntheticRows = await c.execute(
    `SELECT id, origin_id FROM tasks WHERE origin_id LIKE 'followup:%'`,
  )
  for (const rawRow of syntheticRows.rows) {
    const row = rawRow as unknown as { id: string; origin_id: string }
    // Parse 'followup:<originTaskId>:<kind>'
    const withoutPrefix = row.origin_id.slice('followup:'.length)
    const colonIdx = withoutPrefix.indexOf(':')
    if (colonIdx === -1) continue // malformed synthetic key — skip
    const originTaskId = withoutPrefix.slice(0, colonIdx)
    // Resolve the real origin_id of originTaskId.
    const originRow = await c.execute({
      sql: `SELECT origin_id, id FROM tasks WHERE id = ?`,
      args: [originTaskId],
    })
    const resolvedOriginId =
      originRow.rows.length > 0
        ? ((originRow.rows[0] as unknown as { origin_id: string | null; id: string })
            .origin_id ?? originTaskId)
        : originTaskId
    await c.execute({
      sql: `UPDATE tasks SET origin_id = ?, followup_dedup_key = ? WHERE id = ?`, // arch-guard:migration-write
      args: [resolvedOriginId, row.origin_id, row.id],
    })
  }
  // task_signals table intentionally omitted: migrated to trace_events in
  // PRD 436f14c7 slice 5 (see migrateSignalsAndTranscriptsToTraceEvents below).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_blockers (
      task_id         TEXT NOT NULL,
      blocker_task_id TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'confirmed'
                           CHECK (state IN ('confirmed','pending-review','rejected')),
      created_at      TEXT NOT NULL,
      PRIMARY KEY (task_id, blocker_task_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (blocker_task_id) REFERENCES tasks(id)
    )
  `)
  // PRD 2be831da: Blocker rows gain a `state` column that distinguishes
  // confirmed (default for causal writers) from pending-review (Linker
  // candidates) from rejected. Existing rows are preserved as 'confirmed'
  // so previously-gated dispatch is not silently released.
  const tbCols = await c.execute(`PRAGMA table_info(task_blockers)`)
  const tbNames = new Set(
    tbCols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!tbNames.has('state')) {
    await c.execute(
      `ALTER TABLE task_blockers ADD COLUMN state TEXT NOT NULL DEFAULT 'confirmed'`,
    )
    await c.execute(`UPDATE task_blockers SET state = 'confirmed' WHERE state IS NULL OR state = ''`) // arch-guard:migration-write
  }
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_blockers_task ON task_blockers(task_id)
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_blockers_blocker ON task_blockers(blocker_task_id)
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_blockers_task_state ON task_blockers(task_id, state)
  `)
  // ADR-0015 (amends ADR-0008): a Task MAY be blocked by an Idea, encoding
  // "this work is queued but cannot dispatch until that idea has been shaped
  // and promoted." This is the ONE allowed cross-graph direction; Task->Idea
  // reuse of `task_blockers` is forbidden (it would force a polymorphic
  // blocker_kind column and reintroduce the disambiguation ADR-0008
  // rejected), so this is a third, narrow junction with fixed endpoint
  // types. The ADR names it `idea_task_blockers`; the codebase renamed the
  // `idea_*` vocabulary to `proposal_*`, so we name it
  // `task_proposal_blockers` (columns: task_id waits on proposal_id).
  //
  // DB placement: this table conceptually GATES DISPATCH — the dispatcher
  // must not run a task while a row here references an un-promoted proposal.
  // Per ADR-0034 `tasks` and `proposals` now share a single `mars.db` file,
  // so both `task_id` and `proposal_id` carry real foreign keys with
  // `ON DELETE CASCADE` on the proposal side (dropping a promoted/dismissed
  // proposal collapses its dispatch gates atomically). The ADR-0015 promote
  // transfer (delete this row + insert the `task_blockers` row) still
  // executes as a single libSQL transaction — both writes land in the same
  // file. The earlier "pseudo-FK validated in application code" workaround
  // is gone.
  // Since proposals now lives in the SAME file as tasks (ADR-0034), the FK
  // target must exist before any insert into `task_proposal_blockers`. The
  // canonical creator is `initProposals` (proposals.ts), but it runs AFTER
  // `migrateQueueSchema` in `initDatabases`, and many call sites init only the
  // queue (tests, ad-hoc utilities) — so we pre-create the proposals table here
  // with the minimal `id PRIMARY KEY` shape needed to satisfy the FK.
  // `initProposals` keeps full ownership of column shape: its own
  // `CREATE TABLE IF NOT EXISTS proposals (...)` becomes a no-op, and the
  // additional columns it expects already exist (when initProposals follows
  // migrateQueueSchema in the standard path) OR get ALTERed in if a caller bypassed
  // initProposals entirely. The minimal stub here is forward-compatible.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      problem TEXT NOT NULL DEFAULT '',
      solution TEXT NOT NULL DEFAULT '',
      out_of_scope TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_proposal_blockers (
      task_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, proposal_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
    )
  `)
  // Upgrade path: an existing repo created the table before the FK landed.
  // Detect a missing `proposal_id` FK and rebuild via the standard SQLite
  // table-rebuild dance (CREATE … new + INSERT SELECT + DROP + RENAME).
  // Only runs when `proposals` exists in the same DB — fresh installs
  // get the FK baked in by the CREATE above and skip the rebuild.
  const proposalsCheck = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'`,
  )
  if (proposalsCheck.rows.length > 0) {
    const fkList = await c.execute(
      `PRAGMA foreign_key_list(task_proposal_blockers)`,
    )
    const hasProposalFk = fkList.rows.some((r) => {
      const row = r as unknown as { table: string; from: string }
      return row.table === 'proposals' && row.from === 'proposal_id'
    })
    if (!hasProposalFk) {
      await c.execute(`
        CREATE TABLE task_proposal_blockers_new (
          task_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (task_id, proposal_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE
        )
      `)
      // Drop orphan rows (proposal_id pointing nowhere) before copy —
      // they would fail the new FK check otherwise.
      await c.execute(`
        INSERT INTO task_proposal_blockers_new (task_id, proposal_id, created_at)
          SELECT b.task_id, b.proposal_id, b.created_at
            FROM task_proposal_blockers b
            JOIN proposals p ON p.id = b.proposal_id
      `)
      await c.execute(`DROP TABLE task_proposal_blockers`)
      await c.execute(
        `ALTER TABLE task_proposal_blockers_new RENAME TO task_proposal_blockers`,
      )
    }
  }
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_proposal_blockers_task ON task_proposal_blockers(task_id)
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_proposal_blockers_proposal ON task_proposal_blockers(proposal_id)
  `)
  // Migrate legacy `tasks.blocker_id` -> `task_blockers` rows. blocker_id used
  // to point into task_suggestions; the fix task itself is reachable via the
  // suggestion's created_task_id. Where the suggestion no longer exists or
  // has no created_task_id, the link is dropped (the dependent task is left
  // blocked but with no recorded blocker — `mars unblock` is the escape
  // hatch). After backfill the column is dropped to keep the schema honest.
  if (names.has('blocker_id')) {
    const sugTable = await c.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_suggestions'`,
    )
    if (sugTable.rows.length > 0) {
      const linkRows = await c.execute(`
        SELECT t.id AS task_id, s.created_task_id AS fix_task_id
          FROM tasks t
          JOIN task_suggestions s ON s.id = t.blocker_id
         WHERE t.blocker_id IS NOT NULL
           AND s.created_task_id IS NOT NULL
      `)
      const now = new Date().toISOString()
      for (const row of linkRows.rows) {
        const r = row as unknown as { task_id: string; fix_task_id: string }
        const fixTask = await c.execute({
          sql: `SELECT 1 FROM tasks WHERE id = ?`,
          args: [r.fix_task_id],
        })
        if (fixTask.rows.length === 0) continue
        await c.execute({
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`, // arch-guard:migration-write
          args: [r.task_id, r.fix_task_id, now],
        })
      }
    }
    await c.execute(`UPDATE tasks SET blocker_id = NULL`) // arch-guard:migration-write
    await c.execute(`ALTER TABLE tasks DROP COLUMN blocker_id`)
  }
  // task_acceptance: per-task acceptance criteria (Definition of Done).
  // Authored deterministically by the slicer; not retroactively added to
  // direct `mars task add` rows or to recovery fix-tasks. The worker ticks
  // each row off via `mars task <id> acceptance pass <pos>` and the
  // implement workflow soft-enforces the list after the worker session
  // exits (any row still 'pending' parks the task in 'blocked').
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_acceptance (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, position)
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_task_acceptance_task ON task_acceptance(task_id)`,
  )
  // self_heal_attempts: append-only ledger of fix-tasks the sweeper enqueues
  // in response to a parent task's verify failure. Keyed by (parent_task_id,
  // failure_signature) so the sweeper can dedupe — if a row already exists
  // for the same parent+signature, the sweeper must not re-enqueue an
  // identical fix-task. `fix_task_id` is the id of the spawned fix-task and
  // `created_at` records when the attempt was recorded. CREATE TABLE IF NOT
  // EXISTS is idempotent on existing databases; the composite index covers
  // the dedup lookup path.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS self_heal_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_task_id TEXT NOT NULL,
      failure_signature TEXT NOT NULL,
      fix_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_self_heal_attempts_parent_signature
       ON self_heal_attempts(parent_task_id, failure_signature)`,
  )
  // ── Self-referential / *_task_id FK constraints via table-rebuild ─────────
  // SQLite cannot add FK constraints to existing tables via ALTER TABLE. The
  // standard pattern is CREATE new + INSERT SELECT + DROP + RENAME. We detect
  // whether the rebuild has already run by checking PRAGMA foreign_key_list;
  // once the FK is present the section is skipped on every subsequent startup.
  //
  // tasks rebuild adds:
  //   fix_for_task_id    REFERENCES tasks(id)    (self-referential fix-task pointer)
  //   parent_proposal_id REFERENCES proposals(id)
  //   origin_id: FK intentionally omitted — origin_id can hold proposal IDs or
  //     other non-task arc identifiers; REFERENCES tasks(id) would reject them.
  // self_heal_attempts rebuild adds:
  //   fix_task_id REFERENCES tasks(id) ON DELETE CASCADE
  //
  // Both rebuilds share one PRAGMA foreign_keys = OFF / ON bracket so the
  // intermediate state (tables dropped but not yet renamed) is never observed
  // with FK enforcement active.
  {
    const taskFkRows = await c.execute(`PRAGMA foreign_key_list(tasks)`)
    const tasksNeedFkRebuild = !(
      taskFkRows.rows as unknown as Array<{ from: string }>
    ).some((r) => r.from === 'fix_for_task_id')

    // Detect missing or outdated CHECK constraint on tasks.status. SQLite cannot
    // add/modify CHECK via ALTER TABLE, so we inspect the CREATE TABLE statement
    // in sqlite_master. A rebuild is needed when the constraint is absent OR when
    // it does not include every current status value (e.g. 'under_investigation'
    // was added after the constraint was originally written).
    const tasksSqlRow = (
      await c.execute(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`,
      )
    ).rows[0] as unknown as { sql: string } | undefined
    const tasksSql = tasksSqlRow?.sql ?? ''
    const tasksNeedCheckRebuild =
      !tasksSql.includes('CHECK (status IN') ||
      !tasksSql.includes("'under_investigation'") ||
      !tasksSql.includes("'awaiting-validation'") ||
      !tasksSql.includes("'awaiting-human'")

    const healFkRows = await c.execute(
      `PRAGMA foreign_key_list(self_heal_attempts)`,
    )
    const healNeedsFkRebuild = !(
      healFkRows.rows as unknown as Array<{ from: string }>
    ).some((r) => r.from === 'fix_task_id')

    if (tasksNeedFkRebuild || tasksNeedCheckRebuild || healNeedsFkRebuild) {
      await c.execute(`PRAGMA foreign_keys = OFF`)

      if (tasksNeedFkRebuild || tasksNeedCheckRebuild) {
        // Backfill junction tables from any legacy JSON columns that exist on the
        // current tasks table BEFORE we drop-and-rebuild it, so no row loses its
        // files/doneCriteria/sessionIds data when those columns are omitted from
        // tasks_new. The CREATE TABLE IF NOT EXISTS calls are idempotent.
        if (names.has('claude_session_ids') || names.has('claude_session_id')) {
          await c.execute(`
            CREATE TABLE IF NOT EXISTS task_claude_sessions (
              task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              session_id TEXT    NOT NULL,
              position   INTEGER NOT NULL,
              PRIMARY KEY (task_id, session_id)
            )
          `)
          await c.execute(
            `CREATE INDEX IF NOT EXISTS idx_task_claude_sessions_task
               ON task_claude_sessions(task_id, position)`,
          )
          if (names.has('claude_session_ids')) {
            await c.execute(`
              INSERT OR IGNORE INTO task_claude_sessions (task_id, session_id, position)
              SELECT t.id, je.value, je.key
              FROM tasks t, json_each(
                CASE
                  WHEN t.claude_session_ids IS NOT NULL
                    AND json_valid(t.claude_session_ids)
                    AND json_array_length(t.claude_session_ids) > 0
                  THEN t.claude_session_ids
                  WHEN t.claude_session_id IS NOT NULL
                  THEN json_array(t.claude_session_id)
                  ELSE '[]'
                END
              ) AS je
              WHERE je.value IS NOT NULL AND je.value != ''
            `)
          } else {
            await c.execute(`
              INSERT OR IGNORE INTO task_claude_sessions (task_id, session_id, position)
              SELECT t.id, t.claude_session_id, 0
              FROM tasks t
              WHERE t.claude_session_id IS NOT NULL AND t.claude_session_id != ''
            `)
          }
        }
        if (names.has('files_json')) {
          await c.execute(`
            CREATE TABLE IF NOT EXISTS task_spec_files (
              task_id  TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              path     TEXT    NOT NULL,
              position INTEGER NOT NULL,
              PRIMARY KEY (task_id, path)
            )
          `)
          await c.execute(
            `CREATE INDEX IF NOT EXISTS idx_task_spec_files_task
               ON task_spec_files(task_id, position)`,
          )
          await c.execute(`
            INSERT OR IGNORE INTO task_spec_files (task_id, path, position)
            SELECT t.id, je.value, je.key
            FROM tasks t, json_each(
              CASE
                WHEN t.files_json IS NOT NULL
                  AND json_valid(t.files_json)
                  AND json_array_length(t.files_json) > 0
                THEN t.files_json
                ELSE '[]'
              END
            ) AS je
            WHERE je.value IS NOT NULL AND je.value != ''
          `)
        }
        if (names.has('done_criteria_json')) {
          await c.execute(`
            CREATE TABLE IF NOT EXISTS task_done_criteria (
              task_id   TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              criterion TEXT    NOT NULL,
              position  INTEGER NOT NULL,
              PRIMARY KEY (task_id, criterion)
            )
          `)
          await c.execute(
            `CREATE INDEX IF NOT EXISTS idx_task_done_criteria_task
               ON task_done_criteria(task_id, position)`,
          )
          await c.execute(`
            INSERT OR IGNORE INTO task_done_criteria (task_id, criterion, position)
            SELECT t.id, je.value, je.key
            FROM tasks t, json_each(
              CASE
                WHEN t.done_criteria_json IS NOT NULL
                  AND json_valid(t.done_criteria_json)
                  AND json_array_length(t.done_criteria_json) > 0
                THEN t.done_criteria_json
                ELSE '[]'
              END
            ) AS je
            WHERE je.value IS NOT NULL AND je.value != ''
          `)
        }
        // Drop any incomplete prior rebuild attempt to ensure idempotency.
        await c.execute(`DROP TABLE IF EXISTS tasks_new`)
        await c.execute(`
          CREATE TABLE tasks_new (
            id                   TEXT    PRIMARY KEY,
            prompt               TEXT    NOT NULL,
            status               TEXT    NOT NULL
                                         CHECK (status IN ('draft','triaging','queued','running','verifying','awaiting-validation','awaiting-human','merging','vega-reconciling','done','failed','dropped','blocked','under_investigation')),
            plan_functional      TEXT,
            plan_technical       TEXT,
            branch               TEXT,
            worktree_path        TEXT,
            claude_session_id    TEXT,
            error                TEXT,
            drop_reason          TEXT,
            retry_count          INTEGER NOT NULL DEFAULT 0,
            author_kind          TEXT,
            author_name          TEXT,
            failure_reason       TEXT,
            failure_reason_code  TEXT,
            recovery_payload     TEXT,
            fix_for_task_id      TEXT    REFERENCES tasks_new(id),
            failure_signature    TEXT,
            kind                 TEXT,
            priority             INTEGER NOT NULL DEFAULT 0,
            tag                  TEXT,
            tags_json            TEXT,
            -- origin_id intentionally has no FK: it can hold proposal IDs or other
            -- non-task arc identifiers, so REFERENCES tasks(id) would reject valid data.
            origin_id            TEXT,
            parent_proposal_id   TEXT    REFERENCES proposals(id),
            slice_index          INTEGER,
            failed_phase         TEXT,
            resume_from          TEXT,
            verify_cmd           TEXT,
            preview_cmd          TEXT,
            dev_server_url       TEXT,
            dev_server_pid       INTEGER,
            preview_validated    INTEGER NOT NULL DEFAULT 0,
            task_type            TEXT,
            read_first_json      TEXT,
            prescriptive_action  TEXT,
            slice_kind           TEXT,
            sub_deliverable_json TEXT,
            integration_head_sha TEXT,
            followup_dedup_key   TEXT,
            intent               TEXT    NOT NULL DEFAULT '',
            lease_owner          TEXT,
            leased_at            TEXT,
            lease_note           TEXT,
            origin_session_id    TEXT,
            workflow             TEXT,
            created_at           TEXT    NOT NULL,
            updated_at           TEXT    NOT NULL
          )
        `)
        await c.execute(`
          INSERT INTO tasks_new (
            id, prompt, status, plan_functional, plan_technical,
            branch, worktree_path, claude_session_id,
            error, drop_reason, retry_count, author_kind, author_name,
            failure_reason, failure_reason_code, recovery_payload,
            fix_for_task_id, failure_signature, kind, priority, tag, tags_json,
            origin_id, parent_proposal_id, slice_index, failed_phase, resume_from,
            verify_cmd, preview_cmd, dev_server_url, dev_server_pid, preview_validated, task_type, read_first_json,
            prescriptive_action, slice_kind, sub_deliverable_json,
            integration_head_sha, followup_dedup_key, intent,
            lease_owner, leased_at, lease_note,
            origin_session_id, workflow,
            created_at, updated_at
          )
          SELECT
            id, prompt, status, plan_functional, plan_technical,
            branch, worktree_path, claude_session_id,
            error, drop_reason, COALESCE(retry_count, 0),
            author_kind, author_name, failure_reason, failure_reason_code,
            recovery_payload, fix_for_task_id, failure_signature, kind,
            COALESCE(priority, 0), tag, tags_json,
            COALESCE(origin_id, id),
            parent_proposal_id, slice_index, failed_phase, resume_from,
            verify_cmd, preview_cmd, dev_server_url, dev_server_pid, COALESCE(preview_validated, 0), task_type, read_first_json,
            prescriptive_action, slice_kind, sub_deliverable_json,
            integration_head_sha, followup_dedup_key, COALESCE(intent, ''),
            lease_owner, leased_at, lease_note,
            origin_session_id, workflow,
            created_at, updated_at
          FROM tasks
        `)
        // Re-run the legacy origin_id backfill inside the rebuild to ensure
        // every row self-assigns when origin_id is still absent.
        await c.execute(
          `UPDATE tasks_new SET origin_id = id WHERE origin_id IS NULL`,
        )
        await c.execute(`DROP TABLE tasks`)
        await c.execute(`ALTER TABLE tasks_new RENAME TO tasks`)
        // Recreate indexes dropped with the old table.
        await c.execute(
          `CREATE INDEX IF NOT EXISTS idx_tasks_priority_created
             ON tasks(priority DESC, created_at ASC)`,
        )
        await c.execute(
          `CREATE INDEX IF NOT EXISTS idx_tasks_fix_for
             ON tasks(fix_for_task_id, failure_signature)`,
        )
        await c.execute(
          `CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`,
        )
        await c.execute(
          `CREATE INDEX IF NOT EXISTS idx_tasks_origin_id ON tasks(origin_id)`,
        )
        await c.execute(
          `CREATE INDEX IF NOT EXISTS idx_tasks_parent_proposal_id
             ON tasks(parent_proposal_id)`,
        )
        await c.execute(
          `CREATE INDEX IF NOT EXISTS idx_tasks_followup_dedup_key
             ON tasks(followup_dedup_key)`,
        )
      }

      if (healNeedsFkRebuild) {
        await c.execute(`DROP TABLE IF EXISTS self_heal_attempts_new`)
        await c.execute(`
          CREATE TABLE self_heal_attempts_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_task_id    TEXT    NOT NULL,
            failure_signature TEXT    NOT NULL,
            fix_task_id       TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            created_at        TEXT    NOT NULL
          )
        `)
        // Drop orphan rows whose fix_task_id no longer exists in tasks so the
        // INSERT respects the FK constraint once enforcement is re-enabled.
        await c.execute(`
          INSERT INTO self_heal_attempts_new
                (id, parent_task_id, failure_signature, fix_task_id, created_at)
          SELECT id, parent_task_id, failure_signature, fix_task_id, created_at
            FROM self_heal_attempts
           WHERE fix_task_id IN (SELECT id FROM tasks)
        `)
        await c.execute(`DROP TABLE self_heal_attempts`)
        await c.execute(
          `ALTER TABLE self_heal_attempts_new RENAME TO self_heal_attempts`,
        )
        await c.execute(
          `CREATE INDEX IF NOT EXISTS idx_self_heal_attempts_parent_signature
             ON self_heal_attempts(parent_task_id, failure_signature)`,
        )
      }

      await c.execute(`PRAGMA foreign_keys = ON`)
    }
  }
  // ── task_blockers: add provenance column if missing ──────────────────────
  // Tracks whether each blocker edge was determined mechanically from
  // declared file overlap ('file-overlap') or by the auto-linker LLM
  // direction judge / slicer LLM ('inferred'). Defaults to 'inferred' so
  // pre-existing edges are treated as LLM-produced (safe: they are).
  {
    const tbProvCols = await c.execute(`PRAGMA table_info(task_blockers)`)
    const tbProvNames = new Set(
      tbProvCols.rows.map((r) => (r as unknown as { name: string }).name),
    )
    if (!tbProvNames.has('provenance')) {
      await c.execute(
        `ALTER TABLE task_blockers ADD COLUMN provenance TEXT NOT NULL DEFAULT 'inferred'`,
      )
    }
  }
  // ── task_blockers: add CHECK (state IN …) if missing ─────────────────────
  // SQLite cannot add CHECK constraints via ALTER TABLE, so we use the table-
  // rebuild pattern. Detection: query sqlite_master for the CREATE TABLE sql.
  {
    const tbSqlRow = (
      await c.execute(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='task_blockers'`,
      )
    ).rows[0] as unknown as { sql: string } | undefined
    if (!(tbSqlRow?.sql ?? '').includes('CHECK (state IN')) {
      await c.execute(`PRAGMA foreign_keys = OFF`)
      await c.execute(`DROP TABLE IF EXISTS task_blockers_new`)
      await c.execute(`
        CREATE TABLE task_blockers_new (
          task_id          TEXT NOT NULL,
          blocker_task_id  TEXT NOT NULL,
          state            TEXT NOT NULL DEFAULT 'confirmed'
                                CHECK (state IN ('confirmed','pending-review','rejected')),
          created_at       TEXT NOT NULL,
          PRIMARY KEY (task_id, blocker_task_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (blocker_task_id) REFERENCES tasks(id)
        )
      `)
      await c.execute(`
        INSERT INTO task_blockers_new (task_id, blocker_task_id, state, created_at)
        SELECT task_id, blocker_task_id, state, created_at FROM task_blockers
      `)
      await c.execute(`DROP TABLE task_blockers`)
      await c.execute(`ALTER TABLE task_blockers_new RENAME TO task_blockers`)
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_task_blockers_task
           ON task_blockers(task_id)`,
      )
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_task_blockers_blocker
           ON task_blockers(blocker_task_id)`,
      )
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_task_blockers_task_state
           ON task_blockers(task_id, state)`,
      )
      await c.execute(`PRAGMA foreign_keys = ON`)
    }
  }
  await healBlobPrompts(c)
  // Wire-bus outbox: events published by library code land atomically with the
  // state writes they describe (same queue.db, same libsql transaction).
  // Cursor-based fan-out consumers poll for id > cursor.
  // Retention is enforced periodically by orchestrator/src/core/daemon/outbox-sweeper.ts (prune by age + wedged-subscriber lag detection).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      type    TEXT    NOT NULL,
      payload TEXT    NOT NULL,
      ts      INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_events_id ON events(id)`,
  )
  // ADR-0038: KPI snapshot table. One row per operator-triggered snapshot.
  // Holds a 7-day rolling window of the four-KPI vector. Each KPI carries its
  // own sample_count and low_confidence pair so that trust signals are
  // measured over the population that KPI was actually computed over.
  // No composite health-score column is permitted (ADR-0038 explicitly forbids it).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS kpi_snapshots (
      id TEXT PRIMARY KEY,
      taken_at TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      cost_per_arc_sample_count INTEGER NOT NULL,
      cost_per_arc_low_confidence INTEGER NOT NULL,
      failure_rate_sample_count INTEGER NOT NULL,
      failure_rate_low_confidence INTEGER NOT NULL,
      autonomous_completion_rate_sample_count INTEGER NOT NULL,
      autonomous_completion_rate_low_confidence INTEGER NOT NULL,
      recovery_success_rate_sample_count INTEGER NOT NULL,
      recovery_success_rate_low_confidence INTEGER NOT NULL,
      cost_per_arc_p50 REAL,
      cost_per_arc_p90 REAL,
      failure_rate REAL,
      autonomous_completion_rate REAL,
      recovery_success_rate REAL
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_taken_at ON kpi_snapshots(taken_at)`,
  )
  // ── kpi_snapshots: migrate old shared sample_count schema to per-KPI columns ──
  // The a3b35e53 commit (2026-06-10) changed kpi_snapshots from a single shared
  // `sample_count` / `low_confidence` pair to eight per-KPI columns. Because the
  // creation above uses CREATE TABLE IF NOT EXISTS, existing DBs silently kept
  // the old schema. takeKpiSnapshot then failed at INSERT time (referencing columns
  // that did not exist), the error was swallowed by the daemon's try/catch, and
  // no snapshot rows were written after the daemon restarted — the root cause of
  // the June-11 capture gap.
  //
  // Fix: detect the old schema (presence of `sample_count`) and DROP + recreate.
  // kpi_snapshots rows carry no business data (they are aggregate stats over
  // tasks, which are the source of truth); losing pre-migration rows is safe.
  {
    const kpiCols = await c.execute(`PRAGMA table_info(kpi_snapshots)`)
    const kpiColNames = new Set(
      (kpiCols.rows as unknown as Array<{ name: string }>).map((r) => r.name),
    )
    if (kpiColNames.has('sample_count')) {
      await c.execute(`DROP TABLE kpi_snapshots`)
      await c.execute(`DROP INDEX IF EXISTS idx_kpi_snapshots_taken_at`)
      await c.execute(`
        CREATE TABLE kpi_snapshots (
          id TEXT PRIMARY KEY,
          taken_at TEXT NOT NULL,
          window_start TEXT NOT NULL,
          window_end TEXT NOT NULL,
          cost_per_arc_sample_count INTEGER NOT NULL,
          cost_per_arc_low_confidence INTEGER NOT NULL,
          failure_rate_sample_count INTEGER NOT NULL,
          failure_rate_low_confidence INTEGER NOT NULL,
          autonomous_completion_rate_sample_count INTEGER NOT NULL,
          autonomous_completion_rate_low_confidence INTEGER NOT NULL,
          recovery_success_rate_sample_count INTEGER NOT NULL,
          recovery_success_rate_low_confidence INTEGER NOT NULL,
          cost_per_arc_p50 REAL,
          cost_per_arc_p90 REAL,
          failure_rate REAL,
          autonomous_completion_rate REAL,
          recovery_success_rate REAL
        )
      `)
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_taken_at ON kpi_snapshots(taken_at)`,
      )
    }
  }
  // ── Normalized junction tables for JSON-blob columns ───────────────────
  // These three tables replace the `claude_session_ids`, `files_json`, and
  // `done_criteria_json` JSON blob columns on `tasks`.  They are created here
  // (idempotent) and back-filled from the legacy columns once.  New writes go
  // exclusively to these tables; all read paths (TASK_SEL, progress.ts) read
  // from them via correlated subqueries.  The legacy columns are then dropped
  // (hard cut — no fallback remains).
  //
  // task_claude_sessions: ordered history of Claude session IDs across retries
  // (replaces tasks.claude_session_ids JSON array and the legacy
  // tasks.claude_session_id scalar).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_claude_sessions (
      task_id    TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT    NOT NULL,
      position   INTEGER NOT NULL,
      PRIMARY KEY (task_id, session_id)
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_task_claude_sessions_task
       ON task_claude_sessions(task_id, position)`,
  )
  // task_spec_files: ordered list of paths the coder should read first
  // (replaces tasks.files_json JSON array).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_spec_files (
      task_id  TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      path     TEXT    NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (task_id, path)
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_task_spec_files_task
       ON task_spec_files(task_id, position)`,
  )
  // task_done_criteria: ordered list of completion criteria (replaces
  // tasks.done_criteria_json JSON array).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_done_criteria (
      task_id   TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      criterion TEXT    NOT NULL,
      position  INTEGER NOT NULL,
      PRIMARY KEY (task_id, criterion)
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_task_done_criteria_task
       ON task_done_criteria(task_id, position)`,
  )
  // Re-check column presence after any FK/CHECK rebuild that may have already
  // removed some of the legacy columns from the schema.
  {
    const freshColsRows = await c.execute(`PRAGMA table_info(tasks)`)
    const freshNames = new Set(
      freshColsRows.rows.map((r) => (r as unknown as { name: string }).name),
    )
    // Back-fill from any remaining legacy columns before dropping them.
    // The backfill is guarded per-column so we never reference a missing column.
    if (freshNames.has('claude_session_ids')) {
      await c.execute(`
        INSERT OR IGNORE INTO task_claude_sessions (task_id, session_id, position)
        SELECT t.id, je.value, je.key
        FROM tasks t, json_each(
          CASE
            WHEN t.claude_session_ids IS NOT NULL
              AND json_valid(t.claude_session_ids)
              AND json_array_length(t.claude_session_ids) > 0
            THEN t.claude_session_ids
            WHEN t.claude_session_id IS NOT NULL
            THEN json_array(t.claude_session_id)
            ELSE '[]'
          END
        ) AS je
        WHERE je.value IS NOT NULL AND je.value != ''
      `)
    } else if (freshNames.has('claude_session_id')) {
      // claude_session_ids was already dropped (or never existed); seed from scalar.
      await c.execute(`
        INSERT OR IGNORE INTO task_claude_sessions (task_id, session_id, position)
        SELECT t.id, t.claude_session_id, 0
        FROM tasks t
        WHERE t.claude_session_id IS NOT NULL AND t.claude_session_id != ''
      `)
    }
    if (freshNames.has('files_json')) {
      await c.execute(`
        INSERT OR IGNORE INTO task_spec_files (task_id, path, position)
        SELECT t.id, je.value, je.key
        FROM tasks t, json_each(
          CASE
            WHEN t.files_json IS NOT NULL
              AND json_valid(t.files_json)
              AND json_array_length(t.files_json) > 0
            THEN t.files_json
            ELSE '[]'
          END
        ) AS je
        WHERE je.value IS NOT NULL AND je.value != ''
      `)
    }
    if (freshNames.has('done_criteria_json')) {
      await c.execute(`
        INSERT OR IGNORE INTO task_done_criteria (task_id, criterion, position)
        SELECT t.id, je.value, je.key
        FROM tasks t, json_each(
          CASE
            WHEN t.done_criteria_json IS NOT NULL
              AND json_valid(t.done_criteria_json)
              AND json_array_length(t.done_criteria_json) > 0
            THEN t.done_criteria_json
            ELSE '[]'
          END
        ) AS je
        WHERE je.value IS NOT NULL AND je.value != ''
      `)
    }
    // Hard-cut: drop the three legacy columns now that data is safely in the
    // junction tables. Guards prevent errors when the columns are already absent
    // (e.g. fresh DB, or a DB that went through the FK rebuild that already
    // excluded them from tasks_new).
    if (freshNames.has('claude_session_ids')) {
      await c.execute(`ALTER TABLE tasks DROP COLUMN claude_session_ids`)
    }
    if (freshNames.has('files_json')) {
      await c.execute(`ALTER TABLE tasks DROP COLUMN files_json`)
    }
    if (freshNames.has('done_criteria_json')) {
      await c.execute(`ALTER TABLE tasks DROP COLUMN done_criteria_json`)
    }
  }
  // ── questions: ensure table and ON DELETE CASCADE ─────────────────────────
  // The questions table records coder clarification questions for a task.
  // It was introduced on some live databases WITHOUT ON DELETE CASCADE on its
  // task_id FK, which caused SQLITE_CONSTRAINT violations on 'mars list' when
  // orphaned rows dangled after a task was purged. This block:
  //   1. Creates the table fresh (with CASCADE) on new databases.
  //   2. On existing databases that lack CASCADE: removes orphaned rows first,
  //      then rebuilds the table with CASCADE using the standard SQLite
  //      table-rebuild pattern (SQLite cannot ALTER a FK).
  {
    const qSqlRow = (
      await c.execute(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'`,
      )
    ).rows[0] as unknown as { sql: string } | undefined

    if (!qSqlRow) {
      await c.execute(`
        CREATE TABLE IF NOT EXISTS questions (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          question   TEXT NOT NULL,
          rationale  TEXT,
          category   TEXT,
          answer     TEXT,
          status     TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `)
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id)`,
      )
    } else if (!(qSqlRow.sql ?? '').includes('ON DELETE CASCADE')) {
      await c.execute(`PRAGMA foreign_keys = OFF`)
      // Remove orphaned rows before the copy so the FK in questions_new never
      // fires against a gone parent (even with FK enforcement off, keeping the
      // data clean is the right thing to do).
      await c.execute(
        `DELETE FROM questions WHERE task_id NOT IN (SELECT id FROM tasks)`,
      )
      await c.execute(`DROP TABLE IF EXISTS questions_new`)
      await c.execute(`
        CREATE TABLE questions_new (
          id         TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          question   TEXT NOT NULL,
          rationale  TEXT,
          category   TEXT,
          answer     TEXT,
          status     TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        )
      `)
      await c.execute(`
        INSERT INTO questions_new (id, task_id, question, rationale, category, answer, status, created_at)
        SELECT id, task_id, question, rationale, category, answer, status, created_at
        FROM questions
      `)
      await c.execute(`DROP TABLE questions`)
      await c.execute(`ALTER TABLE questions_new RENAME TO questions`)
      await c.execute(
        `CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id)`,
      )
      await c.execute(`PRAGMA foreign_keys = ON`)
    }
  }
  await migrateSignalsAndTranscriptsToTraceEvents(c)
  // task_transcripts: incremental streaming transcript storage added AFTER the
  // migration above so the migration can safely check for the OLD table schema
  // (which had verify_output) and drop it before we create the NEW table.
  // The OLD task_transcripts was migrated to trace_events in PRD 436f14c7
  // slice 5; this NEW table is keyed by (task_id, session_id, seq) and stores
  // streaming chunk batches written during coder runs for durability.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_transcripts (
      task_id    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      chunk      TEXT NOT NULL,
      ts         TEXT NOT NULL,
      PRIMARY KEY (task_id, session_id, seq)
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_task_transcripts_task ON task_transcripts (task_id, ts)`,
  )
}

/**
 * One-time startup migration (PRD 436f14c7 slice 5): lift every row from the
 * legacy task_signals and task_transcripts tables into the unified trace_events
 * table as synthesised step_ended events, then drop the old tables.
 *
 * Synthesis rules (documented honestly so future readers are not surprised):
 *   - step_name = 'code'  All historical coder runs lived in these tables.
 *                          The original step_id from task_signals is preserved
 *                          in payload.legacyStepId for auditability.
 *   - outcome   = 'success'  Synthesised — failed tasks were retried and their
 *                             final state is recorded in tasks.status, not here.
 *   - timestamp = recorded_at  The legacy column held a write-time ISO string
 *                               so this approximates span end time, not exact
 *                               start time.
 *   - payload.migrated = true  Marker so callers can identify reconstructed rows.
 *
 * Idempotent: if both tables are absent the function is a no-op.
 * INSERT OR IGNORE ensures partial migrations (crash between copy and DROP)
 * do not produce duplicates.
 */
const migrateSignalsAndTranscriptsToTraceEvents = async (c: Client): Promise<void> => {
  // Ensure trace_events exists — it may not yet if the daemon has never opened it.
  // This DDL mirrors trace-events-store.ts (canonical owner); the duplication is
  // intentional so the migration has no cross-module import dependency here.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id        TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      kind      TEXT NOT NULL,
      severity  TEXT NOT NULL DEFAULT 'info',
      task_id   TEXT,
      origin_id TEXT,
      phase     TEXT,
      payload   TEXT NOT NULL DEFAULT '{}'
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_trace_events_task_time ON trace_events (task_id, timestamp)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_trace_events_time_desc ON trace_events (timestamp DESC)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_trace_events_origin_time ON trace_events (origin_id, timestamp)`,
  )

  // ── task_signals → trace_events ──────────────────────────────────────────
  const sigTableCheck = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='task_signals'`,
  )
  if (sigTableCheck.rows.length > 0) {
    const sigRows = await c.execute(`SELECT * FROM task_signals`)
    for (const row of sigRows.rows) {
      const r = row as unknown as {
        task_id: string
        step_id: string
        input_tokens: number
        output_tokens: number
        cache_create_tokens: number
        cache_read_tokens: number
        message_count: number
        recorded_at: string
      }
      const taskRow = await c.execute({
        sql: `SELECT COALESCE(origin_id, id) AS origin_id FROM tasks WHERE id = ?`,
        args: [r.task_id],
      })
      const originId =
        taskRow.rows.length > 0
          ? ((taskRow.rows[0] as unknown as { origin_id: string }).origin_id ?? r.task_id)
          : r.task_id
      await c.execute({
        sql: `INSERT OR IGNORE INTO trace_events
                (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
              VALUES (?, ?, 'step_ended', 'info', ?, ?, 'code', ?)`,
        args: [
          `migrated-sig-${r.task_id}-${r.step_id}`,
          r.recorded_at,
          r.task_id,
          originId,
          JSON.stringify({
            stepName: 'code',
            legacyStepId: r.step_id,
            workflowInstanceId: `migrated-sig-${r.task_id}-${r.step_id}`,
            outcome: 'success',
            durationMs: 0,
            migrated: true,
            usageSignals: {
              inputTokens: r.input_tokens,
              outputTokens: r.output_tokens,
              cacheCreateTokens: r.cache_create_tokens,
              cacheReadTokens: r.cache_read_tokens,
              messageCount: r.message_count,
            },
          }),
        ],
      })
    }
    await c.execute(`DROP TABLE task_signals`)
    await c.execute(`DROP INDEX IF EXISTS idx_task_signals_task_id`)
  }

  // ── task_transcripts → trace_events ─────────────────────────────────────
  // Guard: only migrate the OLD task_transcripts schema (which had verify_output).
  // The new task_transcripts table (keyed by task_id, session_id, seq) is created
  // AFTER this migration runs (see below). If the table exists but lacks
  // verify_output, it is already the new schema and has nothing to migrate.
  const txTableCheck = await c.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='task_transcripts'`,
  )
  if (txTableCheck.rows.length > 0) {
    const txColCheck = await c.execute(
      `SELECT COUNT(*) as n FROM pragma_table_info('task_transcripts') WHERE name='verify_output'`,
    )
    const hasOldSchema =
      ((txColCheck.rows[0] as unknown as { n: number }).n ?? 0) > 0
    if (!hasOldSchema) {
      // New-schema table — nothing to migrate.
    } else {
    const txRows = await c.execute(
      `SELECT task_id, verify_output, recorded_at FROM task_transcripts`,
    )
    for (const row of txRows.rows) {
      const r = row as unknown as {
        task_id: string
        verify_output: string | null
        recorded_at: string
      }
      const taskRow = await c.execute({
        sql: `SELECT COALESCE(origin_id, id) AS origin_id FROM tasks WHERE id = ?`,
        args: [r.task_id],
      })
      const originId =
        taskRow.rows.length > 0
          ? ((taskRow.rows[0] as unknown as { origin_id: string }).origin_id ?? r.task_id)
          : r.task_id
      const payloadObj: Record<string, unknown> = {
        stepName: 'code',
        workflowInstanceId: `migrated-tx-${r.task_id}`,
        outcome: 'success',
        durationMs: 0,
        migrated: true,
      }
      if (r.verify_output !== null && r.verify_output !== undefined) {
        payloadObj.verifyOutput = r.verify_output
      }
      await c.execute({
        sql: `INSERT OR IGNORE INTO trace_events
                (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
              VALUES (?, ?, 'step_ended', 'info', ?, ?, 'code', ?)`,
        args: [
          `migrated-tx-${r.task_id}`,
          r.recorded_at,
          r.task_id,
          originId,
          JSON.stringify(payloadObj),
        ],
      })
    }
    await c.execute(`DROP TABLE task_transcripts`)
    await c.execute(`DROP INDEX IF EXISTS idx_task_transcripts_recorded_at`)
    } // closes else (old-schema migration)
  } // closes if (txTableCheck.rows.length > 0)
  // One-time rename: retry_budget_exhausted → recovery_exhausted in failure_reason.
  // The term "retry_budget_exhausted" implied a configurable retry budget that does
  // not exist; "recovery_exhausted" accurately reflects the one-recovery invariant
  // (ADR-0040). Idempotent: WHERE guard is a no-op once all rows are migrated.
  await c.execute(`UPDATE tasks SET failure_reason = replace(failure_reason, 'retry_budget_exhausted', 'recovery_exhausted') WHERE failure_reason LIKE '%retry_budget_exhausted%'`) // arch-guard:migration-write
  // Durable compressed transcript table. One row per task, gzip-compressed JSON.
  // Writers use this instead of embedding transcript strings in step_ended payloads
  // so hot aggregate queries over trace_events are not slowed by multi-MB blobs.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_durable_transcripts (
      task_id    TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      step_name  TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      transcript BLOB NOT NULL,
      byte_len   INTEGER NOT NULL
    )
  `)
  // Append-only progress journal for Foreground sessions (ADR extending ADR-0065).
  // Stores notes and check/uncheck events; checklist state is derived as a fold
  // over the journal (latest check/uncheck per criterion_index wins).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_progress (
      id              TEXT NOT NULL PRIMARY KEY,
      task_id         TEXT NOT NULL REFERENCES tasks(id),
      created_at      TEXT NOT NULL,
      author          TEXT NOT NULL,
      kind            TEXT NOT NULL CHECK(kind IN ('note','check','uncheck')),
      body            TEXT NOT NULL,
      criterion_index INTEGER
    )
  `)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_task_progress_task_time
       ON task_progress(task_id, created_at)`,
  )
}

const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024
const HALF_WINDOW_BYTES = 1 * 1024 * 1024

export const capConversationJson = (json: string): string => {
  if (json.length <= MAX_CONVERSATION_BYTES) return json
  const head = json.slice(0, HALF_WINDOW_BYTES)
  const tail = json.slice(json.length - HALF_WINDOW_BYTES)
  const skipped = json.length - head.length - tail.length
  const marker = JSON.stringify({ truncated: true, skippedBytes: skipped })
  return `${head}\n${marker}\n${tail}`
}

export interface UpsertTranscriptInput {
  taskId: string
  conversationJson?: string
  verifyOutput?: string | null
}

export const upsertTranscript = async (
  input: UpsertTranscriptInput,
  store?: TaskStore,
): Promise<void> => {
  const now = new Date().toISOString()
  const execute = async (stmt: { sql: string; args: unknown[] }) => {
    if (store) {
      await store.execute(stmt as InStatement)
    } else {
      await migrateQueueSchema()
      await resolveQueueClient().execute(stmt as InStatement)
    }
  }

  // Write transcript as a gzip-compressed BLOB to the dedicated table.
  // This keeps step_ended payloads small so hot aggregate queries are fast.
  if (input.conversationJson !== undefined) {
    const capped = capConversationJson(input.conversationJson)
    const compressed = await gzipAsyncQ(Buffer.from(capped, 'utf8'))
    await execute({
      sql: `INSERT OR REPLACE INTO task_durable_transcripts
              (task_id, session_id, step_name, created_at, transcript, byte_len)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [input.taskId, '', 'code', now, compressed, capped.length],
    })
  }

  // Write verifyOutput to a step_ended event (it is small — at most 64 KB).
  // The transcript field is never written to step_ended any more.
  if (input.verifyOutput !== undefined && input.verifyOutput !== null) {
    const cappedVerify =
      input.verifyOutput.length > 64 * 1024
        ? input.verifyOutput.slice(0, 64 * 1024)
        : input.verifyOutput
    const payloadObj = {
      stepName: 'code',
      workflowInstanceId: `upsert-${input.taskId}`,
      outcome: 'success',
      durationMs: 0,
      verifyOutput: cappedVerify,
    }
    const id = `upsert-${input.taskId}-${randomUUID()}`
    await execute({
      sql: `INSERT INTO trace_events
              (id, timestamp, kind, severity, task_id, phase, payload)
            VALUES (?, ?, 'step_ended', 'info', ?, 'code', ?)`,
      args: [id, now, input.taskId, JSON.stringify(payloadObj)],
    })
  }
}

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
  await migrateQueueSchema()
  const r = await resolveQueueClient().execute({
    sql: `SELECT timestamp, payload
            FROM trace_events
           WHERE kind = 'step_ended' AND task_id = ?
           ORDER BY timestamp DESC
           LIMIT 1`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { timestamp: string; payload: string }
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
    recordedAt: row.timestamp,
  }
}

const healBlobPrompts = async (c: Client): Promise<void> => {
  const r = await c.execute(
    `SELECT count(*) AS n FROM tasks WHERE typeof(prompt) = 'blob'`,
  )
  const n = Number((r.rows[0] as unknown as { n: number | bigint }).n)
  if (n > 0) {
    await c.execute(
      `UPDATE tasks SET prompt = CAST(prompt AS TEXT) WHERE typeof(prompt) = 'blob'`, // arch-guard:migration-write
    )
  }
}

export const coerceToString = (value: unknown, label: string): string => {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder('utf-8').decode(value)
  if (value instanceof ArrayBuffer) {
    return new TextDecoder('utf-8').decode(new Uint8Array(value))
  }
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  throw new TypeError(
    `${label} must be a string; got ${value === null ? 'null' : typeof value}`,
  )
}

/**
 * Canonical SELECT for a single task or a filtered task list.  Reads the
 * three normalised junction-table columns (claude_session_ids, files_json,
 * done_criteria_json) via correlated subqueries so that rowToTask /
 * rowToTaskSpec see the same column names as before.  Append a WHERE or
 * ORDER BY clause directly after the template literal.
 *
 * Usage:
 *   `${TASK_SEL} WHERE t.id = ?`
 *   `${TASK_SEL} WHERE t.status = ? ORDER BY t.priority DESC, t.created_at ASC`
 *   `${TASK_SEL} ORDER BY t.created_at`
 */
export const TASK_SEL = `
SELECT
  t.id, t.prompt, t.status, t.plan_functional, t.plan_technical,
  t.branch, t.worktree_path, t.claude_session_id,
  COALESCE(
    (SELECT json_group_array(session_id ORDER BY position)
       FROM task_claude_sessions WHERE task_id = t.id),
    '[]'
  ) AS claude_session_ids,
  t.error, t.drop_reason, t.retry_count, t.author_kind, t.author_name,
  t.failure_reason, t.failure_reason_code, t.recovery_payload,
  t.fix_for_task_id, t.failure_signature, t.kind, t.priority, t.tag,
  t.tags_json, t.origin_id, t.parent_proposal_id, t.slice_index,
  t.failed_phase, t.resume_from,
  (SELECT json_group_array(path ORDER BY position)
     FROM task_spec_files WHERE task_id = t.id) AS files_json,
  t.verify_cmd, t.preview_cmd,
  (SELECT json_group_array(criterion ORDER BY position)
     FROM task_done_criteria WHERE task_id = t.id) AS done_criteria_json,
  t.task_type, t.read_first_json, t.prescriptive_action, t.slice_kind,
  t.sub_deliverable_json, t.integration_head_sha,
  t.dev_server_url, t.dev_server_pid, t.preview_validated, t.intent,
  t.lease_owner, t.leased_at, t.lease_note,
  t.origin_session_id, t.workflow,
  t.created_at, t.updated_at
FROM tasks t`

export const rowToTask = (row: Record<string, unknown>): Task => {
  const functional = (row.plan_functional as string | null) ?? null
  const technical = (row.plan_technical as string | null) ?? null
  const plan: TaskPlan | null =
    functional !== null || technical !== null
      ? { functional: functional ?? '', technical: technical ?? '' }
      : null
  const authorKindRaw = (row.author_kind as string | null) ?? null
  const authorName = (row.author_name as string | null) ?? null
  const author: Author | null =
    authorKindRaw === 'human' || authorKindRaw === 'agent'
      ? { kind: authorKindRaw as AuthorKind, name: authorName ?? 'unknown' }
      : null
  const fixForTaskId = (row.fix_for_task_id as string | null) ?? null
  const rawKind = (row.kind as string | null) ?? null
  const kind: TaskKind =
    rawKind === 'fix' || rawKind === 'task' || rawKind === 'diagnose'
      ? rawKind
      : deriveTaskKind(fixForTaskId)
  // Read tags from the new tags_json column. Fall back to the legacy tag
  // column for old rows that predate the tags_json migration.
  const rawTagsJson = (row.tags_json as string | null) ?? null
  let tags: TaskTag[]
  if (rawTagsJson !== null) {
    const parsed = parseStringArray(rawTagsJson).filter(isTaskTag)
    tags = parsed.length > 0 ? parsed : ['coder']
  } else {
    const rawTag = (row.tag as string | null) ?? null
    tags = [isTaskTag(rawTag) ? rawTag : 'coder']
  }
  return {
    id: row.id as string,
    prompt: coerceToString(row.prompt, 'rowToTask: prompt'),
    status: row.status as TaskStatus,
    plan,
    branch: (row.branch as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    claudeSessionId: (row.claude_session_id as string | null) ?? null,
    claudeSessionIds: parseClaudeSessionIds(row.claude_session_ids),
    error: (row.error as string | null) ?? null,
    author,
    dropReason: (row.drop_reason as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    failureReasonCode: (row.failure_reason_code as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    fixForTaskId,
    failureSignature: (row.failure_signature as string | null) ?? null,
    kind,
    tags,
    originId: ((row.origin_id as string | null) ?? (row.id as string)),
    priority: Number(row.priority ?? 0),
    failedPhase: coerceFailedPhase(row.failed_phase),
    spec: rowToTaskSpec(row),
    integrationHeadSha: (row.integration_head_sha as string | null) ?? null,
    devServerUrl: (row.dev_server_url as string | null) ?? null,
    devServerPid:
      row.dev_server_pid === null || row.dev_server_pid === undefined
        ? null
        : Number(row.dev_server_pid),
    previewValidated: Number(row.preview_validated ?? 0) === 1,
    recoveryPayload: (row.recovery_payload as string | null) ?? null,
    intent: (row.intent as string | null) ?? '',
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leasedAt: (row.leased_at as string | null) ?? null,
    leaseNote: (row.lease_note as string | null) ?? null,
    originSessionId: (row.origin_session_id as string | null) ?? null,
    workflow: (row.workflow as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

const coerceFailedPhase = (raw: unknown): FailedPhase | null => {
  if (raw === 'code' || raw === 'verify' || raw === 'merge') return raw
  return null
}

const parseStringArray = (raw: unknown): string[] => {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

const rowToTaskSpec = (row: Record<string, unknown>): TaskSpec | null => {
  const rawFiles = (row.files_json as string | null) ?? null
  const rawVerify = (row.verify_cmd as string | null) ?? null
  const rawPreview = (row.preview_cmd as string | null) ?? null
  const rawDone = (row.done_criteria_json as string | null) ?? null
  const rawType = (row.task_type as string | null) ?? null
  const rawReadFirst = (row.read_first_json as string | null) ?? null
  const rawPrescriptive = (row.prescriptive_action as string | null) ?? null
  const rawSliceKind = (row.slice_kind as string | null) ?? null
  const rawSubDeliverable = (row.sub_deliverable_json as string | null) ?? null
  const anySet =
    rawFiles !== null ||
    rawVerify !== null ||
    rawPreview !== null ||
    rawDone !== null ||
    rawType !== null ||
    rawReadFirst !== null ||
    rawPrescriptive !== null ||
    rawSliceKind !== null ||
    rawSubDeliverable !== null
  if (!anySet) return null
  let subDeliverable: SubDeliverableSpec | undefined
  if (rawSubDeliverable) {
    try {
      subDeliverable = JSON.parse(rawSubDeliverable) as SubDeliverableSpec
    } catch {
      subDeliverable = undefined
    }
  }
  return {
    files: parseStringArray(rawFiles),
    verifyCmd: rawVerify,
    previewCmd: rawPreview,
    doneCriteria: parseStringArray(rawDone),
    taskType: isTaskType(rawType) ? rawType : 'auto',
    readFirst: parseStringArray(rawReadFirst),
    prescriptiveAction: rawPrescriptive,
    sliceKind:
      rawSliceKind === 'coder' || rawSliceKind === 'hitl'
        ? rawSliceKind
        : undefined,
    subDeliverable,
  }
}

export interface EnqueueTaskOptions {
  skipTriage?: boolean
  author?: Author
  originId?: string
  priority?: number
  parentProposalId?: string
  sliceIndex?: number
  /**
   * Worker-routing hints. Each element must be a non-empty string; defaults to
   * `['coder']` when omitted. The implement workflow uses the first element as
   * the primary routing tag; unknown tags fall back to the Coder Worker.
   */
  tags?: TaskTag[]
  /**
   * Marker for the task's role. Defaults to `'task'`. `'fix'` is set by the
   * recovery dispatcher (must come with a non-null `fixForTaskId`).
   * `'diagnose'` is set when the orchestrator spawns a diagnose Chore to
   * investigate a stuck origin task — see PRD 06e677fb.
   */
  kind?: TaskKind
  /**
   * Structured-task contract. When omitted the row is stored with the
   * legacy free-prose shape (every spec column NULL) and the implementor
   * agent sees only `prompt`. When set, the spec is persisted alongside
   * the prompt and {@link composePrompt} renders `<files>/<verify>/<done>`
   * sections on top.
   */
  spec?: TaskSpec
  /**
   * One-line statement of what the task sets out to do. When omitted,
   * defaults to the first sentence of `prompt` (split on '. ' or newline,
   * capped at 200 chars).
   */
  intent?: string
  /**
   * UUID of the originating Claude Code operator session, captured from
   * `CLAUDE_CODE_SESSION_ID` at the CLI boundary. Stored verbatim;
   * null when the enqueue does not originate from a Claude Code session.
   */
  originSessionId?: string | null
  /**
   * Pipeline selection: the dispatcher loads
   * `.mars/workflows/<workflow>-workflow.js` for this task instead of the
   * kind-default file. Omitted/null → default-by-kind.
   */
  workflow?: string | null
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
  return Arc.createOrigin({ prompt, plan, opts })
}

/**
 * `setTaskStatus` and its `mapStatusToEvent` helper were relocated into the
 * Arc aggregate (ADR-0052 sole-writer) — see `Arc.setTaskStatus` in
 * `core/arc.ts`. The raw `UPDATE tasks SET status` + the four publish()
 * branches now live there; callers import `Arc` and call
 * `Arc.setTaskStatus(taskId, newStatus, extras?, store?)`.
 */

export const updateTask = async (
  id: string,
  patch: Partial<
    Pick<
      Task,
      | 'status'
      | 'plan'
      | 'branch'
      | 'worktreePath'
      | 'claudeSessionId'
      | 'error'
      | 'failedPhase'
      | 'integrationHeadSha'
      | 'devServerUrl'
      | 'devServerPid'
      | 'previewValidated'
      | 'failureReason'
      | 'failureSignature'
      | 'leaseOwner'
      | 'leasedAt'
      | 'leaseNote'
    > & {
      /**
       * Typed catalog code for the failure (e.g. `verify:main-dirty`).
       * Companion to the legacy free-text `failureReason`; either can be
       * written on its own, both can be written together. Slice F.2
       * starts populating it for dirty-main parking.
       */
      failureReasonCode?: string | null
      /**
       * JSON-encoded sidecar for recovery (kind='fix') rows. Slice F.2 stores
       * `{ recipe, dirtyMainHash }` here for `main-commiter` recoveries.
       */
      recoveryPayload?: string | null
    }
  >,
  store?: TaskStore,
): Promise<void> => {
  const fields: string[] = []
  const args: unknown[] = []

  // Read the current status (and branch) before the UPDATE so we can detect real
  // transitions (patch.status === existing status ⇒ no-op, skip dismissals), and
  // so the done-implies-merged guard (below) has access to the branch name.
  let previousStatus: string | null = null
  let taskBranch: string | null = null
  if (patch.status !== undefined) {
    const before = store
      ? await store.query({ sql: `SELECT status, branch FROM tasks WHERE id = ?`, args: [id] })
      : await resolveQueueClient().execute({ sql: `SELECT status, branch FROM tasks WHERE id = ?`, args: [id] })
    if (before.rows.length > 0) {
      const row = before.rows[0] as unknown as { status: string; branch: string | null }
      previousStatus = row.status ?? null
      taskBranch = row.branch ?? null
    }
  }

  // Guard: terminal statuses are immutable.  A task that reached 'done' or
  // 'dropped' must never be moved to a different status — the daemon,
  // Invalidator, and UI all treat those as absorbing states.
  if (
    patch.status !== undefined &&
    previousStatus !== null &&
    patch.status !== previousStatus &&
    (previousStatus === 'done' || previousStatus === 'dropped')
  ) {
    throw new IllegalTransitionError(id, previousStatus, patch.status)
  }

  // Done-implies-merged invariant (ADR-0052 / done-with-unmerged-commits).
  //
  // When a task is transitioning to 'done' AND its branch column is set, assert
  // that the branch has 0 commits ahead of the integration branch. A non-zero
  // count means the merge step never completed — the "committer false-done" bug
  // class (3d7cb3c2 / mars-984de140). Intercept by redirecting the patch to
  // 'failed' with a distinct failure_reason_code BEFORE the field-building so
  // every downstream step (eventStmts, blocker promotion) sees the corrected
  // status automatically.
  //
  // Ordering note: `git rev-list --count <integration>..<branch>` runs from the
  // repo root against a named branch ref. Two skip conditions apply:
  //   – branch is NULL → task never had a worktree; nothing to check.
  //   – git exits non-zero → the branch was deleted (normal post-merge cleanup
  //     where the merge step deletes the branch before or alongside the status
  //     write). Treat as 0 commits ahead and allow done.
  //
  // The guard applies only to direct done transitions via updateTask. The
  // propagateRecoveryDone path in Arc sets the ORIGIN to done after a FIX task
  // completes; in that scenario the fix task's branch (not the origin's) was
  // merged. Guarding the origin's branch there would produce false positives
  // (the origin's branch was intentionally never merged — the fix task did the
  // work). That path calls Arc.setTaskStatus directly and bypasses updateTask.
  let doneWithUnmergedCommits = false
  if (
    patch.status === 'done' &&
    previousStatus !== null &&
    previousStatus !== 'done' &&
    taskBranch !== null
  ) {
    const integration = process.env.INTEGRATION_BRANCH ?? 'main'
    const repoRoot = resolveContext().repoRoot
    let aheadCount = 0
    try {
      const { stdout } = await execFileP(
        'git',
        ['rev-list', '--count', `${integration}..${taskBranch}`],
        { cwd: repoRoot },
      )
      aheadCount = parseInt(stdout.trim(), 10) || 0
    } catch {
      // Branch deleted or git error — treat as already merged (0 ahead).
      aheadCount = 0
    }
    if (aheadCount > 0) {
      doneWithUnmergedCommits = true
      patch = {
        ...patch,
        status: 'failed',
        failureReasonCode: 'done-with-unmerged-commits',
      }
    }
  }

  if (patch.status !== undefined) {
    fields.push('status = ?')
    args.push(patch.status)
  }
  if (patch.plan !== undefined) {
    fields.push('plan_functional = ?')
    args.push(patch.plan?.functional ?? null)
    fields.push('plan_technical = ?')
    args.push(patch.plan?.technical ?? null)
  }
  if (patch.branch !== undefined) {
    fields.push('branch = ?')
    args.push(patch.branch)
  }
  if (patch.worktreePath !== undefined) {
    fields.push('worktree_path = ?')
    args.push(patch.worktreePath)
  }
  if (patch.claudeSessionId !== undefined) {
    fields.push('claude_session_id = ?')
    args.push(patch.claudeSessionId)
  }
  if (patch.error !== undefined) {
    fields.push('error = ?')
    args.push(patch.error)
  }
  if (patch.failedPhase !== undefined) {
    fields.push('failed_phase = ?')
    args.push(patch.failedPhase)
  }
  if (patch.integrationHeadSha !== undefined) {
    fields.push('integration_head_sha = ?')
    args.push(patch.integrationHeadSha)
  }
  if (patch.devServerUrl !== undefined) {
    fields.push('dev_server_url = ?')
    args.push(patch.devServerUrl)
  }
  if (patch.devServerPid !== undefined) {
    fields.push('dev_server_pid = ?')
    args.push(patch.devServerPid)
  }
  if (patch.previewValidated !== undefined) {
    fields.push('preview_validated = ?')
    args.push(patch.previewValidated ? 1 : 0)
  }
  if (patch.leaseOwner !== undefined) {
    fields.push('lease_owner = ?')
    args.push(patch.leaseOwner)
  }
  if (patch.leasedAt !== undefined) {
    fields.push('leased_at = ?')
    args.push(patch.leasedAt)
  }
  if (patch.leaseNote !== undefined) {
    fields.push('lease_note = ?')
    args.push(patch.leaseNote)
  }
  if (patch.failureReason !== undefined) {
    fields.push('failure_reason = ?')
    args.push(patch.failureReason)
  }
  if (patch.failureSignature !== undefined) {
    fields.push('failure_signature = ?')
    args.push(patch.failureSignature)
  }
  if (patch.failureReasonCode !== undefined) {
    fields.push('failure_reason_code = ?')
    args.push(patch.failureReasonCode)
  }
  if (patch.recoveryPayload !== undefined) {
    fields.push('recovery_payload = ?')
    args.push(patch.recoveryPayload)
  }
  fields.push('updated_at = ?')
  args.push(new Date().toISOString())
  args.push(id)

  const isStatusChange =
    patch.status !== undefined &&
    previousStatus !== null &&
    patch.status !== previousStatus

  const appendSessionId =
    patch.claudeSessionId !== undefined &&
    patch.claudeSessionId !== null &&
    patch.claudeSessionId.length > 0

  // Build the event INSERT statements upfront (validates payload via Zod;
  // throws before any DB write if the payload is invalid).  An empty array
  // means no event should be emitted for this call (unchanged-status or
  // non-status write).  Every terminal transition (done/dropped/failed)
  // additionally emits one `task.terminal` event in the same transaction so
  // the Invalidator (alert-dismisser) has a single subscription point for
  // closing Action-queue rows; see ADR-0028/0030.
  const eventStmts: InStatement[] = []
  if (isStatusChange) {
    if (patch.status === 'failed') {
      eventStmts.push(
        buildEventInsert('task.failed', {
          taskId: id,
          error: patch.error ?? patch.failureReason ?? '',
        }),
        buildEventInsert('task.terminal', { taskId: id, reason: 'failed' }),
      )
    } else if (patch.status === 'dropped') {
      eventStmts.push(
        buildEventInsert('task.dropped', {
          taskId: id,
          dropReason: patch.failureReason ?? '',
        }),
        buildEventInsert('task.terminal', { taskId: id, reason: 'dropped' }),
      )
    } else if (patch.status === 'queued') {
      eventStmts.push(buildEventInsert('task.queued', { taskId: id }))
    } else if (patch.status === 'blocked') {
      eventStmts.push(
        buildEventInsert('task.blocked', {
          taskId: id,
          fixTaskId: null,
          failureSignature: patch.failureSignature ?? '',
          failingStep: patch.failedPhase ?? '',
        }),
      )
    } else if (patch.status === 'done') {
      eventStmts.push(
        buildEventInsert('task.completed', { taskId: id, result: null }),
        buildEventInsert('task.terminal', { taskId: id, reason: 'done' }),
      )
    } else if (patch.status === 'under_investigation') {
      // Operator clicked Investigate on a stale-worktree alert. The event rides
      // the transactional outbox so the Invalidator (alert-dismisser) resolves
      // the open action-queue row on its next drain — the alert disappears from
      // the queue without any inline DB write here (ADR-0027/0030).
      eventStmts.push(buildEventInsert('task.under_investigation', { taskId: id }))
    }
  }

  // Position is MAX(position)+1 for this task, or 0 for the first session.
  // Built here (column patch + payload assembly stays in updateTask), but the
  // raw `UPDATE tasks SET … WHERE id = ?` string and the three-branch atomic
  // commit live in the Arc aggregate — the sole task-table writer (ADR-0052).
  const sessionIdStmt: InStatement | undefined = appendSessionId
    ? {
        sql: `INSERT OR IGNORE INTO task_claude_sessions (task_id, session_id, position)
            SELECT ?, ?,
              COALESCE(
                (SELECT MAX(position) + 1 FROM task_claude_sessions WHERE task_id = ?),
                0
              )`,
        args: [id, patch.claudeSessionId as string, id],
      }
    : undefined

  await Arc.applyStatusWrite({
    id,
    fields,
    args,
    eventStmts,
    store,
    appendSessionId,
    sessionIdStmt,
  })

  // NOTE: Action-queue clearing on status change is NOT done inline here.
  // The Invalidator (alert-dismisser) subscribes to the task lifecycle
  // events emitted above and is the SOLE closer of Action-queue rows and
  // dismissals — see ADR-0027/0030. Clearing inline would (a) duplicate the
  // subscriber and (b) be lost for any writer that bypasses updateTask, the
  // exact staleness class this design eliminates.

  // Done-implies-merged guard: raise the action-queue item after the write so
  // it is colocated with the failure event rather than emitted speculatively.
  // Awaited but wrapped in try-catch: best-effort semantics with no race on
  // the action_queue_items migration path (concurrent unawaited calls would
  // create a SQLITE duplicate-column race in initActionQueue).
  if (doneWithUnmergedCommits) {
    const integration = process.env.INTEGRATION_BRANCH ?? 'main'
    try {
      await raiseActionQueueItem({
        kind: 'done-with-unmerged-commits',
        category: 'daemon',
        priority: 'urgent',
        title: `Task ${id} failed: done-with-unmerged-commits`,
        body:
          `A done transition was blocked because branch ${taskBranch} still has commits ahead ` +
          `of ${integration}. The merge step did not complete. Investigate and re-merge or restart the task.`,
        payload: { taskId: id, branch: taskBranch, integration },
        context: { taskId: id },
        raisedBy: 'queue:done-implies-merged-guard',
        signature: id,
        originTaskId: id,
      })
    } catch {
      // Best-effort: raise failure must not mask the task failure itself.
    }
  }

  if (patch.status === 'done') {
    const dependents = store
      ? await store.query({
          sql: `SELECT DISTINCT task_id FROM task_blockers WHERE blocker_task_id = ?`,
          args: [id],
        })
      : await resolveQueueClient().execute({
          sql: `SELECT DISTINCT task_id FROM task_blockers WHERE blocker_task_id = ?`,
          args: [id],
        })
    for (const row of dependents.rows) {
      const dependentId = (row as unknown as { task_id: string }).task_id
      await promoteDraftToQueued(dependentId)
    }
  }
}

export const getTask = async (id: string, store?: TaskStore): Promise<Task | null> => {
  const stmt = { sql: `${TASK_SEL} WHERE t.id = ?`, args: [id] }
  let r
  if (store) {
    r = await store.query(stmt)
  } else {
    await migrateQueueSchema()
    r = await resolveQueueClient().execute(stmt)
  }
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

export const listTasks = async (status?: TaskStatus): Promise<Task[]> => {
  await migrateQueueSchema()
  const r = status
    ? await resolveQueueClient().execute({
        sql: `${TASK_SEL} WHERE t.status = ? ORDER BY t.priority DESC, t.created_at ASC`,
        args: [status],
      })
    : await resolveQueueClient().execute(
        `${TASK_SEL} ORDER BY t.priority DESC, t.created_at ASC`,
      )
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
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
): Promise<Task> => Arc.load(id).reprioritize(priority)

export interface DropTaskResult {
  taskId: string
  previousStatus: TaskStatus
  /**
   * task_blockers edges deleted by the drop. `incoming` are edges where
   * <id> appears as `blocker_task_id` (other tasks waiting on this one);
   * `outgoing` are edges where <id> appears as `task_id` (this task
   * waiting on others).
   */
  edgesRemoved: { incoming: number; outgoing: number }
  /**
   * Ids of fix/recovery tasks (kind='fix', fix_for_task_id = dropped id)
   * that were cascade-deleted atomically with the origin. These tasks are
   * GONE — not null-ed — by the time dropTask returns (ADR-0049).
   */
  cascadedFixTaskIds: string[]
}

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
  return Arc.load(id).drop()
}

/**
 * Insert a self-arc reflection task. Thin wrapper over
 * {@link Arc.insertReflection} (ADR-0052): the `INSERT INTO tasks`
 * (`origin_id = self`, status `'done'`) lives on the Arc aggregate now.
 * Signature kept byte-identical for the task-store facade and existing call
 * sites (`mars reflect`).
 */
export const insertReflectionTask = async (corpusSize: number): Promise<string> => {
  return Arc.load('reflect').insertReflection(corpusSize)
}

/**
 * Add user-facing blocker edges. Thin wrapper over {@link Arc.addBlocker}
 * (ADR-0052): the existence checks, dedupe, ADR-0040 leaf-node guard, and the
 * `state='confirmed'` batch INSERT all live on the Arc aggregate now. Signature
 * kept byte-identical for the task-store facade and existing call sites
 * (`upsertFixTask` non-exempt paths).
 */
export const addBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  await Arc.load(taskId).addBlocker(taskId, blockerIds)
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
 * Thin wrapper over {@link Arc.addPendingReviewBlockers} (ADR-0052): the Linker
 * is the sole *deriver* of lexical-overlap edges; Arc is the sole *writer* of
 * `task_blockers` rows. Signature kept for existing call sites.
 */
export const addPendingReviewBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  await Arc.load(taskId).addPendingReviewBlockers(taskId, blockerIds)
}

/**
 * Remove a single blocker edge. Thin wrapper over {@link Arc.removeBlocker}
 * (ADR-0052); status is unchanged. Signature kept byte-identical for the
 * task-store facade and existing call sites.
 */
export const removeBlocker = async (
  taskId: string,
  blockerId: string,
): Promise<{ removed: boolean }> => {
  return Arc.load(taskId).removeBlocker(taskId, blockerId)
}

export const clearBlockers = async (taskId: string): Promise<void> => {
  await Arc.load(taskId).clearBlockers(taskId)
}

/**
 * ADR-0015 cross-graph edge writer. Adds `task_proposal_blockers` rows so
 * `taskId` waits on each `proposalId` (a queued task that cannot dispatch
 * until that idea has been shaped and promoted). Mirrors `addBlockers`: the
 * task must exist and duplicates/no-ops are handled via `INSERT OR IGNORE`.
 *
 * `proposalId` lives in the SEPARATE state.db, so it cannot be FK-validated
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
  await migrateQueueSchema()
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
  const now = new Date().toISOString()
  const stmts = unique.map((proposalId) => ({
    sql: `INSERT OR IGNORE INTO task_proposal_blockers (task_id, proposal_id, created_at) VALUES (?, ?, ?)`,
    args: [taskId, proposalId, now],
  }))
  await c.batch(stmts, 'write')
}

/**
 * List proposal ids that `taskId` is blocked by in `task_proposal_blockers`,
 * ordered by edge creation time. No status filter: proposal status lives in
 * the separate state.db and the dispatch gate only cares whether ANY row
 * still references an un-promoted proposal — that join is the dispatcher's
 * concern, not this reader's.
 */
export const listProposalBlockers = async (
  taskId: string,
): Promise<string[]> => {
  await migrateQueueSchema()
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
  await migrateQueueSchema()
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
  await migrateQueueSchema()
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
 * `batch(..., 'write')`. Because both tables live in queue.db this is a
 * genuine atomic transaction — no dispatcher tick can observe a dependent
 * task with zero blockers between the two writes. (The proposal status flip
 * to 'prd-ready' happens in state.db and is independent of this invariant:
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
  await migrateQueueSchema()
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
  // Delegate to Arc (ADR-0052 sole-writer for task_blockers). Arc.transferProposalEdges
  // re-runs the ADR-0040 leaf-node guard and builds the atomic INSERT+DELETE batch.
  return Arc.transferProposalEdges(dependents, newBlockerTaskId, proposalId)
}

export interface UnblockTaskResult {
  taskId: string
  outcome: 'unblocked' | 'noop'
  previousStatus: string
}

/**
 * Manual escape hatch: flip a `blocked` task to `failed`, clearing any
 * `task_blockers` rows pointing from it. Used by `mars unblock <id>` so users
 * do not need to reach for sqlite when the row has slipped into an
 * inconsistent state (stale junction rows after a blocker was purged).
 */
/**
 * Thin wrapper over {@link Arc.unblockTask} (ADR-0052 sole-writer). The
 * `blocked|queued → failed` status write + blocker clear + `task.failed` /
 * `task.terminal` emit now live inside the Arc aggregate; this export keeps the
 * historic call surface (`mars unblock <id>`, the daemon RPC, the `TaskStore`
 * facade) green by delegating verbatim.
 */
export const unblockTask = async (
  taskId: string,
): Promise<UnblockTaskResult> => {
  return Arc.unblockTask(taskId)
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
  await migrateQueueSchema()
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
  await migrateQueueSchema()
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
  await migrateQueueSchema()
  // Only confirmed-or-pending-review rows gate dispatch; rejected rows are
  // historical/audit and must not appear here.
  const r = await resolveQueueClient().execute({
    sql: `SELECT b.blocker_task_id AS id
            FROM task_blockers b
            JOIN tasks t ON t.id = b.blocker_task_id
           WHERE b.task_id = ? AND t.status != 'done'
             AND b.state IN ('confirmed', 'pending-review')`,
    args: [taskId],
  })
  return r.rows.map((row) => (row as unknown as { id: string }).id)
}

export const hasIncompleteBlockers = async (taskId: string, store?: TaskStore): Promise<boolean> => {
  const stmt = {
    sql: `SELECT 1
            FROM task_blockers b
            JOIN tasks t ON t.id = b.blocker_task_id
           WHERE b.task_id = ? AND t.status != 'done'
             AND b.state IN ('confirmed', 'pending-review')
           LIMIT 1`,
    args: [taskId],
  }
  let r
  if (store) {
    r = await store.query(stmt)
  } else {
    await migrateQueueSchema()
    r = await resolveQueueClient().execute(stmt)
  }
  return r.rows.length > 0
}

/**
 * Polymorphic Blocker reader: returns every Blocker row that gates `taskId`,
 * folding `task_blockers` (cause=task) and `task_proposal_blockers`
 * (cause=idea) into a single uniform list. Rejected rows are excluded.
 * Order: confirmed first, then pending-review, then by createdAt ascending.
 */
export const listAllBlockers = async (taskId: string): Promise<Blocker[]> => {
  await migrateQueueSchema()
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
        created_at: string
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
      const r = row as unknown as { cause_id: string; created_at: string }
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
    return a.createdAt.localeCompare(b.createdAt)
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
  return Arc.promoteDraftToTriaging(taskId)
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
  return Arc.promoteDraftToQueued(taskId)
}
