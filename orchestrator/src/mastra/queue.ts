import { type Client, type InStatement } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { resolveContext } from './context'
import { parseClaudeSessionIds } from './lib/claude-session-ids'
import type { Author, AuthorKind } from './author'
import { assertNotRecoveryEdge } from './lib/blocker-invariant'
import { dismissAlertsOnStatusChange } from './lib/inbox'
import { clearDismissalForEntity } from './lib/inbox-dismissals'
import { openLibsql } from './lib/libsql'
import { buildEventInsert, withWriteTx } from './lib/outbox'
import type { TaskStore } from './lib/task-store'

export type TaskStatus =
  | 'draft'
  | 'triaging'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'vega-reconciling'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'blocked'

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
  'merging',
  'vega-reconciling',
  'done',
  'failed',
  'dropped',
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
  createdAt: string
}

/**
 * Distinguishes the different roles a row can play in the queue. The value
 * is mirrored by, and must agree with, the `fixForTaskId` pointer (only
 * `'fix'` may carry a non-null pointer):
 *
 *   - `'task'`     → ordinary work; `fixForTaskId` MUST be null
 *   - `'fix'`      → recovery fix-task; `fixForTaskId` MUST be non-null
 *   - `'diagnose'` → terminal investigate-only Chore spawned when a coder
 *                    trips the read-span guard. Reads heavily without acting,
 *                    records a verdict through `mars diagnose set`, and
 *                    parks the original task behind itself. Never spawns
 *                    another diagnose Chore (see PRD 06e677fb / ADR).
 *                    `fixForTaskId` MUST be null; the link to the origin
 *                    stuck task is via `origin_id`.
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
 * Untagged rows default to `'coder'` at the read boundary, preserving the
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
   * and `mars deep-reflect` across the full retry chain.
   */
  claudeSessionIds: string[]
  error: string | null
  author: Author | null
  dropReason: string | null
  failureReason: string | null
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
   * Routing hint that picks the Worker. See {@link TaskTag}. Optional on the
   * type for backwards compatibility with existing `Task` literals in tests
   * and fixtures; the persistence boundary defaults missing/NULL values to
   * `'coder'`.
   */
  tag?: TaskTag
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
   * Recipe-specific payload preserved with a recovery task. NULL for every
   * non-recovery row. Slice F.2 stores `{ recipe, dirtyMainHash }` here for
   * `main-commiter` recoveries; later recipes that need typed sidecar state
   * can reuse the same column with their own JSON shape. The persistence
   * layer treats it as an opaque string; recipe code parses it.
   */
  recoveryPayload: string | null
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

export const getClient = (): Client => {
  if (!clientSingleton) {
    const { queueDbPath } = resolveContext()
    clientSingleton = openLibsql({ url: `file:${queueDbPath}` })
  }
  return clientSingleton
}

export const initQueue = async (): Promise<void> => {
  const c = getClient()
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
  // claude_session_ids: append-only JSON-array history of Claude session
  // IDs across retries. The legacy `claude_session_id` column is kept as
  // the latest pointer (see Task.claudeSessionId). Backfill from any
  // pre-existing latest pointer so the history is consistent with the
  // mirrored field on day one.
  if (!names.has('claude_session_ids')) {
    await c.execute(
      `ALTER TABLE tasks ADD COLUMN claude_session_ids TEXT NOT NULL DEFAULT '[]'`,
    )
    await c.execute(
      `UPDATE tasks
          SET claude_session_ids = json_array(claude_session_id)
        WHERE claude_session_id IS NOT NULL
          AND (claude_session_ids = '[]' OR claude_session_ids IS NULL)`,
    )
  }
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
    await c.execute(
      `UPDATE tasks SET kind = 'fix'
        WHERE kind IS NULL AND fix_for_task_id IS NOT NULL`,
    )
    await c.execute(
      `UPDATE tasks SET kind = 'task'
        WHERE kind IS NULL AND fix_for_task_id IS NULL`,
    )
  }
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
    await c.execute(`UPDATE tasks SET tag = 'coder' WHERE tag IS NULL`)
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
    await c.execute(`UPDATE tasks SET origin_id = id WHERE origin_id IS NULL`)
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
  // Structured-task spec sidecar columns. NULL on legacy rows; populated by
  // the slicer and by `mars task add` when --files/--verify/--done is
  // passed. The composePrompt path renders the spec on top of `prompt` so
  // the implementor agent receives a typed brief. See {@link TaskSpec}.
  if (!names.has('files_json')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN files_json TEXT`)
  }
  if (!names.has('verify_cmd')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN verify_cmd TEXT`)
  }
  if (!names.has('done_criteria_json')) {
    await c.execute(`ALTER TABLE tasks ADD COLUMN done_criteria_json TEXT`)
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
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_fix_for ON tasks(fix_for_task_id, failure_signature)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`,
  )
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_origin_id ON tasks(origin_id)`,
  )
  await c.execute(`DROP INDEX IF EXISTS idx_tasks_parent_idea_id`)
  await c.execute(
    `CREATE INDEX IF NOT EXISTS idx_tasks_parent_proposal_id ON tasks(parent_proposal_id)`,
  )
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_signals (
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (task_id, step_id)
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_signals_task_id ON task_signals(task_id)
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_blockers (
      task_id TEXT NOT NULL,
      blocker_task_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL,
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
    await c.execute(
      `UPDATE task_blockers SET state = 'confirmed' WHERE state IS NULL OR state = ''`,
    )
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
  // `initQueue` in `initDatabases`, and many call sites init only the queue
  // (tests, ad-hoc utilities) — so we pre-create the proposals table here
  // with the minimal `id PRIMARY KEY` shape needed to satisfy the FK.
  // `initProposals` keeps full ownership of column shape: its own
  // `CREATE TABLE IF NOT EXISTS proposals (...)` becomes a no-op, and the
  // additional columns it expects already exist (when initProposals follows
  // initQueue in the standard path) OR get ALTERed in if a caller bypassed
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
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
                VALUES (?, ?, ?)`,
          args: [r.task_id, r.fix_task_id, now],
        })
      }
    }
    await c.execute(`UPDATE tasks SET blocker_id = NULL`)
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
  await c.execute(`
    CREATE TABLE IF NOT EXISTS task_transcripts (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      conversation_json TEXT NOT NULL,
      verify_output TEXT,
      bytes INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_task_transcripts_recorded_at ON task_transcripts(recorded_at)
  `)
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
  await healBlobPrompts(c)
  // Wire-bus outbox: events published by library code land atomically with the
  // state writes they describe (same queue.db, same libsql transaction).
  // Cursor-based fan-out consumers poll for id > cursor.
  // TODO(retention): rows grow unbounded; a future pass should cap by age or
  // per-subscriber MIN(cursor) once subscriber cursors are tracked.
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

  if (input.conversationJson !== undefined) {
    const capped = capConversationJson(input.conversationJson)
    const stmt = {
      sql: `INSERT INTO task_transcripts
              (task_id, conversation_json, verify_output, bytes, recorded_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
              conversation_json = excluded.conversation_json,
              bytes             = excluded.bytes,
              recorded_at       = excluded.recorded_at`,
      args: [input.taskId, capped, input.verifyOutput ?? null, capped.length, now],
    }
    if (store) {
      await store.execute(stmt)
    } else {
      await initQueue()
      await getClient().execute(stmt)
    }
    return
  }

  if (input.verifyOutput !== undefined) {
    const cappedVerify =
      input.verifyOutput === null
        ? null
        : input.verifyOutput.length > 64 * 1024
          ? input.verifyOutput.slice(0, 64 * 1024)
          : input.verifyOutput
    const stmt = {
      sql: `UPDATE task_transcripts
              SET verify_output = ?, recorded_at = ?
            WHERE task_id = ?`,
      args: [cappedVerify, now, input.taskId],
    }
    if (store) {
      await store.execute(stmt)
    } else {
      await initQueue()
      await getClient().execute(stmt)
    }
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
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT task_id, conversation_json, verify_output, bytes, recorded_at
            FROM task_transcripts
           WHERE task_id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as Record<string, unknown>
  return {
    taskId: row.task_id as string,
    conversationJson: row.conversation_json as string,
    verifyOutput: (row.verify_output as string | null) ?? null,
    bytes: Number(row.bytes ?? 0),
    recordedAt: row.recorded_at as string,
  }
}

const healBlobPrompts = async (c: Client): Promise<void> => {
  const r = await c.execute(
    `SELECT count(*) AS n FROM tasks WHERE typeof(prompt) = 'blob'`,
  )
  const n = Number((r.rows[0] as unknown as { n: number | bigint }).n)
  if (n > 0) {
    await c.execute(
      `UPDATE tasks SET prompt = CAST(prompt AS TEXT) WHERE typeof(prompt) = 'blob'`,
    )
  }
}

const coerceToString = (value: unknown, label: string): string => {
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

const rowToTask = (row: Record<string, unknown>): Task => {
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
  const rawTag = (row.tag as string | null) ?? null
  const tag: TaskTag = isTaskTag(rawTag) ? rawTag : 'coder'
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
    retryCount: Number(row.retry_count ?? 0),
    fixForTaskId,
    failureSignature: (row.failure_signature as string | null) ?? null,
    kind,
    tag,
    originId: ((row.origin_id as string | null) ?? (row.id as string)),
    priority: Number(row.priority ?? 0),
    failedPhase: coerceFailedPhase(row.failed_phase),
    spec: rowToTaskSpec(row),
    integrationHeadSha: (row.integration_head_sha as string | null) ?? null,
    recoveryPayload: (row.recovery_payload as string | null) ?? null,
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
  const rawDone = (row.done_criteria_json as string | null) ?? null
  const rawType = (row.task_type as string | null) ?? null
  const rawReadFirst = (row.read_first_json as string | null) ?? null
  const rawPrescriptive = (row.prescriptive_action as string | null) ?? null
  const rawSliceKind = (row.slice_kind as string | null) ?? null
  const rawSubDeliverable = (row.sub_deliverable_json as string | null) ?? null
  const anySet =
    rawFiles !== null ||
    rawVerify !== null ||
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
   * Worker-routing hint. Any non-empty string is valid; defaults to `'coder'`
   * when omitted. Unknown tags fall back to the Coder Worker at dispatch.
   */
  tag?: TaskTag
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
}

export const enqueueTask = async (
  prompt: string,
  plan?: TaskPlan,
  opts?: EnqueueTaskOptions,
): Promise<Task> => {
  const promptText = coerceToString(prompt, 'enqueueTask: prompt')
  if (opts?.priority !== undefined) validatePriority(opts.priority)
  if (opts?.tag !== undefined && !isTaskTag(opts.tag)) {
    throw new Error(
      `tag must be a non-empty string; got ${JSON.stringify(opts.tag)}`,
    )
  }
  await initQueue()
  const id = `mars-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const status: TaskStatus = opts?.skipTriage ? 'queued' : 'draft'
  const authorKind = opts?.author?.kind ?? null
  const authorName = opts?.author?.name ?? null
  const originId = opts?.originId ?? id
  const priority = opts?.priority ?? 0
  const parentProposalId = opts?.parentProposalId ?? null
  const sliceIndex = opts?.sliceIndex ?? null
  const tag: TaskTag = opts?.tag ?? 'coder'
  const kind: TaskKind = opts?.kind ?? 'task'
  // enqueueTask never sets fix_for_task_id (fix-tasks go through their own
  // recovery path), so the invariant collapses to: only 'task' and
  // 'diagnose' kinds are valid here.
  assertTaskKindInvariant(kind, null)
  if (kind === 'fix') {
    throw new Error(
      `enqueueTask cannot create kind='fix'; use the recovery fix-task path`,
    )
  }
  const spec = opts?.spec ?? null
  if (spec !== null && !isTaskType(spec.taskType)) {
    throw new Error(
      `spec.taskType must be one of ${TASK_TYPES.join(', ')}; got '${String(spec.taskType)}'`,
    )
  }
  const filesJson = spec ? JSON.stringify(spec.files) : null
  const verifyCmd = spec ? spec.verifyCmd : null
  const doneCriteriaJson = spec ? JSON.stringify(spec.doneCriteria) : null
  const taskType = spec ? spec.taskType : null
  const readFirstJson = spec ? JSON.stringify(spec.readFirst ?? []) : null
  const prescriptiveAction = spec ? (spec.prescriptiveAction ?? null) : null
  // sliceKindVal: 'coder' | 'hitl' routing hint from the slicer. Distinct from
  // the `kind` variable above (TaskKind: 'task' | 'fix' | 'diagnose').
  const sliceKindVal = spec?.sliceKind ?? null
  const subDeliverableJson = spec?.subDeliverable
    ? JSON.stringify(spec.subDeliverable)
    : null
  await getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, author_kind, author_name, origin_id, priority, parent_proposal_id, slice_index, tag, kind, files_json, verify_cmd, done_criteria_json, task_type, read_first_json, prescriptive_action, slice_kind, sub_deliverable_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      tag,
      kind,
      filesJson,
      verifyCmd,
      doneCriteriaJson,
      taskType,
      readFirstJson,
      prescriptiveAction,
      sliceKindVal,
      subDeliverableJson,
      now,
      now,
    ],
  })
  const r = await getClient().execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [id],
  })
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

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
      | 'failureReason'
      | 'failureSignature'
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

  // Read the current status before the UPDATE so we can detect real
  // transitions (patch.status === existing status ⇒ no-op, skip dismissals).
  let previousStatus: string | null = null
  if (patch.status !== undefined) {
    const before = store
      ? await store.query({ sql: `SELECT status FROM tasks WHERE id = ?`, args: [id] })
      : await getClient().execute({ sql: `SELECT status FROM tasks WHERE id = ?`, args: [id] })
    previousStatus =
      before.rows.length > 0
        ? ((before.rows[0] as unknown as { status: string }).status ?? null)
        : null
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

  // Build the event INSERT statement upfront (validates payload via Zod;
  // throws before any DB write if the payload is invalid).  null means no
  // event should be emitted for this call (unchanged-status or non-status
  // write).
  let eventStmt: InStatement | null = null
  if (isStatusChange) {
    if (patch.status === 'failed') {
      eventStmt = buildEventInsert('task.failed', {
        taskId: id,
        error: patch.error ?? patch.failureReason ?? '',
      })
    } else if (patch.status === 'dropped') {
      eventStmt = buildEventInsert('task.dropped', {
        taskId: id,
        dropReason: patch.failureReason ?? '',
      })
    } else if (patch.status === 'queued') {
      eventStmt = buildEventInsert('task.queued', { taskId: id })
    } else if (patch.status === 'blocked') {
      eventStmt = buildEventInsert('task.blocked', {
        taskId: id,
        fixTaskId: null,
        failureSignature: patch.failureSignature ?? '',
        failingStep: patch.failedPhase ?? '',
      })
    } else if (patch.status === 'done') {
      eventStmt = buildEventInsert('task.completed', { taskId: id, result: null })
    }
  }

  const updateStmt: InStatement = {
    sql: `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`,
    args: args as never,
  }

  if (appendSessionId) {
    // Atomically (a) apply the field updates, (b) append the new session id
    // to claude_session_ids if it isn't already present, and (c) insert the
    // outbox event row.  All three writes share one write transaction so a
    // crash between any two leaves the DB consistent (either everything
    // committed or nothing).
    //
    // Note: TaskStore.atomic() lands in a subsequent slice; until then the
    // session-id path still uses the raw client transaction via withWriteTx.
    const sessionIdStmt: InStatement = {
      sql: `UPDATE tasks
               SET claude_session_ids =
                     json_insert(
                       claude_session_ids,
                       '$[#]',
                       ?
                     )
             WHERE id = ?
               AND NOT EXISTS (
                 SELECT 1
                   FROM json_each(claude_session_ids)
                  WHERE value = ?
               )`,
      args: [
        patch.claudeSessionId as string,
        id,
        patch.claudeSessionId as string,
      ],
    }
    await withWriteTx(getClient(), async (tx) => {
      await tx.execute(updateStmt)
      await tx.execute(sessionIdStmt)
      // Event INSERT shares the same transaction: if it throws the whole
      // transaction rolls back (no orphan state row without event).
      if (eventStmt) await tx.execute(eventStmt)
    })
  } else if (store) {
    // store.batch runs all statements atomically (BEGIN IMMEDIATE … COMMIT)
    // so the state write and event insert are in the same commit.
    const stmts: InStatement[] = [updateStmt]
    if (eventStmt) stmts.push(eventStmt)
    await store.batch(stmts, 'write')
  } else {
    // Common path: wrap state write and event insert in a single write
    // transaction.  withWriteTx retries on SQLITE_BUSY so a transient lock
    // contention doesn't drop the event.
    await withWriteTx(getClient(), async (tx) => {
      await tx.execute(updateStmt)
      if (eventStmt) await tx.execute(eventStmt)
    })
  }

  // Dismiss open inbox alerts and stale-worktree dismissal rows whenever
  // the task's status actually changes (no-op writes are excluded so a
  // caller that writes the same status twice doesn't wipe a freshly-raised
  // alert that arrived between the two writes).
  if (
    patch.status !== undefined &&
    previousStatus !== null &&
    patch.status !== previousStatus
  ) {
    await dismissAlertsOnStatusChange(id, patch.status)
    // The derived inbox honours one persistent operator opinion — a
    // dismissal. Wipe it on any real status change so a dismissed-then-
    // restarted task resurfaces if it gets stuck again.
    await clearDismissalForEntity('task', id)
  }

  if (patch.status === 'done') {
    const dependents = store
      ? await store.query({
          sql: `SELECT DISTINCT task_id FROM task_blockers WHERE blocker_task_id = ?`,
          args: [id],
        })
      : await getClient().execute({
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
  const stmt = { sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] }
  let r
  if (store) {
    r = await store.query(stmt)
  } else {
    await initQueue()
    r = await getClient().execute(stmt)
  }
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

export const listTasks = async (status?: TaskStatus): Promise<Task[]> => {
  await initQueue()
  const r = status
    ? await getClient().execute({
        sql: `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC`,
        args: [status],
      })
    : await getClient().execute(
        `SELECT * FROM tasks ORDER BY priority DESC, created_at ASC`,
      )
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
}

export const setTaskPriority = async (
  id: string,
  priority: number,
): Promise<Task> => {
  validatePriority(priority)
  await initQueue()
  const c = getClient()
  const before = await c.execute({
    sql: `SELECT status FROM tasks WHERE id = ?`,
    args: [id],
  })
  if (before.rows.length === 0) {
    throw new Error(`task ${id} not found`)
  }
  const status = (before.rows[0] as unknown as { status: string }).status
  if (status !== 'queued') {
    throw new Error(
      `task ${id} is ${status}; only queued tasks can be reprioritized`,
    )
  }
  const now = new Date().toISOString()
  await c.execute({
    sql: `UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`,
    args: [priority, now, id],
  })
  const r = await c.execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [id],
  })
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

export const deleteTask = async (id: string): Promise<void> => {
  await initQueue()
  await getClient().execute({
    sql: `DELETE FROM tasks WHERE id = ?`,
    args: [id],
  })
}

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
   * Ids of tasks whose `fix_for_task_id` pointed at the dropped row.
   * Cleared to NULL alongside the delete so the pointer doesn't dangle.
   * The pointed-at column is not declared as a FK, but readers conflate
   * a non-null pointer with "still has a parent" — null is the honest
   * post-drop state.
   */
  fixForRefsCleared: string[]
}

/**
 * Database-level drop. Works regardless of status — clears every
 * task_blockers row mentioning <id> on either side, nulls out any
 * `fix_for_task_id` pointer that referred to <id>, and deletes the
 * task row. Caller is responsible for cancelling any in-flight workflow
 * and removing the worktree+branch on disk before invoking this.
 */
export const dropTask = async (id: string): Promise<DropTaskResult> => {
  await initQueue()
  const c = getClient()
  const before = await c.execute({
    sql: `SELECT status FROM tasks WHERE id = ?`,
    args: [id],
  })
  if (before.rows.length === 0) {
    throw new Error(`task ${id} not found`)
  }
  const previousStatus = (before.rows[0] as unknown as { status: TaskStatus }).status

  const incoming = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
    args: [id],
  })
  const outgoing = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
    args: [id],
  })
  const incomingCount = Number(
    (incoming.rows[0] as unknown as { n: number | bigint }).n,
  )
  const outgoingCount = Number(
    (outgoing.rows[0] as unknown as { n: number | bigint }).n,
  )

  const refRows = await c.execute({
    sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
    args: [id],
  })
  const fixForRefsCleared = refRows.rows.map(
    (row) => (row as unknown as { id: string }).id,
  )

  const tx = await c.transaction('write')
  try {
    await tx.execute({
      sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
      args: [id, id],
    })
    // task_proposal_blockers has a FK on task_id → tasks(id). Delete these
    // rows before the task row so the constraint never fires. (Rows where the
    // task appears as proposal_id are in a different db and have no FK here.)
    await tx.execute({
      sql: `DELETE FROM task_proposal_blockers WHERE task_id = ?`,
      args: [id],
    })
    if (fixForRefsCleared.length > 0) {
      // fix_for_task_id is not declared as a FK, but a dangling pointer
      // confuses readers that conflate a non-null value with "parent
      // exists". Set NULL is the honest post-drop state; the row's
      // `kind = 'fix'` invariant is checked only on inserts, so legacy
      // rows surviving a parent drop stay queryable without error.
      await tx.execute({
        sql: `UPDATE tasks SET fix_for_task_id = NULL, updated_at = ? WHERE fix_for_task_id = ?`,
        args: [new Date().toISOString(), id],
      })
    }
    await tx.execute({
      sql: `DELETE FROM tasks WHERE id = ?`,
      args: [id],
    })
    await tx.commit()
  } catch (error: unknown) {
    tx.close()
    throw error
  }

  return {
    taskId: id,
    previousStatus,
    edgesRemoved: { incoming: incomingCount, outgoing: outgoingCount },
    fixForRefsCleared,
  }
}

export const insertReflectionTask = async (corpusSize: number): Promise<string> => {
  await initQueue()
  const id = `reflect-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const prompt = `mars reflect run over ${corpusSize} task(s) at ${now}`
  await getClient().execute({
    sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)`,
    args: [id, prompt, id, now, now],
  })
  return id
}

export const addBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  if (blockerIds.length === 0) return
  await initQueue()
  const c = getClient()

  const taskRow = await c.execute({
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
    const r = await c.execute({
      sql: `SELECT 1 FROM tasks WHERE id = ?`,
      args: [id],
    })
    if (r.rows.length === 0) {
      throw new Error(`blocker ${id} not found`)
    }
    unique.push(id)
  }

  if (unique.length === 0) return
  // ADR-0038 leaf-node guard: recovery (fix) tasks cannot be either endpoint
  // of a task_blockers edge. Probe both sides before the batch — the fix-task
  // spawn path (`upsertFixTask`) is the one legitimate origin → fix writer
  // and bypasses this entry point by reaching `task_blockers` directly.
  for (const blockerId of unique) {
    await assertNotRecoveryEdge(taskId, blockerId, { client: c })
  }
  const now = new Date().toISOString()
  // Causal writers default to 'confirmed' state. The Linker writes
  // 'pending-review' rows via a separate entry point (TODO: linker writer).
  const stmts = unique.map((blockerId) => ({
    sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?)`,
    args: [taskId, blockerId, now],
  }))
  await c.batch(stmts, 'write')
}

/**
 * Write a batch of Linker candidate Blocker rows in `'pending-review'` state.
 * Mirrors {@link addBlockers} but stamps `state='pending-review'` so the
 * dispatcher still gates on the row even though it has not been confirmed.
 * Used by the deterministic Linker added by PRD 2be831da; tests exercise it
 * directly until the Linker landing slice wires the call site.
 */
export const addPendingReviewBlockers = async (
  taskId: string,
  blockerIds: readonly string[],
): Promise<void> => {
  if (blockerIds.length === 0) return
  await initQueue()
  const c = getClient()

  const taskRow = await c.execute({
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
    const r = await c.execute({
      sql: `SELECT 1 FROM tasks WHERE id = ?`,
      args: [id],
    })
    if (r.rows.length === 0) {
      throw new Error(`blocker ${id} not found`)
    }
    unique.push(id)
  }
  if (unique.length === 0) return
  // ADR-0038 leaf-node guard: even pending-review Linker rows are subject to
  // the recovery leaf rule. A recovery task is never the candidate of a
  // keyword-overlap edge.
  for (const blockerId of unique) {
    await assertNotRecoveryEdge(taskId, blockerId, { client: c })
  }
  const now = new Date().toISOString()
  const stmts = unique.map((blockerId) => ({
    sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'pending-review', ?)`,
    args: [taskId, blockerId, now],
  }))
  await c.batch(stmts, 'write')
}

export const removeBlocker = async (
  taskId: string,
  blockerId: string,
): Promise<{ removed: boolean }> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
    args: [taskId, blockerId],
  })
  return { removed: r.rowsAffected > 0 }
}

export const clearBlockers = async (taskId: string): Promise<void> => {
  await initQueue()
  await getClient().execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
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
  await initQueue()
  const c = getClient()

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
  await initQueue()
  const r = await getClient().execute({
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
  await initQueue()
  const r = await getClient().execute({
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
  await initQueue()
  const r = await getClient().execute({
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
  await initQueue()
  const c = getClient()
  const dependents = await listTasksBlockedByProposal(proposalId)
  if (dependents.length === 0) return { transferred: [] }
  const blockerRow = await c.execute({
    sql: `SELECT 1 FROM tasks WHERE id = ?`,
    args: [newBlockerTaskId],
  })
  if (blockerRow.rows.length === 0) {
    throw new Error(`blocker task ${newBlockerTaskId} not found`)
  }
  // ADR-0038 leaf-node guard: refuse the transfer if any endpoint involved
  // is a recovery task. dependents are tasks waiting on a proposal — they
  // are origin work by construction, so practical violations are unlikely,
  // but the guard runs anyway so the bottleneck stays in one place.
  for (const taskId of dependents) {
    if (taskId === newBlockerTaskId) continue
    await assertNotRecoveryEdge(taskId, newBlockerTaskId, { client: c })
  }
  const now = new Date().toISOString()
  const stmts: InStatement[] = []
  for (const taskId of dependents) {
    // Insert the new task_blockers row BEFORE deleting the
    // task_proposal_blockers row so that, even though `batch` is already a
    // single transaction, the intra-transaction statement order also
    // preserves the never-observably-zero-blockers invariant. Self-edges
    // (a slice blocked by itself) are skipped, mirroring addBlockers.
    if (taskId !== newBlockerTaskId) {
      stmts.push({
        sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
        args: [taskId, newBlockerTaskId, now],
      })
    }
    stmts.push({
      sql: `DELETE FROM task_proposal_blockers WHERE task_id = ? AND proposal_id = ?`,
      args: [taskId, proposalId],
    })
  }
  await c.batch(stmts, 'write')
  return { transferred: dependents }
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
export const unblockTask = async (
  taskId: string,
): Promise<UnblockTaskResult> => {
  await initQueue()
  const c = getClient()
  const before = await c.execute({
    sql: `SELECT status FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (before.rows.length === 0) {
    throw new Error(`task ${taskId} not found`)
  }
  const previousStatus = (before.rows[0] as unknown as { status: string }).status
  // 'queued' is accepted alongside 'blocked' so a user can drop a task that
  // hasn't dispatched yet (e.g. an auto-spawned recovery whose parent chain
  // has been replaced). The flip is the same: status -> 'failed', clear any
  // task_blockers rows. The follow-up `mars purge` then deletes the row.
  if (previousStatus !== 'blocked' && previousStatus !== 'queued') {
    return { taskId, outcome: 'noop', previousStatus }
  }
  const now = new Date().toISOString()
  await c.execute({
    sql: `UPDATE tasks
             SET status = 'failed',
                 updated_at = ?
           WHERE id = ? AND status IN ('blocked', 'queued')`,
    args: [now, taskId],
  })
  await c.execute({
    sql: `DELETE FROM task_blockers WHERE task_id = ?`,
    args: [taskId],
  })
  return { taskId, outcome: 'unblocked', previousStatus }
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
  await initQueue()
  const r = await getClient().execute({
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
  await initQueue()
  const r = await getClient().execute({
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
  await initQueue()
  // Only confirmed-or-pending-review rows gate dispatch; rejected rows are
  // historical/audit and must not appear here.
  const r = await getClient().execute({
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
    await initQueue()
    r = await getClient().execute(stmt)
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
  await initQueue()
  const c = getClient()
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

export const promoteDraftToQueued = async (
  taskId: string,
): Promise<Task | null> => {
  await initQueue()
  const now = new Date().toISOString()
  // PRD 2be831da: 'queued' requires zero confirmed-or-pending-review rows;
  // rejected rows are historical and must not gate the promote.
  const upd = await getClient().execute({
    sql: `UPDATE tasks
             SET status = 'queued', updated_at = ?
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
  if (upd.rowsAffected === 0) return null
  const r = await getClient().execute({
    sql: `SELECT * FROM tasks WHERE id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}
