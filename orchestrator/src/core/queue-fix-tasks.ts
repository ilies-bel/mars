import {
  deriveReproCommand,
  buildVerifyReproHint,
  type RanVerifyStep,
} from './lib/derive-repro-command'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { type FixRecipeContext, hasRecipe } from './lib/fix-recipes'
import { type ActionQueueKind, raiseActionQueueItem } from './lib/action-queue'
import { truncateFailure } from './lib/truncate-failure'
import { internalBus } from '../internal-bus'
import { getTask, reopenTerminalTask, updateTask, type Task } from './queue'
import {
  getRetryBudget,
  markTaskFailed,
  raiseRecoveryExhaustedActionQueue,
} from './queue-retry'
import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from './store/task-store'
import {
  isVerdictSuppressed,
  recordGateVerdict,
} from './lib/gate-meta-monitor'
import {
  Arc,
  type UpsertFixTaskInput,
  type UpsertFixTaskResult,
  type AttachToExistingFixTaskInput,
} from './arc'
import {
  composeRecoveryFailureReason,
  isRecoveryFailedReason,
  stripRecoveryFailedPrefixes,
} from './lib/failure-signature'
import { isEnvironmentalSignature } from './lib/failure-kinds'
import { classifyFailure } from './lib/failure-class'
import { maybeSpawnRescueOperator } from './rescue-operator-spawn'
import { recordStewardIntervention } from './steward-ledger'
import { raiseStewardRepeatActionQueueItem, shouldStewardFire } from './steward-guard'

/**
 * Maximum number of times a task can be auto-restarted for an environmental
 * failure signature (worktree pruned, timeout, etc.) before the failure falls
 * through to the normal terminal/recovery path. Kept small so a genuinely
 * broken environment doesn't loop forever — three attempts is enough to
 * survive a daemon restart that catches tasks mid-flight.
 */
export const MAX_ENV_RESTART_ATTEMPTS = 3

// Recovery-spawn types live on the Arc aggregate (ADR-0052); re-exported here
// so existing callers and tests keep importing them from queue-fix-tasks.
export type {
  UpsertFixTaskInput,
  UpsertFixTaskResult,
  AttachToExistingFixTaskInput,
} from './arc'

export const RECOVERY_FAILED_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'
export const UNKNOWN_FAILURE_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'
export const FIX_FAIL_LOOP_ACTION_QUEUE_KIND: ActionQueueKind = 'failed'

/**
 * A recovery runs in its origin's existing worktree, so a recorded branch and
 * an on-disk worktree are both required before a failure can be recovered.
 */
export const hasUsableWorktree = async (
  task: Pick<Task, 'branch' | 'worktreePath'>,
): Promise<boolean> => {
  if (!task.branch?.trim() || !task.worktreePath?.trim()) return false
  try {
    await access(task.worktreePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Re-queue an origin from setup after a failure this handler decided not to
 * recover (environmental restart, phantom kill, non-code failure).
 *
 * `failed` is terminal and `updateTask` refuses to move a task out of it, so
 * the reopen has to go through the audited seam. `reopenTerminalTask` records
 * the reopen and clears status/error/failure_reason/failure_signature/
 * failure_reason_code in one transaction, but leaves `failed_phase` and any
 * caller-specific columns alone — those are written by the follow-up patch.
 *
 * The task is NOT always terminal here: when the recovery spawner routes an
 * origin that still has its worktree it reopens the row before calling this
 * handler, so the status is already `queued`. Reopening again would throw, so
 * the seam is used only from a genuinely terminal status.
 */
const requeueOrigin = async (
  taskId: string,
  reason: string,
  patch: Parameters<typeof updateTask>[1],
  s?: TaskStore,
): Promise<void> => {
  const current = await getTask(taskId, s)
  if (current !== null && current.status === 'failed') {
    await reopenTerminalTask(taskId, reason, s)
  }
  await updateTask(
    taskId,
    {
      status: 'queued',
      error: null,
      failedPhase: null,
      failureReason: null,
      failureSignature: null,
      failureReasonCode: null,
      ...patch,
    },
    s,
  )
}

/**
 * Collapse internal whitespace and truncate a title to at most `max` characters.
 * Titles are identity/display strings rendered in the chat sidebar and
 * action-queue list. Unbounded values (e.g. from a raw `failingStep` that
 * carries a multi-line error message) break grouping and the sidebar layout.
 * Four call sites in this file use this cap — do not inline.
 */
const capTitle = (s: string, max = 100): string =>
  s.replace(/\s+/g, ' ').trim().slice(0, max)

/**
 * Map a failing step to a short plain-English phrase for use in user-facing
 * titles. Raw step ids (e.g. `verify:has-diff`, `unknown`) must NOT appear in
 * titles — they belong in transcripts and the body/whyNow only.
 *
 * Uses the step family (the part before the first ':') to stay correct even
 * when the step carries a multi-line error message instead of a structured id.
 */
const stepFamilyLabel = (failingStep: string): string => {
  const colonIdx = failingStep.indexOf(':')
  const family = colonIdx === -1 ? failingStep : failingStep.slice(0, colonIdx)
  if (family === 'verify') return 'a verification check'
  if (family === 'setup') return 'environment setup'
  if (family === 'code') return 'the coder'
  if (family === 'merge') return 'the merge step'
  if (family === 'triage') return 'the triage step'
  return 'a pipeline step'
}

/**
 * A verify-gate failing step is one whose name begins with `verify:` — the
 * shape the verify primitive stamps on the failing step (`verify:<gateName>`).
 * Only these feed the gate meta-monitor: setup/code/merge failures and infra
 * kills are per-task, never gate-wide, so a fleet-wide identical verdict there
 * is not the "starved gate" signature the monitor guards against.
 */
const isVerifyGateFailingStep = (failingStep: string): boolean =>
  failingStep.startsWith('verify:')

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

const DEFAULT_MAX_NON_CODE_RETRIES = 3

/**
 * Cap on the number of non-code re-queues for a given (taskId,
 * failureSignature) pair before the task is escalated to the action queue.
 * Defaults to 3; override via `MARS_MAX_NON_CODE_RETRIES`.
 */
export const getMaxNonCodeRetries = (): number => {
  const raw = process.env.MARS_MAX_NON_CODE_RETRIES
  if (!raw) return DEFAULT_MAX_NON_CODE_RETRIES
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_NON_CODE_RETRIES
  return Math.floor(n)
}

/**
 * Count non-code re-queue attempts for a given (taskId, failureSignature)
 * pair by reading the `non_code_requeue_attempts` ledger.
 */
export const countNonCodeRetries = async (
  taskId: string,
  failureSignature: string,
  store?: TaskStore,
): Promise<number> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
    sql: `SELECT COUNT(*) AS n FROM non_code_requeue_attempts
           WHERE task_id = ?
             AND failure_signature = ?`,
    args: [taskId, failureSignature],
  })
  return Number((r.rows[0] as unknown as { n: number }).n)
}

/**
 * Append a non-code-requeue ledger row for (taskId, failureSignature).
 * Called by both the phantom-task-no-worktree branch and the generic
 * non-code-failure branch before re-queuing, so both paths share one policy.
 */
const bumpNonCodeRetries = async (
  taskId: string,
  failureSignature: string,
  store: TaskStore,
): Promise<void> => {
  await store.execute({
    sql: `INSERT INTO non_code_requeue_attempts
           (task_id, failure_signature, created_at)
           VALUES (?, ?, ?)`,
    args: [taskId, failureSignature, new Date().toISOString()],
  })
}

/**
 * Count every historical fix-task attempt for a given (sourceTaskId,
 * failureSignature) pair, regardless of the fix task's current status.
 * Used to drive the fix-fail-loop cap so failed/done/abandoned attempts
 * still count toward the cap.
 *
 * Uses the `self_heal_attempts` append-only ledger rather than the `tasks`
 * table, because `updateTask({ status: 'done' })` automatically clears the
 * `failure_signature` column on any row transitioning to 'done' (to keep
 * done rows clean of stale failure metadata). The ledger row is written in
 * the same atomic batch as the fix-task INSERT and is never mutated, so it
 * survives the fix-task lifecycle through all terminal statuses.
 */
export const countFixTaskAttempts = async (
  sourceTaskId: string,
  failureSignature: string,
  store?: TaskStore,
): Promise<number> => {
  const s = store ?? (await getDefaultTaskStore())
  const r = await s.query({
    sql: `SELECT COUNT(*) AS n FROM self_heal_attempts
           WHERE parent_task_id = ?
             AND failure_signature = ?`,
    args: [sourceTaskId, failureSignature],
  })
  return Number((r.rows[0] as unknown as { n: number }).n)
}

/**
 * Recovery-spawn write path. Thin wrapper over {@link Arc.spawnRecovery}
 * (ADR-0052): the recovery-spawn batch logic — recipe lookup, shared-flag
 * dedup, the by-construction origin → fix `task_blockers` edge (the documented
 * ADR-0040 leaf-node exemption), the `self_heal_attempts` ledger row, and the
 * atomic `task.blocked` event — now lives on the Arc aggregate. This wrapper
 * resolves the store and delegates so the exported signature stays identical
 * for existing callers and tests.
 *
 * Atomically:
 *  - INSERT a new runnable fix-task row (status='queued', skip triage),
 *  - INSERT a task_blockers row linking the source task to the fix task,
 *  - UPDATE the source task to status='blocked' with retry_count incremented.
 *
 * Idempotent on (sourceTaskId, failureSignature): if a fix task is already
 * outstanding for that pair, the existing task is reused.
 *
 * Caller must guarantee a recipe exists for `input.failureSignature` —
 * `Arc.spawnRecovery` will throw if it doesn't. Use `hasRecipe(signature)`
 * before calling.
 */
export const upsertFixTask = async (
  input: UpsertFixTaskInput,
): Promise<UpsertFixTaskResult> => {
  const store = input.store ?? (await getDefaultTaskStore())
  return Arc.load(input.sourceTaskId, store).spawnRecovery(input)
}

/**
 * Slice F.2: attach a new blocked source to an EXISTING recovery (fix) task
 * without spawning a fresh recovery row. Thin wrapper over
 * {@link Arc.attachToRecovery} (ADR-0052) — the F.2 attach batch logic lives
 * on the Arc aggregate; this wrapper resolves the store and delegates so the
 * exported signature stays identical for `main-dirty.ts` and its tests.
 *
 * Background. `spawnRecovery` is the canonical origin → recovery edge writer
 * and is the documented exemption from F.1's ADR-0040 leaf-node guard (every
 * other `task_blockers` writer goes through `assertNotRecoveryEdge`). When
 * dirty-main dedup determines that a queued / in-flight / failed
 * `main-commiter` already exists for the current diff hash, we still need
 * a `task_blockers` edge (origin → existing recovery) — but we MUST NOT
 * re-create the recovery row. This helper bypasses the guard by writing the
 * edge through the same chokepoint the spawn path uses, then re-parks the
 * source.
 *
 * No-op when the source is already blocked on this exact recovery
 * (`ON CONFLICT DO NOTHING` on the edge).
 */
export const attachToExistingFixTask = async (
  input: AttachToExistingFixTaskInput,
): Promise<void> => {
  const store = input.store ?? (await getDefaultTaskStore())
  return Arc.load(input.sourceTaskId, store).attachToRecovery(input)
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
  /**
   * Optional QA note from `mars release --abort <id> --note '<text>'`.
   * When present, it is appended verbatim to the fix-task prompt under a
   * `## QA note` heading so the recovery agent sees the operator's
   * feedback without querying the database.
   */
  qaNote?: string
}

export interface HandleTaskFailureViaTaskResult {
  outcome:
    | 'blocked'
    | 'failed'
    | 'escalated'
    | 'fix-fail-loop'
    | 'gate-suppressed'
    | 'noop'
    | 'non-code-retry-exhausted'
    | 'requeued'
    | 'signature-storm-tripped'
    | 'steward-repeat'
  fixTaskId?: string
  failureSignature?: string
  retryCount?: number
  actionQueueItemId?: string
  attempts?: number
  /** Streak count when the signature-storm circuit breaker first trips. */
  stormStreak?: number
}

/**
 * Failure-handler entrypoint. Terminal outcomes:
 *
 *  - `blocked`: original task → blocked, recovery fix-task enqueued for the
 *     computed signature. Uses the registered recipe when one exists,
 *     otherwise a generic first-principles recovery prompt — every
 *     regular-task failure spawns a fix, even with no recipe (ADR:
 *     uniform failure→fix spawn, supersedes ADR-0002).
 *  - `escalated`: the failing task is itself a recovery (fix_for_task_id
 *     set). Recovery has a retry budget of 0; we mark it failed and
 *     raise a `recovery-failed` actionQueue item for human attention.
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

  // Duplicate-event dedup (ADR-0061 incident: task mars-c37f2cbb, 2026-07-19).
  // A second task.failed for the SAME origin while its recovery (fix task) is
  // still in-flight is a stale/duplicate signal. Do NOT burn the recovery slot
  // or raise a false recovery-exhausted alert.
  //
  // "Outstanding" = any non-terminal status: queued, running, verifying,
  // merging, vega-reconciling, draft, blocked. Terminal statuses (done, failed,
  // dropped) mean the recovery already ran — a subsequent task.failed is a
  // legitimate re-failure and the exhaustion check below applies.
  //
  // We check `fix_for_task_id` rather than the origin's status because the
  // origin may still be `blocked` after the fix task reaches a terminal status
  // (if `unblockByCompletion` fires asynchronously). Querying the fix task's
  // status directly is the most robust discriminant.
  const outstandingFixResult = await s.query({
    sql: `SELECT id FROM tasks
           WHERE fix_for_task_id = ?
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           LIMIT 1`,
    args: [input.taskId],
  })
  if (outstandingFixResult.rows.length > 0) {
    // Recovery already in-flight — this task.failed is a duplicate of the
    // ongoing episode. The existing fix task will unblock the origin when it
    // completes; no action needed here.
    return { outcome: 'noop' }
  }

  // Configuration-failure fast path: steps named `preflight:*` are operator-
  // configuration errors (e.g. no verify gates registered for the changed
  // files), NOT code defects. A fix-task cannot resolve them — the agent has
  // no way to add verify-gate entries. Mark failed, raise an operator-notice,
  // and return without spawning a recovery.
  if (input.failingStep.startsWith('preflight:')) {
    const configFailureSignature = `config-failure:${input.failingStep}`
    await updateTask(
      input.taskId,
      {
        status: 'failed',
        error: input.errorOutput,
        failedPhase: 'verify',
        failureReason: configFailureSignature,
        failureSignature: configFailureSignature,
        failureReasonCode: configFailureSignature,
      },
      s,
    )
    await raiseActionQueueItem({
      kind: UNKNOWN_FAILURE_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: capTitle(`Configure verify gates for task ${input.taskId}`),
      body: [
        `Task ${input.taskId} failed at ${input.failingStep}.`,
        '',
        'This is a configuration failure — the verify manifest has no gates for the files this task changed.',
        'Steps to fix:',
        '  1. Run `mars verify-gate check` to see which files lack gate coverage.',
        '  2. Run `mars verify-gate add` to register a gate for the affected paths.',
        `  3. \`mars restart ${input.taskId}\` once gate configuration is in place.`,
        '',
        input.errorOutput,
      ].join('\n'),
      payload: { taskId: input.taskId, failingStep: input.failingStep },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: 'agent:fail-fix-handler',
      signature: `${input.taskId}:${input.failingStep}`,
      originTaskId: task.originId,
      occurrence: {
        at: new Date().toISOString(),
        taskId: input.taskId,
        failingStep: input.failingStep,
      },
    })
    return {
      outcome: 'failed',
      failureSignature: configFailureSignature,
      retryCount: task.retryCount,
    }
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
  // recovery. See ADR 0002. Recovery failures still participate in the
  // signature-storm monitor: a run of identical recovery failures is exactly
  // the systemic incident the breaker is meant to stop from flooding the
  // action queue.
  if (task.fixForTaskId !== null) {
    // ── Escalate-once gate (ADR-0040) ────────────────────────────────────────
    // A recovery Chore is a leaf: its failure is escalated EXACTLY once and the
    // row is terminal from that moment. Re-entry is not hypothetical — the
    // durable recovery-spawner drain re-drives already-terminal rows every 30 s
    // (each escalation writes `status='failed'` again, which emits a fresh
    // `task.failed` carrying the composed reason, which the next drain feeds
    // straight back in). Without this gate every pass re-prefixed the reason,
    // re-raised the escalation row, re-recorded a storm verdict and re-spawned
    // the rescue operator. `failed` + an already-stamped `recovery_failed:`
    // reason IS the "already escalated" fact, so no counter is needed.
    if (task.status === 'failed' && isRecoveryFailedReason(task.failureReason)) {
      return {
        outcome: 'escalated',
        failureSignature,
        retryCount: task.retryCount,
      }
    }
    // Never nest the prefix: `truncatedError` may itself be a previously
    // composed reason (the `task.failed` event carries `error`, which used to
    // hold the composed string), so strip before composing.
    const capturedError = stripRecoveryFailedPrefixes(truncatedError)
    const recoveryFailureReason = composeRecoveryFailureReason(
      failureSignature,
      capturedError,
    )
    await updateTask(input.taskId, {
      status: 'failed',
      // `error` holds CAPTURED PROCESS OUTPUT and must never be overwritten
      // with a derived status string. Writing the composed reason here erased
      // the real failure output (observed: ~3 KB of vitest output replaced by
      // 542 chars of `recovery_failed:` padding), and `collectStormContext`
      // reads the tail of this column to brief the storm Steward — so the
      // Steward was handed nothing but padding. The derived string belongs in
      // `failure_reason` alone.
      error: capturedError,
      failureReason: recoveryFailureReason,
      failureSignature,
      failureReasonCode: failureSignature,
    }, s)

    try {
      const { recordFailureSignature } = await import('./lib/signature-storm-monitor')
      const stormResult = await recordFailureSignature(s, input.taskId, failureSignature)
      if (stormResult.tripped && !stormResult.alreadyTripped) {
        return {
          outcome: 'signature-storm-tripped',
          failureSignature,
          retryCount: task.retryCount,
          stormStreak: stormResult.streak,
        }
      }
      if (stormResult.tripped) {
        return {
          outcome: 'escalated',
          failureSignature,
          retryCount: task.retryCount,
        }
      }
    } catch (stormErr) {
      // eslint-disable-next-line no-console
      console.error(
        `[signature-storm] recovery task ${input.taskId} streak tracking errored (non-fatal):`,
        stormErr,
      )
    }

    const originId = task.originId
    const actionQueueSignature = `${originId}:${failureSignature}`
    const actionQueueItemId = await raiseActionQueueItem({
      kind: RECOVERY_FAILED_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: capTitle(`Fix and retry ${input.taskId}, or abandon ${originId}: recovery failed during ${stepFamilyLabel(input.failingStep)}`),
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

    // A recovery whose origin worktree was absent at setup has no recoverable
    // code state. It must end at the action queue rather than spawning another
    // operator task that would investigate the same structural dead end.
    if (!failureSignature.startsWith('setup:origin-worktree-missing/')) {
      // Arc dead-end: the recovery Chore itself failed — spawn a rescue-operator
      // agent to investigate and recover the arc. Best-effort: a rescue spawn
      // error must not block the escalation from completing.
      try {
        await maybeSpawnRescueOperator({ failedTask: task, failureSignature, store: s })
      } catch (rescueErr) {
        // eslint-disable-next-line no-console
        console.error('[rescue-operator] spawn failed (non-fatal):', rescueErr)
      }
    }

    return {
      outcome: 'escalated',
      failureSignature,
      retryCount: task.retryCount,
      actionQueueItemId,
    }
  }

  // NOTE: the "no usable worktree" escalation does NOT belong here. It gates
  // the recovery SPAWN only, and lives immediately before `upsertFixTask`
  // below. Placing it at the top of the origin path made every non-spawning
  // route unreachable — environmental auto-restart (ADR-0080), gate
  // suppression, phantom-kill re-queue and the non-code re-queue all fire
  // precisely when the origin has no worktree, and all of them re-queue from
  // setup rather than attaching to one. See the comment at the moved gate.

  // Environmental auto-restart (ADR-0080). Reached only for NON-recovery origin
  // tasks (the fixForTaskId branch above returned). When the failure signature is
  // classified as environmental in the failure-kinds registry
  // (`staticEncodable.reason === 'environmental'`), the failure is an
  // infrastructure condition (worktree pruned, timeout, API transient), NOT a
  // code regression. Spawning a recovery fix-task would burn the origin's one
  // recovery slot on a doomed repair. Instead, requeue the origin from setup.
  //
  // The `envRestartCount` counter gates an infinite-restart loop: once it
  // reaches MAX_ENV_RESTART_ATTEMPTS, fall through to the normal terminal path
  // so the origin eventually gets a human-visible action-queue item.
  // `retryCount` is intentionally NOT incremented so the origin's recovery
  // budget is fully intact if a genuine failure follows.
  if (isEnvironmentalSignature(failureSignature)) {
    if (task.envRestartCount < MAX_ENV_RESTART_ATTEMPTS) {
      const nextEnvRestartCount = task.envRestartCount + 1
      await requeueOrigin(
        input.taskId,
        `environmental restart #${nextEnvRestartCount} (${failureSignature})`,
        { envRestartCount: nextEnvRestartCount },
        s,
      )
      // eslint-disable-next-line no-console
      console.log(
        `[failure-handler] task ${input.taskId}: environmental restart #${nextEnvRestartCount}/${MAX_ENV_RESTART_ATTEMPTS} (${failureSignature})`,
      )
      return { outcome: 'requeued', retryCount: task.retryCount, failureSignature }
    }
    // Cap reached: fall through to the normal terminal path so the operator
    // gets an action-queue item. The storm circuit breaker is still skipped
    // below — N tasks each cycling through their env-restart cap is one
    // infrastructure incident, not N gate failures. A low-priority notice is
    // raised in place of a storm trip.
  }

  // Verify-gate meta-monitor (draft proposal acd01d23). Reached only for a
  // NON-recovery origin task (the recovery branch above returned). A verify-gate
  // failure is one whose failing step begins with `verify:` — the shape the
  // verify primitive stamps. Feed its verdict (the computed failureSignature) to
  // the monitor, then suppress recovery when the same verdict has failed K
  // consecutive DIFFERENT tasks.
  //
  // Suppression short-circuits BEFORE any fix-task insertion, so a suppressed
  // failure consumes ZERO of the origin's one recovery slot: the origin is
  // marked `failed` (restartable — an operator `mars restart`s it once the gate
  // is fixed) rather than `blocked` behind a spawned-and-doomed recovery. The
  // one-recovery-per-origin invariant (ADR-0040/0061) is untouched: this is
  // failure classification, not a retry knob. Recording is best-effort — a
  // monitor DB hiccup must never break the real recovery path.
  //
  // Environmental verify-gate failures are excluded: worktree-missing and
  // similar conditions are infrastructure incidents, not broken-gate evidence.
  if (isVerifyGateFailingStep(input.failingStep) && !isEnvironmentalSignature(failureSignature)) {
    try {
      await recordGateVerdict(s, input.taskId, failureSignature)
      if (await isVerdictSuppressed(s, failureSignature)) {
        await updateTask(
          input.taskId,
          {
            status: 'failed',
            error: truncatedError,
            failedPhase: 'verify',
            failureReason: `gate-suppressed:${failureSignature}`,
            failureSignature,
            failureReasonCode: failureSignature,
          },
          s,
        )
        return {
          outcome: 'gate-suppressed',
          failureSignature,
          retryCount: task.retryCount,
        }
      }
    } catch (monitorErr) {
      // eslint-disable-next-line no-console
      console.error(
        `[gate-meta-monitor] task ${input.taskId} verdict tracking errored (non-fatal):`,
        monitorErr,
      )
    }
  }

  // Gate-enrichment observation (PRD 745f33e0). Reached only for a NON-recovery
  // origin failure that is not gate-suppressed (both branches return above), so
  // a broken-gate storm never mints candidates. Signature-keyed idempotency:
  // a claimed signature (any status) only bumps seen_count; a new ENCODABLE
  // signature claims a candidate row, spawns ONE detached Writer-tagged draft
  // task, and raises ONE approval action-queue row; a new NON-encodable
  // signature is recorded as such (enumerable gap) and produces NO check.
  //
  // The enforced gate is never touched from here. Approval (human, via the
  // action queue per ADR-0048) only reaches SHADOW mode, and burn-in gates
  // enforcement — the completeness-gate incident (gate d9237119, 2026-07-03)
  // failed 100% of tasks identically from its first live minute and, because
  // verify gates run from daemon code, blocked its OWN fix from merging.
  // Best-effort: an enrichment hiccup must never break the recovery path.
  try {
    const { observeFailureForEnrichment } = await import(
      './lib/gate-enrichment'
    )
    await observeFailureForEnrichment({
      db: s,
      signature: failureSignature,
      failingStep: input.failingStep,
      originTaskId: input.taskId,
      errorOutput: input.errorOutput,
      ranVerifySteps: input.ranVerifySteps,
      worktreePath: task.worktreePath,
    })
  } catch (enrichErr) {
    // eslint-disable-next-line no-console
    console.error(
      `[gate-enrichment] task ${input.taskId} enrichment observation errored (non-fatal):`,
      enrichErr,
    )
  }

  // Signature-storm circuit breaker (all gates). Counts consecutive identical
  // failure signatures across DIFFERENT origin tasks (any gate — setup, code,
  // verify, merge, …). When SIGNATURE_STORM_TRIP_THRESHOLD consecutive tasks
  // fail with the same signature, dispatch pauses and spawns a
  // steward to diagnose/fix the systemic cause (e.g. disk full). Triggered
  // only for non-recovery, non-cancelled, non-diagnose origin tasks (the
  // guards above already returned for those cases).
  //
  // Environmental signatures are EXCLUDED from the circuit breaker. A gate is
  // not "broken" when the environment moved underneath it — N tasks hitting a
  // daemon restart is one infrastructure incident, not N gate failures. The
  // queue must not be paused for a condition the operator declared restartable.
  // Trade-off: a genuinely broken gate that happens to emit an environmental-
  // classified signature won't pause the queue. The env-incident notice raised
  // here keeps that gap visible without halting dispatch.
  //
  // Best-effort: a DB hiccup must never break the real recovery path.
  if (isEnvironmentalSignature(failureSignature)) {
    // Raise a single low-priority operational notice so the operator is aware
    // that environmental failures are occurring without triggering a pause.
    // The stable signature deduplicates across multiple tasks hitting the same
    // environmental condition, bumping seen_count on the existing row.
    try {
      await raiseActionQueueItem({
        kind: 'env-incident',
        category: 'daemon',
        priority: 'low',
        title: capTitle(`Environmental failure cap reached: ${failureSignature}`),
        body:
          `Task ${input.taskId} exceeded its environmental auto-restart cap (${MAX_ENV_RESTART_ATTEMPTS}) ` +
          `for signature '${failureSignature}'. This is an infrastructure condition ` +
          `(e.g. worktree pruned, timeout, transient outage) — the queue is NOT paused. ` +
          `\n\nRestart the task once the environment is healthy: \`mars restart ${input.taskId}\`.`,
        payload: { taskId: input.taskId, signature: failureSignature, envRestartCount: task.envRestartCount },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'daemon:failure-handler',
        // Stable per failure-signature so repeat tasks from the SAME env incident
        // bump seen_count on one row rather than creating per-task siblings.
        signature: `env-incident:${failureSignature}`,
        occurrence: {
          at: new Date().toISOString(),
          taskId: input.taskId,
          failureSignature,
        },
      })
    } catch {
      // Non-fatal: notice failure must not break the recovery path.
    }
  } else {
    try {
      const { recordFailureSignature } = await import('./lib/signature-storm-monitor')
      const stormResult = await recordFailureSignature(s, input.taskId, failureSignature)
      if (stormResult.tripped && !stormResult.alreadyTripped) {
        // First trip: action-queue row was raised inside recordFailureSignature.
        // Mark the task failed (restartable) and signal the daemon-side caller
        // to pause dispatch and spawn the steward. No recovery fix-task is
        // spawned — the storm indicates a systemic failure, not a per-task bug.
        const stepPrefix = input.failingStep.includes(':')
          ? input.failingStep.split(':')[0]
          : input.failingStep
        // FailedPhase is 'code' | 'verify' | 'merge' — map step prefix to it
        // or leave null for gates not in the union (e.g. setup).
        const failedPhase =
          stepPrefix === 'code' || stepPrefix === 'verify' || stepPrefix === 'merge'
            ? (stepPrefix as 'code' | 'verify' | 'merge')
            : null
        await updateTask(
          input.taskId,
          {
            status: 'failed',
            error: truncatedError,
            failedPhase,
            failureReason: `signature-storm:${failureSignature}`,
            failureSignature,
            failureReasonCode: failureSignature,
          },
          s,
        )
        return {
          outcome: 'signature-storm-tripped',
          failureSignature,
          retryCount: task.retryCount,
          stormStreak: stormResult.streak,
        }
      }
    } catch (stormErr) {
      // eslint-disable-next-line no-console
      console.error(
        `[signature-storm] task ${input.taskId} streak tracking errored (non-fatal):`,
        stormErr,
      )
    }
  }

  const budget = getRetryBudget()

  // ── Pre-classify BEFORE the retryCount gate (Slice 3 PRD d7835017) ────────
  // Non-code failures (orchestration, infra, connectivity) must bypass the
  // `retryCount > budget` gate so the code recovery slot is never burned on
  // a failure that code edits cannot fix. Classify first, apply the budget
  // gate only to code failures below.
  const failureCategory = classifyFailure(failureSignature)

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
  // No early-out for a missing recipe. Every regular-task failure spawns a
  // fix, even when the signature has no purpose-built recipe (ADR: uniform
  // failure→fix spawn, supersedes ADR-0002). The recovery-spawn path resolves
  // the signature via `getRecipeOrGeneric`, which falls back to a generic,
  // first-principles recovery prompt — so an unrecognized signature recovers
  // instead of dead-ending with an "unknown signature" action-queue row that
  // stranded the worktree. Recovery (fix) failures are still escalated, not
  // re-recovered (see the `task.fixForTaskId !== null` branch above).

  // ── Phantom-kill-with-no-worktree routing (ADR-0061, updated Slice 3 PRD d7835017) ─
  // A task killed by the phantom watchdog before setup ran has no branch or
  // worktree for a worktree-scoped fix task to operate on — that fix is dead
  // on arrival and burns the origin's one recovery slot for a failure that a
  // plain re-queue solves. Detect by the watchdog's `failureReason` prefix AND
  // the absence of both branch and worktree (both are null before setup runs).
  //
  // Routing: re-queue the origin from setup using the non-code retry counter so
  // the code recovery slot is preserved. After MAX_NON_CODE_RETRIES consecutive
  // phantom kills the task is escalated to the action queue instead of looping.
  if (
    task.failureReason?.startsWith('phantom-task watchdog:') &&
    !task.worktreePath &&
    !task.branch
  ) {
    await bumpNonCodeRetries(input.taskId, failureSignature, s)
    const nonCodeCount = await countNonCodeRetries(input.taskId, failureSignature, s)
    const nonCodeCap = getMaxNonCodeRetries()
    if (nonCodeCount > nonCodeCap) {
      const failureReason = `non-code-retry-exhausted:${failureSignature}`
      await markTaskFailed(input.taskId, failureReason)
      await raiseActionQueueItem({
        kind: UNKNOWN_FAILURE_ACTION_QUEUE_KIND,
        category: 'orchestrator',
        priority: 'high',
        title: `Non-code retry cap reached for ${input.taskId}: ${failureSignature}`,
        body: `Task ${input.taskId} has been re-queued ${nonCodeCount} time(s) for a non-code failure (${failureSignature}) — the cap of ${nonCodeCap} is reached. The code recovery slot was NOT consumed. Resolve the underlying infra/orchestration condition and restart the task.`,
        payload: { taskId: input.taskId, failureSignature, nonCodeCount, cap: nonCodeCap },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'agent:fail-fix-handler',
        signature: `non-code-retry-exhausted:${input.taskId}:${failureSignature}`,
        originTaskId: task.originId,
        occurrence: { at: new Date().toISOString(), taskId: input.taskId, failureSignature, nonCodeCount },
      })
      return { outcome: 'non-code-retry-exhausted', failureSignature, retryCount: task.retryCount }
    }
    await requeueOrigin(
      input.taskId,
      `phantom-kill non-code re-queue #${nonCodeCount}/${nonCodeCap} (${failureSignature})`,
      {},
      s,
    )
    // eslint-disable-next-line no-console
    console.log(
      `[failure-handler] task ${input.taskId}: phantom-kill non-code re-queue #${nonCodeCount}/${nonCodeCap} (${failureSignature})`,
    )
    return { outcome: 'requeued', retryCount: task.retryCount, failureSignature }
  }

  // ── Non-code failure re-queue ─────────────────────────────────────────────
  // When the failure signature is classified as non-code (connectivity,
  // orchestration, or infra), spawning a recovery fix-task is wasteful: the
  // fix task cannot resolve the issue by editing code and would burn the one
  // recovery slot on a doomed repair. Re-queue the origin from setup instead.
  // Uses the per-(taskId, failureSignature) non-code retry counter so the code
  // recovery slot is preserved regardless of how many non-code re-queues occur.
  // After MAX_NON_CODE_RETRIES re-queues the task is escalated to the action queue.
  if (failureCategory !== 'code') {
    await bumpNonCodeRetries(input.taskId, failureSignature, s)
    const nonCodeCount = await countNonCodeRetries(input.taskId, failureSignature, s)
    const nonCodeCap = getMaxNonCodeRetries()
    if (nonCodeCount > nonCodeCap) {
      const failureReason = `non-code-retry-exhausted:${failureSignature}`
      await markTaskFailed(input.taskId, failureReason)
      await raiseActionQueueItem({
        kind: UNKNOWN_FAILURE_ACTION_QUEUE_KIND,
        category: 'orchestrator',
        priority: 'high',
        title: `Non-code retry cap reached for ${input.taskId}: ${failureSignature}`,
        body: `Task ${input.taskId} has been re-queued ${nonCodeCount} time(s) for a non-code failure (${failureSignature}) — the cap of ${nonCodeCap} is reached. The code recovery slot was NOT consumed. Resolve the underlying infra/orchestration condition and restart the task.`,
        payload: { taskId: input.taskId, failureSignature, nonCodeCount, cap: nonCodeCap },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'agent:fail-fix-handler',
        signature: `non-code-retry-exhausted:${input.taskId}:${failureSignature}`,
        originTaskId: task.originId,
        occurrence: { at: new Date().toISOString(), taskId: input.taskId, failureSignature, nonCodeCount },
      })
      return { outcome: 'non-code-retry-exhausted', failureSignature, retryCount: task.retryCount }
    }
    await requeueOrigin(
      input.taskId,
      `non-code re-queue #${nonCodeCount}/${nonCodeCap} (${failureCategory}:${failureSignature})`,
      {},
      s,
    )
    // eslint-disable-next-line no-console
    console.log(
      `[failure-handler] task ${input.taskId}: non-code failure (${failureCategory}:${failureSignature}) re-queue #${nonCodeCount}/${nonCodeCap} — no recovery slot consumed`,
    )
    return { outcome: 'requeued', retryCount: task.retryCount, failureSignature }
  }

  // ── Code-failure budget gate (Slice 3 PRD d7835017) ──────────────────────
  // Applied ONLY after non-code paths (phantom-kill and classify) have been
  // excluded. Non-code failures bypass this entirely so they can use the
  // self_heal_attempts counter without burning the one-shot code-recovery slot.
  if (task.retryCount > budget) {
    // Guard: do not double-prepend if failureSignature somehow already carries
    // the prefix (defence-in-depth; the primary fix is in computeFailureSignature).
    await markTaskFailed(
      input.taskId,
      failureSignature.startsWith('recovery_exhausted:')
        ? failureSignature
        : `recovery_exhausted:${failureSignature}`,
    )
    await raiseRecoveryExhaustedActionQueue({
      taskId: input.taskId,
      lastStep: input.failingStep,
      retryCount: task.retryCount,
      lastErrorSignature: failureSignature,
      lastErrorSummary: truncatedError,
      branch,
      worktreePath: task.worktreePath,
    })
    import('./lib/failure-reflector').then(({ spawnFailureReflector }) =>
      spawnFailureReflector({
        taskId: input.taskId,
        lastStep: input.failingStep,
        lastErrorSignature: failureSignature,
        retryCount: task.retryCount,
        worktreePath: task.worktreePath,
        branch,
      }).catch((err) =>
        // eslint-disable-next-line no-console
        console.warn('[failure-reflector] spawn failed (non-fatal):', err),
      ),
    )
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
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
    // event would be spurious. Arc.setTaskStatus('blocked') satisfies the
    // single-writer invariant; the no-mapping path skips the publish.
    await Arc.setTaskStatus(input.taskId, 'blocked')

    const actionQueueItemId = await raiseActionQueueItem({
      kind: FIX_FAIL_LOOP_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: capTitle(`Diagnose and retry, or abandon ${input.taskId}: fix-fail loop on ${failureSignature}`),
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

    import('./lib/failure-reflector').then(({ spawnFailureReflector }) =>
      spawnFailureReflector({
        taskId: input.taskId,
        lastStep: input.failingStep,
        lastErrorSignature: failureSignature,
        retryCount: task.retryCount,
        worktreePath: task.worktreePath,
        branch,
      }).catch((err) =>
        // eslint-disable-next-line no-console
        console.warn('[failure-reflector] spawn failed (non-fatal):', err),
      ),
    )

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

  // ── No usable worktree → escalate instead of spawning a doomed recovery ───
  // A recovery Chore runs INSIDE its origin's worktree, so an origin that
  // failed before setup ran (branch and worktreePath both unrecorded), or whose
  // worktree has since been pruned, cannot host one: the recovery would die at
  // `setup:origin-worktree-missing` and burn the origin's single recovery slot
  // (ADR-0040) for nothing. Escalate to the operator and leave the slot intact.
  //
  // ORDERING IS LOAD-BEARING: this gate must stay BELOW every route that does
  // not spawn a recovery — environmental auto-restart, gate suppression, the
  // phantom-kill re-queue and the non-code re-queue. Those paths re-queue the
  // origin from setup, which needs no pre-existing worktree, and the phantom
  // and environmental branches are entered *because* the worktree is absent.
  // Hoisting this check above them makes them dead code and converts work that
  // should be retried into terminal failures.
  if (task.status === 'failed' && !(await hasUsableWorktree(task))) {
    const actionQueueItemId = await raiseActionQueueItem({
      kind: UNKNOWN_FAILURE_ACTION_QUEUE_KIND,
      category: 'orchestrator',
      priority: 'high',
      title: capTitle(`Task ${input.taskId} failed before it had a usable worktree`),
      body: [
        `Task ${input.taskId} failed at ${input.failingStep} before the orchestrator recorded a usable worktree and branch.`,
        '',
        'No recovery task was created because recoveries run in the origin worktree and would fail during setup.',
        `Resolve the original failure, then restart the task: \`mars restart ${input.taskId}\`.`,
        '',
        'Last error output (tail-truncated):',
        '```',
        truncatedError,
        '```',
      ].join('\n'),
      payload: {
        taskId: input.taskId,
        originTaskId: task.originId,
        failingStep: input.failingStep,
        failureSignature,
        branch: task.branch,
        worktreePath: task.worktreePath,
      },
      context: { repoRoot: process.env.MARS_REPO ?? null },
      raisedBy: 'agent:fail-fix-handler',
      signature: `origin-worktree-missing:${task.originId}`,
      originTaskId: task.originId,
      occurrence: {
        at: new Date().toISOString(),
        taskId: input.taskId,
        failingStep: input.failingStep,
      },
    })
    return {
      outcome: 'failed',
      failureSignature,
      retryCount: task.retryCount,
      actionQueueItemId,
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

  const stewardTarget = {
    kind: 'task',
    id: input.taskId,
    version: failureSignature,
  }
  const stewardDecision = await shouldStewardFire(stewardTarget)
  if (!stewardDecision.fire) {
    const actionQueueItemId = await raiseStewardRepeatActionQueueItem(
      stewardTarget,
      stewardDecision.reason,
    )
    return {
      outcome: 'steward-repeat',
      failureSignature,
      retryCount: task.retryCount,
      actionQueueItemId,
    }
  }

  const result = await upsertFixTask({
    sourceTaskId: input.taskId,
    failureSignature,
    failingStep: input.failingStep,
    truncatedError,
    branch,
    recipeContext,
    store: s,
    qaNote: input.qaNote,
  })
  await recordStewardIntervention({
    targetKind: 'task',
    targetId: input.taskId,
    targetVersion: failureSignature,
    recipeId: failureSignature,
    rationale: `Recovery ${result.created ? 'created' : 'reused'} after ${input.failingStep}.`,
    outcome: result.created ? 'recovery-created' : 'recovery-reused',
  })

  // No registered fix recipe → the Arc has no targeted recovery playbook; spawn
  // a rescue-operator agent in parallel with the generic fix task so the arc
  // does not dead-end silently. Recipe-backed failures (hasRecipe = true) have
  // a known playbook and must NOT trigger a rescue on their first attempt.
  // Best-effort: a rescue spawn error must not block the blocked outcome.
  if (!hasRecipe(failureSignature)) {
    try {
      await maybeSpawnRescueOperator({ failedTask: task, failureSignature, store: s })
    } catch (rescueErr) {
      // eslint-disable-next-line no-console
      console.error('[rescue-operator] spawn failed (non-fatal):', rescueErr)
    }
  }

  return {
    outcome: 'blocked',
    fixTaskId: result.fixTaskId,
    failureSignature,
    retryCount: task.retryCount + 1,
  }
}
