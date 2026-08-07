import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { resolveContext, resolveDbTarget } from './context'
import { parseClaudeSessionIds } from './lib/claude-session-ids'
import type { Author, AuthorKind } from './author'
import { markSchemaReady, openDb, type DbClient, type DbInValue, type DbStatement } from './lib/db'
import { ensureSchema } from './lib/pg-schema'
import { buildEventInsert, withWriteTx } from './lib/outbox'
import {
  asStepId,
  computeFailureSignature,
  TERMINAL_VERDICT_PREFIXES,
} from './lib/failure-signature'
import { Arc } from './arc'
import type { DomainTaskStore as TaskStore } from './store/task-store'
import { raiseActionQueueItem } from './lib/action-queue'
import { teardownDeploymentsForTask } from './lib/deployment/teardown'
import type { SliceSpec, SubDeliverableSpec } from './slice-spec'

const execFileP = promisify(execFile)
const gzipAsyncQ = promisify(gzip)

export type TaskStatus =
  | 'draft'
  | 'triaging'
  | 'queued'
  | 'running'
  | 'verifying'
  // Parked after a clean verify: a live dev server is running off the worktree
  // and the task waits for a human to Validate (→ merge) or Reject (→ failed)
  // via the action queue. Like 'blocked', this is a non-dispatchable parking
  // status; the gate is a workflow boundary (the worker returns and holds no
  // merge lock) so it survives daemon restarts. See the awaiting-validation
  // action-queue kind.
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

/** Why a Chore or operator deliberately terminally dropped a task. */
export type TaskDropReason =
  | 'origin-succeeded'
  | 'superseded'
  | 'arc-rescued'
  | 'purged'
  | 'slicer-rollback'
  | 'reslice'
  | 'slicer-preflight'

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'failed',
  'dropped',
])

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
 * SQL predicate fragment — "this blocker still gates its dependent". The
 * mirror image of {@link SETTLED_BLOCKER_STATUSES}, kept as one exported
 * string so every gating query (promote, unblock, recover, hasIncomplete,
 * listBlockers) shares a single definition and cannot drift apart. `t` must
 * be the alias bound to the BLOCKER row.
 */
export const UNSETTLED_BLOCKER_SQL = `t.status NOT IN ('done', 'dropped')`

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
 * terminal status. Terminal tasks are immutable —
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
  createdAt: number
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
 * `<done>` (boolean done criteria), and `<merge_mode>` — instead of free prose.
 *
 * `<merge_mode>auto</merge_mode>` is the default: the agent executes end-to-end
 * and commits. `<merge_mode>gated</merge_mode>` pauses before merge for explicit
 * human verification. Direct `mars task add` rows without `--merge` default to
 * `'auto'`.
 *
 * Every field is optional on the type to preserve legacy free-form rows:
 * an empty/NULL spec degrades cleanly to the pre-existing prompt-only
 * behaviour. Slicer emissions always populate a full spec.
 */
export type MergeMode = 'auto' | 'gated'

export const MERGE_MODES: readonly MergeMode[] = ['auto', 'gated'] as const

export const isMergeMode = (value: unknown): value is MergeMode =>
  value === 'auto' || value === 'gated'

export interface TaskSpec {
  files: readonly string[]
  verifyCmd: string | null
  doneCriteria: readonly string[]
  mergeMode: MergeMode
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
  /** A coordinator task owns the whole parsed slicing plan. */
  executionMode?: 'coordinated'
  /** Slices delegated internally by a coordinator task. */
  slicePlan?: SliceSpec[]
  /**
   * Shell command that boots the app for a `reviewType: 'manual'` review step.
   * The review primitive prefers this over `package.json` `scripts.dev` when
   * resolving how to start the preview. Absent on ad-hoc rows.
   */
  previewCmd?: string | null
}

export const EMPTY_TASK_SPEC: TaskSpec = {
  files: [],
  verifyCmd: null,
  doneCriteria: [],
  mergeMode: 'auto',
}

export interface TaskPlan {
  functional: string
  technical: string
}

export interface QaReportCriterion {
  criterion: string
  verdict: 'pass' | 'fail' | 'unverifiable'
  screenshotPath: string | null
  note: string
}

export interface QaReport {
  criteria: QaReportCriterion[]
  bootReason: string | null
  completedAt: string
  durationMs: number | null
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
  dropReason: TaskDropReason | null
  failureReason: string | null
  /**
   * Typed catalog code (e.g. `verify:typecheck`) for the failure. Companion
   * to the loose-string `failureReason`. Slice G writes it on every failure
   * path; the legacy column stays for forensic continuity. Null on legacy
   * rows landed before slice G.
   */
  failureReasonCode: string | null
  /**
   * JSON-encoded coder stall diagnostics captured before a hard timeout kill.
   * Contains stderr tail, exit code, done-signal state, and elapsed time.
   * Null on non-stalled tasks and legacy rows.
   */
  stallDiagnostics: string | null
  recoverySpawnedCount: number
  /**
   * Number of times this task has been auto-restarted due to an environmental
   * failure signature (worktree pruned, timeout, etc.). Incremented by the
   * environmental-restart path in `handleTaskFailureWithFixTask`; never resets
   * between attempts so the cap (MAX_ENV_RESTART_ATTEMPTS) is per task-lifetime,
   * not per episode. Zero on legacy rows or tasks that have never hit an
   * environmental failure.
   */
  envRestartCount: number
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
   */
  previewValidated: boolean
  /**
   * Recipe-specific payload preserved with a recovery task. NULL for every
   * non-recovery row. Slice F.2 stores `{ recipe, integrationBranch }` here
   * for `main-commiter` recoveries; later recipes that need typed sidecar
   * state can reuse the same column with their own JSON shape. The persistence
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
  /**
   * QA mode for the review step. `'auto'` (default) runs every configured
   * typecheck/test/lint gate. `'manual'` parks the task for a human to exercise
   * the running app before merge (not yet fully implemented — the review
   * primitive currently throws on `'manual'`). Selected at enqueue via
   * `mars task add --qa <auto|manual>`.
   */
  qa: 'auto' | 'manual'
  /**
   * The step name the task is currently parked at when status is
   * `'awaiting-human'` (written by the manual-step park path). `null` on
   * non-parked rows and before this column was added.
   */
  currentStepName: string | null
  /**
   * The step guide shown to the operator while the task is parked at a manual
   * step. `null` when no guide was provided or the task is not parked.
   */
  currentStepGuide: string | null
  /**
   * Short-lived sub-phase label for an in-flight task (e.g. `merge:fast-forward`).
   * Written by the merge and verify primitives to surface the current sub-step on
   * the board card. `null` for queued/done/failed tasks and for tasks that predate
   * this column. Cleared automatically when the task transitions out of in-flight
   * status. Optional for backwards compat with test fixtures that predate this field.
   */
  activityDetail?: string | null
  /**
   * When set, this is a compensation/cleanup task for a force-purged arc. The
   * value is the `origin_id` of the abandoned arc. `null` for all other tasks.
   * Compensation tasks are regular tasks (not recovery/fix tasks) — they have
   * their own arc lifecycle and appear on the board as actionable cleanup work.
   * Optional on the type for backwards compat with test fixtures that predate
   * this field; always populated at the persistence boundary (`null` for non-
   * compensation rows).
   */
  compensatesArcId?: string | null
  /**
   * Epoch-millisecond timestamp set by `mars continue` (and cleared by
   * `mars restart`) to mark the start of the current re-queue episode.
   *
   * The poll-fallback's {@link checkAndEscalateRequeueCeiling} uses this as
   * the elapsed-time anchor when it is non-null, overriding the default
   * MIN(step.startedAt) anchor. This prevents the ceiling from firing
   * immediately on a task whose journal contains steps from a previous run
   * that may be hours or days old — `mars continue` deliberately preserves
   * the journal to enable checkpoint-resume, but the ceiling must not
   * penalise the task for that preserved history.
   *
   * `mars restart` clears this to null so a restarted task (which also wipes
   * the journal) falls back to the MIN(step.startedAt) anchor from the fresh
   * run's journal entries.
   *
   * Optional for backwards compatibility with test fixtures that predate this
   * field; always populated at the persistence boundary (`null` for non-continued
   * rows and legacy rows created before this column was added).
   */
  requeueAnchorMs?: number | null
  /** Cumulative dispatch uptime at the first dispatch of this re-queue episode. */
  requeueDispatchUptimeMs?: number | null
  /**
   * Count of attempts where the coder never ran because the provider rejected
   * the run before starting (rate/spend limit). The poll-fallback ceiling
   * subtracts this from `maxAttempt` to compute the effective real-work attempt
   * count, so a quota wall does not burn the ceiling. Defaults to 0.
   */
  quotaRejectedAttempts?: number
  /**
   * Structured QA report persisted by behaviour-verify. Contains per-criterion
   * verdicts, screenshot paths, and timing data. Null when no behaviour-verify
   * has run or on legacy rows.
   */
  qaReport?: QaReport | null
  /**
   * When true, the usage-aware scheduler may defer this task to a cheaper
   * window. Set at enqueue via `mars task add --deferrable`. Defaults to
   * false for all rows.
   */
  deferrable: boolean
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

let clientSingleton: DbClient | null = null

/**
 * Seam-internal DB client resolver for the shared task+state database
 * (ADR-0034: tasks and proposals share one store; migration 0002: the store
 * is embedded PostgreSQL, resolved via `resolveDbTarget`). NOT part of the
 * public surface (ADR-0021): the only sanctioned importer is the TaskStore
 * seam (`store/task-store.ts`), which threads it to callers via the injected
 * store. No live module outside the store may import this — `getClient` is
 * gone.
 */
export const resolveQueueClient = (): DbClient => {
  if (!clientSingleton) {
    clientSingleton = openDb(resolveDbTarget())
  }
  return clientSingleton
}

/**
 * Seam-internal, memoized schema guarantee (ADR-0021: schema management lives
 * behind the store). The canonical DDL is `ensureSchema` in
 * `core/lib/pg-schema.ts` (migration 0002) — the old ~1300-line imperative
 * `migrateQueueSchema` introspection engine is gone. Queue's domain
 * functions call this defensively before touching tables; the TaskStore runs
 * `ensureSchema` itself on its own init path.
 */
let schemaReady: Promise<void> | null = null

export const ensureQueueSchema = (): Promise<void> => {
  if (!schemaReady) {
    // Call markSchemaReady after the DDL completes so that the first
    // execute() / batch() call on this client doesn't re-run ensureSchema.
    // Direct ensureSchema callers bypass ensureClientSchema and therefore
    // never update schemaReadyByTarget; without this, every test that calls
    // migrateQueueSchema() followed by a resolveStateClient().execute() pays
    // an extra ~10 s DDL pass on PGlite-backed databases.
    schemaReady = ensureSchema(resolveQueueClient()).then(() => {
      markSchemaReady(resolveQueueClient())
    })
  }
  return schemaReady
}

/**
 * Compatibility name retained while callers migrate from the SQLite-era
 * bootstrap API. PostgreSQL has one canonical, idempotent schema.
 */
export const migrateQueueSchema = (): Promise<void> => ensureQueueSchema()

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
  const now = Date.now()
  const execute = async (stmt: { sql: string; args: DbInValue[] }) => {
    if (store) {
      await store.execute(stmt)
    } else {
      await ensureQueueSchema()
      await resolveQueueClient().execute(stmt)
    }
  }

  // Write transcript as a gzip-compressed bytea to the dedicated table.
  // This keeps step_ended payloads small so hot aggregate queries are fast.
  if (input.conversationJson !== undefined) {
    const capped = capConversationJson(input.conversationJson)
    const compressed = await gzipAsyncQ(Buffer.from(capped, 'utf8'))
    await execute({
      sql: `INSERT INTO task_durable_transcripts
              (task_id, session_id, step_name, created_at, transcript, byte_len)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (task_id) DO UPDATE SET
              session_id = excluded.session_id,
              step_name  = excluded.step_name,
              created_at = excluded.created_at,
              transcript = excluded.transcript,
              byte_len   = excluded.byte_len`,
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
      args: [id, Date.now(), input.taskId, JSON.stringify(payloadObj)],
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
  (SELECT COALESCE(json_agg(session_id ORDER BY position)::text, '[]')
     FROM task_claude_sessions WHERE task_id = t.id) AS claude_session_ids,
  t.error, t.drop_reason, t.recovery_spawned_count, t.env_restart_count,
  t.author_kind, t.author_name,
  t.failure_reason, t.failure_reason_code, t.stall_diagnostics, t.recovery_payload,
  t.fix_for_task_id, t.failure_signature, t.kind, t.priority, t.tag,
  t.tags_json, t.origin_id, t.parent_proposal_id, t.slice_index,
  t.failed_phase, t.resume_from,
  (SELECT COALESCE(json_agg(path ORDER BY position)::text, '[]')
     FROM task_spec_files WHERE task_id = t.id) AS files_json,
  t.verify_cmd,
  (SELECT COALESCE(json_agg(criterion ORDER BY position)::text, '[]')
     FROM task_done_criteria WHERE task_id = t.id) AS done_criteria_json,
  t.merge_mode, t.read_first_json, t.prescriptive_action, t.slice_kind,
  t.sub_deliverable_json, t.integration_head_sha,
  t.dev_server_url, t.dev_server_pid, t.preview_validated, t.intent,
  t.lease_owner, t.leased_at, t.lease_note,
  t.origin_session_id, t.workflow,
  t.current_step_name, t.current_step_guide,
  t.activity_detail,
  t.compensates_arc_id,
  t.qa,
  t.requeue_anchor_ms,
  t.requeue_dispatch_uptime_ms,
  t.qa_report_json,
  t.deferrable,
  t.quota_rejected_attempts,
  t.created_at, t.updated_at
FROM tasks t`

/**
 * Structured writes retain a terminal task row solely to satisfy merge-job
 * foreign keys. They are bookkeeping, never operator-visible work.
 */
export const ORDINARY_TASK_SQL = `COALESCE(t.kind, 'task') <> 'structured-write'`

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
    dropReason: (row.drop_reason as TaskDropReason | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    failureReasonCode: (row.failure_reason_code as string | null) ?? null,
    stallDiagnostics: (row.stall_diagnostics as string | null) ?? null,
    recoverySpawnedCount: Number(row.recovery_spawned_count ?? 0),
    // MUST be present in TASK_SEL. This column is a WRITE-ONLY-looking field:
    // the only writer is updateTask and the only reader is the environmental
    // auto-restart cap in queue-fix-tasks.ts. When TASK_SEL omitted it,
    // `row.env_restart_count` was `undefined` on every read, so the counter
    // resolved to 0 forever, `envRestartCount < MAX_ENV_RESTART_ATTEMPTS` was
    // permanently true, and the cap never fired: task mars-6cf9774f rode 35
    // consecutive "environmental restart #1" re-queues (verify step attempt 37)
    // while the persisted column sat at 1. A missing column here silently
    // disables a loop bound — it does not fail a type check.
    envRestartCount: Number(row.env_restart_count ?? 0),
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
    currentStepName: (row.current_step_name as string | null) ?? null,
    currentStepGuide: (row.current_step_guide as string | null) ?? null,
    activityDetail: (row.activity_detail as string | null) ?? null,
    compensatesArcId: (row.compensates_arc_id as string | null) ?? null,
    qa: (row.qa as string | null) === 'manual' ? 'manual' : 'auto',
    requeueAnchorMs:
      row.requeue_anchor_ms === null || row.requeue_anchor_ms === undefined
        ? null
        : Number(row.requeue_anchor_ms),
    requeueDispatchUptimeMs:
      row.requeue_dispatch_uptime_ms === null || row.requeue_dispatch_uptime_ms === undefined
        ? null
        : Number(row.requeue_dispatch_uptime_ms),
    qaReport: parseQaReport(row.qa_report_json),
    deferrable: Number(row.deferrable ?? 0) === 1,
    quotaRejectedAttempts: Number(row.quota_rejected_attempts ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

const parseQaReport = (raw: unknown): QaReport | null => {
  if (raw === null || raw === undefined) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || !Array.isArray(parsed.criteria)) return null
    return parsed as QaReport
  } catch {
    return null
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
  const rawType = (row.merge_mode as string | null) ?? null
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
    mergeMode: isMergeMode(rawType) ? rawType : 'auto',
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
  /** Chat thread that initiated this task; persisted atomically with the task row. */
  chatThreadId?: string
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
  /**
   * QA mode for the review step. Defaults to `'auto'` at the SQL level.
   * `'manual'` parks for human QA (not yet fully implemented).
   */
  qa?: 'auto' | 'manual'
  /**
   * When set, marks this task as a compensation/cleanup task for the arc
   * identified by this `origin_id`. Stored in `compensates_arc_id`. Only set
   * by the force-purge path — do not use this for recovery tasks.
   */
  /**
   * When true, the usage-aware scheduler may defer this task to a cheaper
   * window. Defaults to false.
   */
  deferrable?: boolean
  compensatesArcId?: string
  /**
   * Dedup key stored in `followup_dedup_key` to prevent duplicate tasks on
   * repeated invocations. The force-purge compensation path uses
   * `arc-force-purge-compensation:<originId>` so that repeated force operations
   * on the same arc do not produce multiple cleanup tasks.
   */
  followupDedupKey?: string
  /**
   * When set, this enqueue supersedes the named existing task. The supersede
   * sequence (executed by `Arc.createOrigin`):
   *   1. Loads the superseded task; derives `originId` from it.
   *   2. Releases the superseded task's worktree (`git worktree remove --force`,
   *      keepBranch=true) and clears its `worktree_path`.
   *   3. Marks the superseded task `'dropped'`.
   *   4. Creates a fresh worktree for the new task on the superseded branch
   *      (at `.mars/worktrees/<newTaskId>/`).
   *   5. Proceeds with the normal INSERT, passing `originId` and setting
   *      `branch`/`worktreePath` to the superseded task's values.
   *
   * If step 4 fails after step 2 the superseded task remains `'dropped'`, no
   * new task row is created, and an error surfaces with the branch name so the
   * operator can retry.
   */
  supersedes?: string
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

/**
 * Best-effort `<step>/<error-class>` signature for a failure patch that did not
 * carry one. Used by {@link updateTask}'s signature floor.
 *
 * Preference order: a `failure_reason_code` that is already a full signature
 * (it contains a `/`) is authoritative; otherwise the step half comes from the
 * reason code, then the failed phase, then a generic `terminal`, and the error
 * class is classified from whatever text the patch carries.
 */
const deriveFailureSignature = (patch: {
  error?: string | null
  failedPhase?: FailedPhase | null
  failureReason?: string | null
  failureReasonCode?: string | null
}): string => {
  const code = patch.failureReasonCode ?? null
  if (code !== null && code.includes('/')) {
    // Strip any leading terminal-verdict prefix before treating `code` as a
    // signature. Without this, a code like
    // `recovery_exhausted:verify:typecheck/typecheck-cannot-find-name: …`
    // would be returned verbatim, embedding free text into failure_signature.
    const matchedPrefix = TERMINAL_VERDICT_PREFIXES.find((p) => code.startsWith(p))
    if (matchedPrefix) {
      // After stripping the prefix: `<step>/<class>: <error text>` — extract
      // only the `<step>/<class>` part before the `: ` separator.
      const afterPrefix = code.slice(matchedPrefix.length)
      const colonSpace = afterPrefix.indexOf(': ')
      const candidate = colonSpace >= 0 ? afterPrefix.slice(0, colonSpace) : afterPrefix
      if (candidate.includes('/')) return candidate
    }
    return code
  }
  const step = asStepId(code) ?? asStepId(patch.failedPhase) ?? 'terminal'
  return computeFailureSignature(step, patch.error ?? patch.failureReason ?? '')
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
      | 'devServerUrl'
      | 'devServerPid'
      | 'previewValidated'
      | 'failureReason'
      | 'failureSignature'
      | 'leaseOwner'
      | 'leasedAt'
      | 'leaseNote'
      | 'currentStepName'
      | 'currentStepGuide'
      | 'activityDetail'
      | 'recoverySpawnedCount'
      | 'envRestartCount'
      | 'workflow'
      | 'requeueAnchorMs'
      | 'requeueDispatchUptimeMs'
      | 'stallDiagnostics'
      | 'quotaRejectedAttempts'
    > & {
      /** Typed explanation persisted when a task is deliberately dropped. */
      dropReason?: TaskDropReason | null
      /**
       * Typed catalog code for the failure (e.g. `verify:main-dirty`).
       * Companion to the legacy free-text `failureReason`; either can be
       * written on its own, both can be written together. Slice F.2
       * starts populating it for dirty-main parking.
       */
      failureReasonCode?: string | null
      /**
       * JSON-encoded sidecar for recovery (kind='fix') rows. Slice F.2 stores
       * `{ recipe, integrationBranch }` here for `main-commiter` recoveries.
       */
      recoveryPayload?: string | null
      /**
       * The full verify step output (per-gate headers + diagnostics + gate
       * outcomes JSON). When provided, persisted to the task's transcript record
       * via {@link upsertTranscript} so structural crashes (outer catch path) are
       * visible in the run-timeline view rather than showing 'none recorded'.
       */
      verifyOutput?: string | null
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
    TERMINAL_TASK_STATUSES.has(previousStatus as TaskStatus)
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

  // Transitioning to 'done': clear stale failure fields from any prior failed
  // attempt so a done row never carries a misleading failure_reason.  Only
  // applies when a real status change is happening (previousStatus is set and
  // differs from 'done', the only terminal-immutable guard that blocks this).
  if (patch.status === 'done' && previousStatus !== null && previousStatus !== 'done') {
    patch = { ...patch, failureReason: null, failureSignature: null, failureReasonCode: null }
  }

  // Auto-clear activity_detail when leaving in-flight statuses.
  // activity_detail is a short-lived label for the current merge/verify sub-phase;
  // it must not linger once the task is done, failed, parked, or any other
  // non-in-flight state. Callers may still set activityDetail explicitly to null
  // (clearing is idempotent).
  const IN_FLIGHT_STATUSES = new Set(['running', 'verifying', 'merging', 'vega-reconciling'])
  if (
    patch.status !== undefined &&
    !IN_FLIGHT_STATUSES.has(patch.status) &&
    patch.activityDetail === undefined
  ) {
    patch = { ...patch, activityDetail: null }
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
  if (patch.recoverySpawnedCount !== undefined) {
    fields.push('recovery_spawned_count = ?')
    args.push(patch.recoverySpawnedCount)
  }
  if (patch.envRestartCount !== undefined) {
    fields.push('env_restart_count = ?')
    args.push(patch.envRestartCount)
  }
  if (patch.error !== undefined) {
    fields.push('error = ?')
    args.push(patch.error)
  }
  if (patch.dropReason !== undefined) {
    fields.push('drop_reason = ?')
    args.push(patch.dropReason)
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
  if (patch.currentStepName !== undefined) {
    fields.push('current_step_name = ?')
    args.push(patch.currentStepName)
  }
  if (patch.currentStepGuide !== undefined) {
    fields.push('current_step_guide = ?')
    args.push(patch.currentStepGuide)
  }
  if (patch.activityDetail !== undefined) {
    fields.push('activity_detail = ?')
    args.push(patch.activityDetail)
  }
  if (patch.failureReason !== undefined) {
    fields.push('failure_reason = ?')
    args.push(patch.failureReason)
  }
  if (patch.failureSignature !== undefined) {
    fields.push('failure_signature = ?')
    args.push(patch.failureSignature)
  } else if (patch.status === 'failed') {
    // Signature floor. Everything in the self-heal chain keys off
    // `failure_signature` — fix-recipe matching, the signature-storm streak
    // counter, the Steward's evidence brief, `isEnvironmentalSignature`
    // auto-restart — and every one of them skips a NULL, so a failure write
    // that omits the column is invisible to all of it. Several failure writers
    // (the phantom-task watchdog, the requeue ceiling, the operator-reject and
    // awaiting-validation paths) only ever wrote `failure_reason_code`.
    //
    // COALESCE, not an unconditional write: a caller-supplied signature always
    // wins (handled above), and a precise signature already on the row must
    // never be downgraded to one derived from a coarse phase.
    fields.push('failure_signature = COALESCE(failure_signature, ?)')
    args.push(deriveFailureSignature(patch))
  }
  if (patch.failureReasonCode !== undefined) {
    fields.push('failure_reason_code = ?')
    args.push(patch.failureReasonCode)
  }
  if (patch.stallDiagnostics !== undefined) {
    fields.push('stall_diagnostics = ?')
    args.push(patch.stallDiagnostics)
  }
  if (patch.recoveryPayload !== undefined) {
    fields.push('recovery_payload = ?')
    args.push(patch.recoveryPayload)
  }
  if (patch.workflow !== undefined) {
    fields.push('workflow = ?')
    args.push(patch.workflow)
  }
  if (patch.requeueAnchorMs !== undefined) {
    fields.push('requeue_anchor_ms = ?')
    args.push(patch.requeueAnchorMs)
  }
  if (patch.requeueDispatchUptimeMs !== undefined) {
    fields.push('requeue_dispatch_uptime_ms = ?')
    args.push(patch.requeueDispatchUptimeMs)
  }
  if (patch.quotaRejectedAttempts !== undefined) {
    fields.push('quota_rejected_attempts = ?')
    args.push(patch.quotaRejectedAttempts)
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
  const eventStmts: DbStatement[] = []
  if (isStatusChange) {
    if (patch.status === 'failed') {
      eventStmts.push(
        buildEventInsert('task.failed', {
          taskId: id,
          error: patch.error ?? patch.failureReason ?? '',
          // Carry the failure signature in the event payload so subscribers
          // can read it even after reopenTerminalTask NULLs the task-row field.
          failureSignature: patch.failureSignature ?? deriveFailureSignature(patch),
        }),
        buildEventInsert('task.terminal', { taskId: id, reason: 'failed' }),
      )
    } else if (patch.status === 'dropped') {
      eventStmts.push(
        buildEventInsert('task.dropped', {
          taskId: id,
          dropReason: patch.dropReason ?? patch.failureReason ?? '',
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
  const sessionIdStmt: DbStatement | undefined = appendSessionId
    ? {
        sql: `INSERT INTO task_claude_sessions (task_id, session_id, position)
            SELECT ?, ?,
              COALESCE(
                (SELECT MAX(position) + 1 FROM task_claude_sessions WHERE task_id = ?),
                0
              )
            ON CONFLICT (task_id, session_id) DO NOTHING`,
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

  // Persist verifyOutput when the caller provides it (e.g. the outer catch
  // path in the verify primitive records a structural crash). Best-effort:
  // a transcript write failure must never mask the task status failure.
  if (patch.verifyOutput !== undefined && patch.verifyOutput !== null) {
    await upsertTranscript({ taskId: id, verifyOutput: patch.verifyOutput }, store).catch(
      () => {},
    )
  }

  // NOTE: Action-queue clearing on status change is NOT done inline here.
  // The Invalidator (alert-dismisser) subscribes to the task lifecycle
  // events emitted above and is the SOLE closer of Action-queue rows and
  // dismissals — see ADR-0027/0030. Clearing inline would (a) duplicate the
  // subscriber and (b) be lost for any writer that bypasses updateTask, the
  // exact staleness class this design eliminates.

  // Done-implies-merged guard: raise the action-queue item after the write so
  // it is colocated with the failure event rather than emitted speculatively.
  // Awaited but wrapped in try-catch: best-effort semantics — a raise failure
  // must never mask the task failure itself.
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
    // Best-effort: tear down any preview deployments for this task now that it
    // has successfully merged. Errors are caught and logged inside
    // teardownDeploymentsForTask — never rethrown into the caller.
    await teardownDeploymentsForTask(id)

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

/**
 * The sole audited seam for an operator to reopen a terminal task.  General
 * task updates cannot use this capability: the database trigger consumes the
 * audit record in the same transaction as this transition.
 */
export const reopenTerminalTask = async (
  id: string,
  reason: string,
  store?: TaskStore,
): Promise<void> => {
  const task = await getTask(id, store)
  if (task === null) throw new Error(`task ${id} not found`)
  if (!TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new IllegalTransitionError(id, task.status, 'queued')
  }
  const now = new Date().toISOString()
  const statements: DbStatement[] = [
    {
      sql: `INSERT INTO task_terminal_reopens (task_id, reason, reopened_by, reopened_at)
            VALUES (?, ?, 'operator', ?)`,
      args: [id, reason, now],
    },
    {
      sql: `UPDATE tasks SET updated_at = ?, status = 'queued', error = NULL,
              failure_reason = NULL, failure_signature = NULL, failure_reason_code = NULL
            WHERE id = ?`,
      args: [now, id],
    },
    buildEventInsert('task.queued', { taskId: id }),
    {
      sql: `UPDATE task_terminal_reopens SET consumed_at = ?
            WHERE task_id = ? AND consumed_at IS NULL`,
      args: [now, id],
    },
  ]
  if (store) {
    await store.batch(statements, 'write')
  } else {
    await ensureQueueSchema()
    await withWriteTx(resolveQueueClient(), async (tx) => {
      for (const statement of statements) await tx.execute(statement)
    })
  }
}

export const getTask = async (id: string, store?: TaskStore): Promise<Task | null> => {
  const stmt = { sql: `${TASK_SEL} WHERE t.id = ?`, args: [id] }
  let r
  if (store) {
    r = await store.query(stmt)
  } else {
    await ensureQueueSchema()
    r = await resolveQueueClient().execute(stmt)
  }
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

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
  /**
   * Number of `merge_jobs` rows deleted as part of this drop (includes rows
   * for the task itself and any cascade-deleted fix tasks). Zero when the task
   * never reached the merge stage.
   */
  mergeJobsDeleted: number
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
 * do not need to reach for raw SQL when the row has slipped into an
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
