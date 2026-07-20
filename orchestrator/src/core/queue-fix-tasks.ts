import {
  deriveReproCommand,
  buildVerifyReproHint,
  type RanVerifyStep,
} from './lib/derive-repro-command'
import { type FixRecipeContext } from './lib/fix-recipes'
import { type ActionQueueKind, raiseActionQueueItem } from './lib/action-queue'
import { truncateFailure } from './lib/truncate-failure'
import { internalBus } from '../internal-bus'
import { getTask, updateTask, type Task } from './queue'
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
}

export interface HandleTaskFailureViaTaskResult {
  outcome:
    | 'blocked'
    | 'failed'
    | 'escalated'
    | 'fix-fail-loop'
    | 'gate-suppressed'
    | 'noop'
    | 'requeued'
  fixTaskId?: string
  failureSignature?: string
  retryCount?: number
  actionQueueItemId?: string
  attempts?: number
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
    // Guard: do not double-prepend if failureSignature somehow already carries
    // the prefix (defence-in-depth against any future path that re-enters here
    // with a pre-composed reason string).
    const recoveryFailureReason = failureSignature.startsWith('recovery_failed:')
      ? `${failureSignature}: ${truncatedError.slice(0, 500)}`
      : `recovery_failed:${failureSignature}: ${truncatedError.slice(0, 500)}`
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
  if (isVerifyGateFailingStep(input.failingStep)) {
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

  const budget = getRetryBudget()

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
  // No early-out for a missing recipe. Every regular-task failure spawns a
  // fix, even when the signature has no purpose-built recipe (ADR: uniform
  // failure→fix spawn, supersedes ADR-0002). The recovery-spawn path resolves
  // the signature via `getRecipeOrGeneric`, which falls back to a generic,
  // first-principles recovery prompt — so an unrecognized signature recovers
  // instead of dead-ending with an "unknown signature" action-queue row that
  // stranded the worktree. Recovery (fix) failures are still escalated, not
  // re-recovered (see the `task.fixForTaskId !== null` branch above).

  // ── Phantom-kill-with-no-worktree routing (ADR-0061) ─────────────────────
  // A task killed by the phantom watchdog before setup ran has no branch or
  // worktree for a worktree-scoped fix task to operate on — that fix is dead
  // on arrival and burns the origin's one recovery slot for a failure that a
  // plain re-queue solves. Detect by the watchdog's `failureReason` prefix AND
  // the absence of both branch and worktree (both are null before setup runs).
  //
  // Routing: re-queue the origin from setup on a fresh worker instead of
  // spawning a fix task. This IS the recovery — retryCount++ consumes the
  // slot. A second phantom kill reaches this point with retryCount already
  // incremented, so the budget-exhaustion guard above fires first and
  // escalates to the action queue without falling through here.
  if (
    task.failureReason?.startsWith('phantom-task watchdog:') &&
    !task.worktreePath &&
    !task.branch
  ) {
    const nextRetryCount = task.retryCount + 1
    await updateTask(
      input.taskId,
      {
        status: 'queued',
        error: null,
        failedPhase: null,
        failureSignature: null,
        failureReasonCode: null,
        retryCount: nextRetryCount,
      },
      s,
    )
    return { outcome: 'requeued', retryCount: nextRetryCount, failureSignature }
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
