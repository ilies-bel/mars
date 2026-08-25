import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { resolveContext } from './context'
import { resolveVcs } from './ports/vcs/registry'
import { parseClaudeSessionIds } from './lib/claude-session-ids'
import type { Author, AuthorKind } from './author'
import { type DbInValue, type DbStatement } from './lib/db'
import { ensureQueueSchema, resolveQueueClient } from './lib/queue-client'
import { buildEventInsert, emitEvent, withWriteTx } from './lib/outbox'
import {
  asStepId,
  computeFailureSignature,
  TERMINAL_VERDICT_PREFIXES,
} from './lib/failure-signature'
import { Arc } from './arc'
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
import { raiseActionQueueItem } from './lib/action-queue'
import { teardownDeploymentsForTask } from './lib/deployment/teardown'
import type { SliceSpec, SubDeliverableSpec } from './slice-spec'

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
} from './lib/queue-primitives'

// Local imports for functions that remain in this file
import {
  type TaskStatus,
  type Task,
  type TaskPlan,
  type TaskKind,
  type TaskTag,
  type TaskDropReason,
  type FailedPhase,
  type MergeMode,
  type QaReport,
  type EnqueueTaskOptions,
  type DropTaskResult,
  TERMINAL_TASK_STATUSES,
  UNSETTLED_BLOCKER_SQL,
  IllegalTransitionError,
  TASK_SEL,
  ORDINARY_TASK_SQL,
  rowToTask,
  getTask,
  isMergeMode,
  coerceToString,
  deriveTaskKind,
} from './lib/queue-primitives'

const gzipAsyncQ = promisify(gzip)

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

  // Write transcript as a gzip-compressed bytea to the dedicated table.
  // This keeps step_ended payloads small so hot aggregate queries are fast.
  let conversationStmt: DbStatement | null = null
  if (input.conversationJson !== undefined) {
    const capped = capConversationJson(input.conversationJson)
    const compressed = await gzipAsyncQ(Buffer.from(capped, 'utf8'))
    conversationStmt = {
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
    }
  }

  // Write verifyOutput to a step_ended event (it is small — at most 64 KB).
  // The transcript field is never written to step_ended any more.
  const verifyEventPayload =
    input.verifyOutput !== undefined && input.verifyOutput !== null
      ? {
          stepName: 'code',
          workflowInstanceId: `upsert-${input.taskId}`,
          outcome: 'success' as const,
          durationMs: 0,
          verifyOutput:
            input.verifyOutput.length > 64 * 1024
              ? input.verifyOutput.slice(0, 64 * 1024)
              : input.verifyOutput,
        }
      : null

  if (conversationStmt === null && verifyEventPayload === null) return

  // The transcript row and its step_ended event share one write transaction:
  // a failure partway through (e.g. a constraint violation on the transcript
  // write) rolls back both, so no orphan event row can ever describe a
  // transcript write that never landed.
  if (store) {
    await store.atomic(async (scope) => {
      if (conversationStmt) await scope.execute(conversationStmt)
      if (verifyEventPayload) {
        await emitEvent(null, 'step_ended', verifyEventPayload, {
          tx: scope,
          taskId: input.taskId,
          phase: 'code',
        })
      }
    })
    return
  }

  await ensureQueueSchema()
  const client = resolveQueueClient()
  await withWriteTx(client, async (tx) => {
    if (conversationStmt) await tx.execute(conversationStmt)
    if (verifyEventPayload) {
      await emitEvent(client, 'step_ended', verifyEventPayload, {
        tx,
        taskId: input.taskId,
        phase: 'code',
      })
    }
  })
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
    // Branch deleted or git error — `revListCount` answers null, which we
    // treat as already merged (0 ahead).
    const aheadCount =
      (await resolveVcs().revListCount({
        cwd: repoRoot,
        range: `${integration}..${taskBranch}`,
      })) ?? 0
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
): Promise<void> => Arc.reopenTerminalTask(id, reason, store)

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
): Promise<{ id: string; verifyCmd: string | null }> => Arc.setVerifyCmd(id, verifyCmd)

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
  return Arc.load('reflect').insertReflection(corpusSize)
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
  // guard and builds the atomic INSERT+DELETE batch.
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
