import { randomUUID } from 'node:crypto'
import {
  deriveReproCommand,
  buildVerifyReproHint,
  type RanVerifyStep,
} from './lib/derive-repro-command'
import {
  getRecipe,
  hasRecipe,
  type FixRecipeContext,
} from './lib/fix-recipes'
import { type ActionQueueKind, raiseActionQueueItem } from './lib/action-queue'
import { truncateFailure } from './lib/truncate-failure'
import { internalBus } from '../internal-bus'
import { buildEventInsert } from './lib/outbox'
import {
  getTask,
  MAX_PRIORITY,
  setTaskStatus,
  updateTask,
  type Task,
} from './queue'
import {
  getRetryBudget,
  markTaskFailed,
  raiseRetryBudgetExhaustedActionQueue,
} from './queue-retry'
import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from './store/task-store'

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const FIX_TASK_AUTHOR_KIND = 'agent'
const FIX_TASK_AUTHOR_NAME = 'fail-fix-handler'

export const RECOVERY_FAILED_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'
export const UNKNOWN_FAILURE_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'
export const FIX_FAIL_LOOP_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'

const DEFAULT_MAX_FIX_ATTEMPTS = 2

/**
 * Cap on the number of fix-task rows we'll ever insert for a single
 * (sourceTaskId, failureSignature) pair. Once the cap is hit, the next
 * dispatch escalates to the actionQueue instead of looping. The rule is
 * signature-agnostic — no hardcoded signature strings.
 */
export const getMaxFixAttempts = (): number => {
  const raw = process.env.MARS_MAX_FIX_ATTEMPTS
  if (!raw) return DEFAULT_MAX_FIX_ATTEMPTS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_FIX_ATTEMPTS
  return Math.floor(n)
}

/**
 * Count every historical fix-task row for a given (sourceTaskId,
 * failureSignature) pair, regardless of status. Used to drive the
 * fix-fail-loop cap so failed/done/abandoned attempts still count.
 *
 * Stays schema-free — relies only on `fix_for_task_id` and
 * `failure_signature` columns that already exist on `tasks`.
 */
export const countFixTaskAttempts = async (
  sourceTaskId: string,
  failureSignature: string,
  store?: TaskStore,
): Promise<number> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
    sql: `SELECT COUNT(*) AS n FROM tasks
           WHERE fix_for_task_id = ?
             AND failure_signature = ?`,
    args: [sourceTaskId, failureSignature],
  })
  return Number((r.rows[0] as unknown as { n: number }).n)
}

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
  store?: TaskStore
}

export interface UpsertFixTaskResult {
  fixTaskId: string
  created: boolean
}

const findExistingFixTask = async (
  sourceTaskId: string,
  failureSignature: string,
  store?: TaskStore,
): Promise<string | null> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
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
const findSharedFixTask = async (
  failureSignature: string,
  store?: TaskStore,
): Promise<string | null> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
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
 * Atomically:
 *  - INSERT a new runnable fix-task row (status='queued', skip triage),
 *  - INSERT a task_blockers row linking the source task to the fix task,
 *  - UPDATE the source task to status='blocked' with retry_count incremented.
 *
 * Idempotent on (sourceTaskId, failureSignature): if a fix task is already
 * outstanding for that pair, the existing task is reused.
 *
 * Caller must guarantee a recipe exists for `input.failureSignature` —
 * `upsertFixTask` will throw if it doesn't. Use `hasRecipe(signature)`
 * before calling.
 */
export const upsertFixTask = async (
  input: UpsertFixTaskInput,
): Promise<UpsertFixTaskResult> => {
  const s = input.store ?? (await getDefaultTaskStore())

  const recipe = getRecipe(input.failureSignature)
  const shared = recipe.shared === true

  // Shared recipes (e.g. dirty merge target) reuse a single in-flight
  // fix-task across every source task that hits the signature. New
  // sources just attach a task_blockers edge — one commit unblocks
  // every dependent at once via onBlockerTaskCompleted.
  const existingId = shared
    ? await findSharedFixTask(input.failureSignature, s)
    : await findExistingFixTask(input.sourceTaskId, input.failureSignature, s)

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
        }),
      ],
      'write',
    )
    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId: existingId,
      failureSignature: input.failureSignature,
      failingStep: input.failingStep,
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
        sql: `INSERT INTO tasks (
              id, prompt, status,
              author_kind, author_name,
              fix_for_task_id, failure_signature,
              retry_count, origin_id, priority,
              created_at, updated_at
            ) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
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
      }),
    ],
    'write',
  )

  internalBus().emit('task.blocked', {
    taskId: input.sourceTaskId,
    fixTaskId,
    failureSignature: input.failureSignature,
    failingStep: input.failingStep,
  })

  return { fixTaskId, created: true }
}

/**
 * Slice F.2: attach a new blocked source to an EXISTING recovery (fix) task
 * without spawning a fresh recovery row.
 *
 * Background. `upsertFixTask` is the canonical origin → recovery edge writer
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
 * `upsertFixTask` minus the fix-task INSERT (and minus the
 * `self_heal_attempts` ledger row, since the cap counts attempt-by-row and
 * we are not adding a new attempt — we are joining an existing one).
 *
 * No-op when the source is already blocked on this exact recovery
 * (`INSERT OR IGNORE` on the edge).
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
  store?: TaskStore
}

export const attachToExistingFixTask = async (
  input: AttachToExistingFixTaskInput,
): Promise<void> => {
  const s = input.store ?? (await getDefaultTaskStore())
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
        // the legitimate origin → recovery edge writer (`upsertFixTask`) is
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
      }),
    ],
    'write',
  )
  internalBus().emit('task.blocked', {
    taskId: input.sourceTaskId,
    fixTaskId: input.fixTaskId,
    failureSignature: input.failureReasonCode ?? 'verify:main-dirty',
    failingStep: 'dispatch:main-dirty',
  })
}

const buildRecoveryEscalationBody = (input: {
  recoveryTaskId: string
  originTaskId: string
  failingStep: string
  failureSignature: string
  branch: string | null
  worktreePath: string | null
  claudeSessionId: string | null
  truncatedError: string
}): string => {
  return [
    `Recovery task ${input.recoveryTaskId} failed and the orchestrator will not retry it (recovery budget is 0 by design — see ADR 0002). Task ${input.originTaskId} stays 'blocked' until resolved.`,
    '',
    'Context:',
    `  Failing step: ${input.failingStep}`,
    `  Failure signature: ${input.failureSignature}`,
    input.branch ? `  Branch: ${input.branch}` : null,
    input.worktreePath ? `  Worktree: ${input.worktreePath}` : null,
    input.claudeSessionId ? `  Claude session: ${input.claudeSessionId}` : null,
    '',
    'Last error output (tail-truncated):',
    '```',
    input.truncatedError,
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

const buildUnknownFailureBody = (input: {
  sourceTaskId: string
  failingStep: string
  failureSignature: string
  branch: string | null
  truncatedError: string
}): string => {
  return [
    `Task ${input.sourceTaskId} failed with a signature that has no registered recovery recipe, so the orchestrator did not auto-recover it.`,
    '',
    'Context:',
    `  Failing step: ${input.failingStep}`,
    `  Failure signature: ${input.failureSignature}`,
    input.branch ? `  Branch: ${input.branch}` : null,
    '',
    'Last error output (tail-truncated):',
    '```',
    input.truncatedError,
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

const buildFixFailLoopBody = (input: {
  sourceTaskId: string
  originTaskId: string
  failingStep: string
  failureSignature: string
  branch: string | null
  truncatedError: string
  attempts: number
  cap: number
}): string => {
  return [
    `Task ${input.sourceTaskId} (origin ${input.originTaskId}) hit the fix-fail retry cap of ${input.cap} for signature \`${input.failureSignature}\` after ${input.attempts} attempt(s). The orchestrator has stopped auto-retrying this pair. Task ${input.sourceTaskId} stays 'blocked' until resolved.`,
    '',
    'Context:',
    `  Failing step: ${input.failingStep}`,
    `  Failure signature: ${input.failureSignature}`,
    input.branch ? `  Branch: ${input.branch}` : null,
    `  Prior fix-task attempts: ${input.attempts}`,
    `  Cap (MARS_MAX_FIX_ATTEMPTS): ${input.cap}`,
    '',
    'Last error output (tail-truncated):',
    '```',
    input.truncatedError,
    '```',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

export interface HandleTaskFailureViaTaskInput {
  taskId: string
  failingStep: string
  errorOutput: string
  branch?: string | null
  /**
   * Optional structured context for recipes that need it (e.g. the
   * `merge:preflight/uncommitted-changes` recipe wants `statusOutput`).
   * If omitted, an empty context is synthesized — recipes that ignore
   * those fields work either way.
   */
  recipeContext?: FixRecipeContext
  /**
   * All verify steps that actually ran for this task, in order, carrying
   * their exact commands and directories. When present, the reproduce
   * command is derived from these records via {@link buildVerifyReproHint}
   * rather than the hardcoded JavaScript-specific mapping in
   * {@link deriveReproCommand}. Pass this from the verify step so
   * multi-language and full-stack failures produce accurate repro hints.
   */
  ranVerifySteps?: readonly RanVerifyStep[]
  /**
   * TaskStore threaded in from the workflow composition root. When
   * provided, getTask and updateTask calls inside this handler route
   * through the store rather than going through the module-singleton client.
   */
  store?: TaskStore
}

export interface HandleTaskFailureViaTaskResult {
  outcome:
    | 'blocked'
    | 'failed'
    | 'escalated'
    | 'fix-fail-loop'
    | 'no-recipe'
    | 'noop'
  fixTaskId?: string
  failureSignature?: string
  retryCount?: number
  actionQueueItemId?: string
  attempts?: number
}

/**
 * Failure-handler entrypoint. Terminal outcomes:
 *
 *  - `blocked`: original task → blocked, recovery fix-task enqueued from
 *     the registered recipe for the computed signature.
 *  - `escalated`: the failing task is itself a recovery (fix_for_task_id
 *     set). Recovery has a retry budget of 0; we mark it failed and
 *     raise a `recovery-failed` actionQueue item for human attention.
 *  - `no-recipe`: signature has no recipe registered. Original task →
 *     failed and a trace-only actionQueue item is raised. The orchestrator does
 *     NOT auto-diagnose; the operator triggers a one-shot diagnostic agent
 *     from the actionQueue card (the `diagnose-failure` action).
 *  - `fix-fail-loop`: (sourceTaskId, failureSignature) pair has already
 *     burned its fix-task attempts cap (`MARS_MAX_FIX_ATTEMPTS`, default
 *     2). No new fix task is inserted; a deduped `fix-fail-loop` actionQueue
 *     item is raised and the source task stays in `blocked` with its
 *     existing error summary.
 *
 * Plus `failed` when the legacy retry budget for the original task is
 * exhausted, and `noop` when the task row vanished.
 */
export const CANCELLED_FAILURE_REASON = 'cancelled'

export const handleTaskFailureWithFixTask = async (
  input: HandleTaskFailureViaTaskInput,
): Promise<HandleTaskFailureViaTaskResult> => {
  const s = input.store ?? (await getDefaultTaskStore())
  const task: Task | null = await getTask(input.taskId, s)
  if (!task) return { outcome: 'noop' }

  // PRD slice 2/4 (mars-9234e1b2): cancellation gate. When the
  // stop-task RPC (slice 1) marks a task failed with
  // failure_reason='cancelled', self-heal must NOT spawn a fix-task —
  // the user explicitly killed it. Skip regardless of how this handler
  // was reached (workflow exitCode-137 path, in-flight abort, or any
  // later call site). Centralised here so every call site honours the
  // gate without auditing five workflow branches.
  if (task.failureReason === CANCELLED_FAILURE_REASON) {
    // eslint-disable-next-line no-console
    console.log(
      `[failure-handler] task ${input.taskId} failure is cancelled-by-user, skipping fix-task spawn`,
    )
    return { outcome: 'noop' }
  }

  const { computeFailureSignature } = await import('./lib/failure-signature')

  // Diagnose Chores are terminal: a failing diagnose Chore must never
  // spawn a fix task or investigator — that would re-introduce the
  // unbounded recursion the Chore was created to break. Mark it failed
  // directly; the daemon's failure callback (slice 6) raises the operator
  // actionQueue item for explicit resolution.
  if (task.kind === 'diagnose') {
    const failureSignature = computeFailureSignature(
      input.failingStep,
      input.errorOutput,
    )
    await markTaskFailed(
      input.taskId,
      `diagnose_chore_failed:${failureSignature}`,
    )
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  // Re-use the already-imported computeFailureSignature below.
  const failureSignature = computeFailureSignature(
    input.failingStep,
    input.errorOutput,
  )
  const truncatedError = truncateFailure(input.errorOutput)
  const branch = input.branch ?? task.branch
  const reproCommand =
    input.ranVerifySteps && input.ranVerifySteps.length > 0
      ? buildVerifyReproHint(input.ranVerifySteps)
      : deriveReproCommand(input.failingStep, task.worktreePath)

  // Kill-switch: when MARS_RECOVERY_DISABLED=1, never spawn fix-tasks or
  // Investigators. Mark the failing task failed and stop. Recovery (fix-
  // tasks already in flight) is escalated to actionQueue as usual so a partial
  // disable doesn't leave them silently dangling.
  if (process.env.MARS_RECOVERY_DISABLED === '1' && task.fixForTaskId === null) {
    await markTaskFailed(
      input.taskId,
      `recovery_disabled:${failureSignature}: ${truncatedError.slice(0, 500)}`,
    )
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  // Recovery (fix-task) failures escalate to actionQueue; never spawn another
  // recovery. See ADR 0002 — this is the rule that broke the cascade.
  if (task.fixForTaskId !== null) {
    const recoveryFailureReason = `recovery_failed:${failureSignature}: ${truncatedError.slice(0, 500)}`
    await updateTask(input.taskId, {
      status: 'failed',
      error: recoveryFailureReason,
      failureReason: recoveryFailureReason,
      failureSignature,
      failureReasonCode: failureSignature,
    }, s)

    const originId = task.originId
    const actionQueueSignature = `${originId}:${failureSignature}`
    const actionQueueItemId = await raiseActionQueueItem({
      kind: RECOVERY_FAILED_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: `Fix and retry ${input.taskId}, or abandon ${originId}: recovery failed at ${input.failingStep}`,
      body: buildRecoveryEscalationBody({
        recoveryTaskId: input.taskId,
        originTaskId: originId,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        worktreePath: task.worktreePath,
        claudeSessionId: task.claudeSessionId,
        truncatedError,
      }),
      payload: {
        recoveryTaskId: input.taskId,
        originTaskId: originId,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        worktreePath: task.worktreePath,
        claudeSessionId: task.claudeSessionId,
      },
      context: {
        repoRoot: process.env.MARS_REPO ?? null,
      },
      raisedBy: 'agent:fail-fix-handler',
      signature: actionQueueSignature,
      // Collapse all failure-kinds for the same origin into one row.
      originTaskId: originId,
      occurrence: {
        at: new Date().toISOString(),
        recoveryTaskId: input.taskId,
        failingStep: input.failingStep,
      },
    })

    return {
      outcome: 'escalated',
      failureSignature,
      retryCount: task.retryCount,
      actionQueueItemId,
    }
  }

  const budget = getRetryBudget()

  if (task.retryCount > budget) {
    await markTaskFailed(
      input.taskId,
      `retry_budget_exhausted:${failureSignature}`,
    )
    await raiseRetryBudgetExhaustedActionQueue({
      taskId: input.taskId,
      lastStep: input.failingStep,
      retryCount: task.retryCount,
      lastErrorSignature: failureSignature,
      lastErrorSummary: truncatedError,
      branch,
      worktreePath: task.worktreePath,
    })
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
    }
  }

  // FUTURE: unrelated-flake short-circuit goes here, BEFORE the recipe
  // lookup. When `input.failingStep === 'verify:test-failed'`, compare
  // the failing test file paths against `task.spec?.files`; if there is
  // zero overlap AND the same tests already fail on integrationBranch,
  // park the source in a new `'flake-blocked'` status, raise an actionQueue
  // item, and return without enqueueing a fix-task. Dependencies (file
  // separately, then wire here):
  //   - parser for failing test paths (proposal 5710b256)
  //   - 'flake-blocked' TaskStatus + plumbing (proposal abfca8d8)
  //   - integration-branch re-run helper (proposal b4da8c0e)
  //   - structured failure-context plumbing on this entrypoint
  //     (proposal adee06a6) — must extend HandleTaskFailureViaTaskInput
  //     with spec.files + pre-computed integration re-run results,
  //     since classifyError today only sees errorOutput.
  // No recipe for this signature — do NOT fall back to a generic prompt
  // (that's what produced the cascade) and do NOT auto-diagnose. Mark the
  // source 'failed' and raise a trace-only actionQueue item. The operator decides
  // whether to diagnose (the card's `diagnose-failure` action spawns a
  // one-shot Sonnet agent), restart, or purge.
  if (!hasRecipe(failureSignature)) {
    const now = new Date().toISOString()
    const noRecipeReason = truncate(
      `${input.failingStep}: ${truncatedError}`,
      1000,
    )
    await updateTask(
      input.taskId,
      {
        status: 'failed',
        error: noRecipeReason,
        failureReason: noRecipeReason,
        failureSignature,
        failureReasonCode: failureSignature,
      },
      s,
    )

    const actionQueueItemId = await raiseActionQueueItem({
      kind: UNKNOWN_FAILURE_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${task.id} failed: unknown signature ${failureSignature}`,
      body: buildUnknownFailureBody({
        sourceTaskId: task.id,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        truncatedError,
      }),
      payload: {
        taskId: task.id,
        originTaskId: task.originId,
        failingStep: input.failingStep,
        failureSignature,
        branch,
      },
      context: {
        repoRoot: process.env.MARS_REPO ?? null,
      },
      raisedBy: 'agent:fail-fix-handler',
      // Dedup on signature so a flapping signature collapses to one row.
      signature: failureSignature,
      originTaskId: task.originId,
      occurrence: {
        at: now,
        sourceTaskId: task.id,
        failingStep: input.failingStep,
      },
    })
    return {
      outcome: 'no-recipe',
      failureSignature,
      retryCount: task.retryCount + 1,
      actionQueueItemId,
    }
  }

  // Fix-fail-loop cap. Count every historical fix-task row for this
  // (sourceTaskId, failureSignature) pair regardless of status. When
  // the cap is hit, stop inserting new fix tasks and escalate to the
  // actionQueue; repeat escalations dedupe on (kind, signature) fingerprint
  // and bump seenCount on the existing row. Source task stays in
  // 'blocked' with its existing error summary — never silently flipped
  // back to 'queued'.
  const cap = getMaxFixAttempts()
  const priorAttempts = await countFixTaskAttempts(
    input.taskId,
    failureSignature,
    s,
  )
  if (priorAttempts >= cap) {
    // AUDIT (mars-88a4e657): safe site for the "blocked-implies-edge"
    // invariant. We re-stamp 'blocked' here AFTER `priorAttempts >= cap`,
    // which means at least one earlier `upsertFixTask` call already
    // inserted a `task_blockers` edge for this (sourceTaskId, signature)
    // pair in the same transaction that first blocked the task. The edge
    // survives until explicitly cleared by `mars unblock`, so this branch
    // re-stamps a status the row already has.
    const now = new Date().toISOString()
    // No durable task.blocked emit here: per the AUDIT note above this
    // re-stamps a status the row already holds (no real transition), so an
    // event would be spurious. setTaskStatus('blocked') satisfies the
    // single-writer invariant; the no-mapping path skips the publish.
    await setTaskStatus(input.taskId, 'blocked')

    const actionQueueItemId = await raiseActionQueueItem({
      kind: FIX_FAIL_LOOP_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: `Diagnose and retry, or abandon ${input.taskId}: fix-fail loop on ${failureSignature}`,
      body: buildFixFailLoopBody({
        sourceTaskId: input.taskId,
        originTaskId: task.originId,
        failingStep: input.failingStep,
        failureSignature,
        branch,
        truncatedError,
        attempts: priorAttempts,
        cap,
      }),
      payload: {
        sourceTaskId: input.taskId,
        originTaskId: task.originId,
        failingStep: input.failingStep,
        failureSignature,
        attempts: priorAttempts,
        cap,
        branch,
      },
      context: {
        repoRoot: process.env.MARS_REPO ?? null,
      },
      raisedBy: 'agent:fail-fix-handler',
      // Dedup on the failure signature so repeat escalations bump
      // seenCount instead of spawning new rows. No signature string is
      // hardcoded — the value flows from the classifier.
      signature: failureSignature,
      // Collapse all failure-kinds for the same origin into one row.
      originTaskId: task.originId,
      occurrence: {
        at: now,
        sourceTaskId: input.taskId,
        failingStep: input.failingStep,
        attempts: priorAttempts,
      },
    })

    internalBus().emit('task.blocked', {
      taskId: input.taskId,
      fixTaskId: null,
      failureSignature,
      failingStep: input.failingStep,
    })

    return {
      outcome: 'fix-fail-loop',
      failureSignature,
      retryCount: task.retryCount,
      actionQueueItemId,
      attempts: priorAttempts,
    }
  }

  const baseRecipeContext: FixRecipeContext = input.recipeContext ?? {
    targetPath: task.worktreePath ?? '',
    statusOutput: truncatedError,
    targetBranch: branch ?? '',
    originalPrompt: task.prompt ?? '',
  }
  // Always populate `originalPrompt` from the loaded source task so the
  // recovery agent receives the original intent verbatim, not just the
  // incident. Default to '' only when the source genuinely has no prompt.
  const incomingOriginalPrompt = baseRecipeContext.originalPrompt
  const recipeContext: FixRecipeContext = {
    ...baseRecipeContext,
    reproCommand: baseRecipeContext.reproCommand ?? reproCommand,
    originalPrompt:
      incomingOriginalPrompt && incomingOriginalPrompt.trim().length > 0
        ? incomingOriginalPrompt
        : task.prompt ?? '',
  }

  const result = await upsertFixTask({
    sourceTaskId: input.taskId,
    failureSignature,
    failingStep: input.failingStep,
    truncatedError,
    branch,
    recipeContext,
    store: s,
  })

  return {
    outcome: 'blocked',
    fixTaskId: result.fixTaskId,
    failureSignature,
    retryCount: task.retryCount + 1,
  }
}
