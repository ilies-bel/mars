/**
 * ActionQueue view builder — derives the ActionQueueRow[] the UI renders from raw
 * persisted actionQueue rows, task data, the error-kind registry, and the recipe
 * catalog. Moved here from ui/server/index.ts so the daemon is the sole reader
 * of its own database and the single authoritative source for every derived
 * actionQueue view.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { taskDisplayTitle } from '../../lib/task-display-title'
import { DAEMON_KILLED_SIGNATURE } from '../../lib/retry-budget'
import {
  lookupFailureKind,
  unknownFailureKind,
  failingStepFromSignature,
  failedTaskTitle,
  isGenericFailureLabel,
} from '../../lib/failure-kinds'
import { shortId } from '../../lib/short-id'
import { derivedRowActions } from '../../lib/derived-row-actions'
import {
  lookupRecipe,
  getRecipeVerbs,
  type RecipeHumanDetail,
  type RecipeVerb,
  type RecipeDecision,
} from '../../lib/action-queue-recipes'
import { isActionQueueKind, classifyKind, KIND_CLASS, DERIVED_KINDS, type ActionQueueKind, type ActionQueueClass } from '../../lib/action-queue-kinds'
import { RECOVERY_EXHAUSTED_PREFIX, RECOVERY_DISABLED_PREFIX } from '../../lib/failure-signature'
import type { DispatchPauseState } from '../pause-state'

/**
 * The display kind is the persisted action-queue kind. It is deliberately not
 * collapsed into a smaller UI vocabulary: operators need to distinguish the
 * condition that raised each row.
 */
type DerivedActionQueueKind = string
export type DerivedActionQueueFilter = 'open' | 'all'

const NON_TASK_FAILURE_KINDS = new Set([
  'stale-worktree',
  'draft-proposal',
  'awaiting-validation',
  'awaiting-validation-preview-gone',
  'awaiting-human',
  'reflect-recommended',
  'workflow-draft-pending',
  'scorer-suggested',
  'tool-promotion',
  'hitl-slice-needs-operator',
  'daemon-outage',
  'health-check-alert',
  'phantom-merge',
  'phantom-merge-unknown',
  // gate-broken: the row's subject is the gate itself, not the task that last
  // tripped it. Treating it as a task-failure kind caused operatorGoal to be
  // derived from the origin task's intent and surfaced as the primary headline —
  // so a dropped task's title became the card headline even though the card
  // describes a live infrastructure condition, not a task failure.
  'gate-broken',
])

/** Preserves the former failure-specific enrichment without changing labels. */
const isTaskFailureKind = (kind: string): boolean => !NON_TASK_FAILURE_KINDS.has(kind)

/** Resolution metadata carried by resolved rows in history responses. */
interface ActionQueueResolutionMeta {
  resolvedAt: string
  resolution: string | null
  resolutionNote: string | null
  rootCause: string | null
  resolvedBy: string | null
}

interface StaleWorktreeDetail {
  prompt: string | null
  status: string
  ageHours: number
  updatedAt: string
  branch: string | null
  /** True when the worktree has no diff vs merge-base with main AND no untracked files. */
  empty: boolean
  investigation: string | null
}

export interface ActionQueueRow {
  id: string
  kind: DerivedActionQueueKind
  entityId: string
  priority: 'high' | 'normal' | 'low'
  title: string
  body: string
  at: string
  dag: {
    blockers: { id: string; status: string; summary: string }[]
    blocking: { id: string; status: string; summary: string }[]
    descendants: { id: string; status: string; summary: string }[]
    proposalId: string | null
    edges: { from: string; to: string; kind: 'blocks' | 'recovers' }[]
  } | null
  errorKind: string
  actions: { id: string; label: string; op: string; needsConfirm?: boolean; hint?: string }[]
  staleWorktreeDetail: StaleWorktreeDetail | null
  /**
   * Live preview dev-server URL for an `awaiting-validation` row (e.g.
   * `http://127.0.0.1:4321`). Null on every other row kind. The UI renders it
   * as a clickable link the operator opens before clicking Validate / Reject.
   */
  devServerUrl: string | null
  /**
   * Lease state for an `awaiting-human` row. Null on every other row kind.
   * The UI renders the owner, timestamp, and optional note so the operator
   * can see who holds the worktree and why.
   */
  leaseState: {
    leaseOwner: string
    leasedAt: string
    leaseNote: string | null
  } | null
  diagnosis: { text: string; diagnosedAt: string } | null
  /**
   * Failure-reason catalog code (`tasks.failure_reason_code` / actionQueue-row
   * payload). Null on non-failed rows and on legacy rows landed before the
   * typed code was introduced.
   */
  failureReasonCode: string | null
  /**
   * True when this task's single recovery attempt is already spent — i.e. its
   * `failure_reason` carries the `recovery_exhausted:` prefix that
   * `continue-task.ts` refuses on.
   *
   * Decided daemon-side on purpose: the prefix is written and read by the
   * orchestrator, and it lives on `failure_reason`, NOT on the similarly-named
   * `failure_reason_code`. A client re-implementing the string test picked the
   * wrong column and the check never fired.
   */
  recoveryExhausted: boolean
  /**
   * When this row represents a fix/recovery task, the id of the origin task it
   * was spawned to fix. Null/absent for origin tasks or non-task rows.
   * Drives the "Fix for: <origin>" navigable link in the UI.
   */
  fixForTaskId?: string | null
  /**
   * Resolution metadata — non-null on history rows (state='resolved'), null on
   * live open rows. The UI uses this to determine whether to render the
   * Resolution header and suppress action buttons.
   */
  resolution?: ActionQueueResolutionMeta | null
  /**
   * Benchmark evidence for a `tool-promotion` row. Null on every other row kind.
   * Carries the before/after timing stats and the arc ids that motivated the
   * helper-generation run.
   */
  toolPromotionDetail?: {
    helperKey: string
    motivatingArcIds: string[]
    before: unknown
    after: unknown
  } | null
  /**
   * One plain sentence a non-expert understands, stating what happened and
   * what Mars wants. Derived from the action-queue recipe registry.
   * Additive field — kept alongside the existing `title`/`body` until the
   * UI task performs the hard cut.
   */
  humanSummary: string
  /**
   * Structured fields for the expandable detail section. Carries the full
   * technical payload (failure signature, branch, worktree, raw error excerpt,
   * changelog for update kinds, etc.) as a typed object.
   * Additive field.
   */
  humanDetail: RecipeHumanDetail
  /**
   * Ordered action buttons derived from the recipe registry, including
   * compound ops (e.g. daemon-code-drift → Restart & update) and always
   * ending with [Dismiss, Snooze]. Additive alongside the existing `actions`
   * field — the UI task will perform the hard cut.
   */
  verbs: RecipeVerb[]
  /**
   * Server-defined decision buttons. Each entry maps to exactly one button on
   * the client (no client-side switch on failure kind required). Populated by
   * per-kind recipes; absent or empty for rows that carry only verb buttons.
   * The client falls back to `[]` when this field is absent (see
   * `zDecision.default([])` in `ui/src/shared/schemas.ts`).
   *
   * Every `style` value here MUST be accepted by the client's `zDecision.style`
   * enum (`ui/src/shared/schemas.ts`), because an unknown style fails validation
   * for the entire row, not just the button.
   */
  decisions?: {
    label: string
    endpoint: string
    payload: Record<string, unknown>
    style?: 'primary' | 'destructive' | 'default' | 'snooze'
    secondary?: {
      kind: 'teach-recipe' | 'scope-choice'
      prompt: string
    }
  }[]
  /**
   * Operator-facing goal sentence for this action-queue card — the primary
   * headline in the inverted card hierarchy (§7). For origin failed-task rows,
   * derived from the task's own `intent` (preferred) or `prompt`. For
   * recovery/fix task rows, derived from the **origin** task's intent/prompt
   * so the operator sees what was being attempted, not just that recovery
   * failed. Null on non-task-backed rows (stale-worktree, draft-proposal, etc.)
   * and when the referenced task cannot be found.
   *
   * Required (not optional): the daemon always populates this field. Callers
   * that assemble synthetic rows (e.g. the daemon-killed batch row) set it to
   * null explicitly. Consumer slices may refine the derivation algorithm but
   * must never drop the field.
   */
  arcGoal: string | null
  /**
   * Operator-facing goal sentence derived from the same resolution chain as
   * `arcGoal` but normalised differently: markdown heading markers, backtick
   * pairs, and bold markers are stripped; a leading second-person construction
   * ('You should …', 'You need to …') is rewritten to imperative; the result
   * is capped at 100 characters with ellipsis. Null on non-task-backed rows
   * and when the referenced task cannot be found.
   */
  operatorGoal: string | null
  /**
   * Human-readable title of the entity this row represents. For `slice-failed`
   * rows this is the PRD's real title (not the truncated slug id); for other
   * entity-backed rows it may be set by the kind's recipe `entityTitle`
   * accessor. Null for rows whose entity has no independent title (task-backed
   * rows surface their goal via `arcGoal`/`operatorGoal` instead).
   *
   * The UI uses this as the first candidate when naming a row in a cause-group
   * member list, ahead of parsing it back out of the body prose.
   */
  entityTitle: string | null
  /**
   * Live preview URL for an `awaiting-human` manual-QA row. Present when the
   * `review(ctx, { reviewType: 'manual' })` primitive successfully spawned a
   * preview process and that process reported a URL. Null on every other row
   * kind and when no URL was detected.
   */
  previewUrl?: string | null
  /**
   * Log file path for an `awaiting-human` manual-QA row. Present when the
   * `review(ctx, { reviewType: 'manual' })` primitive spawned a preview
   * process. Null on every other row kind.
   */
  logPath?: string | null
  /**
   * Coder stall diagnostics captured just before the hard timeout fired
   * (slice 5 of PRD d23b2704). Populated for `task-blocked` rows when the
   * failing task row carries a non-null `stall_diagnostics` blob. Null on
   * every other row kind and on legacy rows that predate the capture.
   */
  stallDiagnostics?: unknown | null
  /**
   * Live worker-pool snapshot computed at action-queue raise time (slice 6
   * of PRD d23b2704). Lets the operator answer "was the pool saturated, was
   * the provider hung, or did the coder itself die" from the first look at
   * the alert. Null on every other row kind.
   */
  poolSnapshot?: {
    activeWorkerCount: number
    queuedCount: number
    runningCount: number
    blockedCount: number
    recentDispatchDecisions: string[]
  } | null
  /**
   * Identifies the health-check condition that raised this `health-check-alert`
   * row. The Steward uses this key to find and auto-close open rows when the
   * condition is gone on the next clean pass. Null on every other row kind.
   */
  conditionKey?: string | null
  /**
   * Structural class of this item (three-class model):
   *   - `notice`   — Mars has an automated move and is taking it; asks nothing
   *                  of the operator. Raised to inform, not to request.
   *   - `alert`    — Something is wrong and the operator is needed; raised the
   *                  moment the last automated move is spent, or immediately when
   *                  there never was one.
   *   - `decision` — Nothing is wrong, but work cannot proceed until the operator
   *                  picks. Raised to gate on a human choice.
   *
   * The class is derived from {@link ACTION_QUEUE_KINDS} via {@link classifyKind}
   * and may be adjusted at render time when live context changes the obligation
   * (e.g. an automated repair exhausting its budget shifts a `notice` to `alert`).
   *
   * The UI renders a Dismiss chip ONLY when class === 'notice'.
   */
  class: ActionQueueClass
  /**
   * For Notice items: the stable identity key used for durable dismissal.
   * The raiser uses this to check `isNoticeDismissed(noticeKey)` before
   * re-raising the same logical notice.
   * Null for Condition and Decision items.
   */
  noticeKey: string | null
}

/** Raw actionQueue row shape as persisted in `action_queue_items`. */
export interface PersistedActionQueueRow {
  id: string
  kind: string
  priority: string
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedAt: number
  lastSeenAt: number
  /** The item's dedup signature, used as the entity-id fallback. */
  signature?: string | null
  /** Resolution fields — populated on resolved rows, absent/null on open rows. */
  resolvedAt?: number | null
  resolution?: string | null
  resolutionNote?: string | null
  rootCause?: string | null
  resolvedBy?: string | null
}

const formatOperationalDuration = (milliseconds: number): string => {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0
    ? `${hours} hr`
    : `${hours} hr ${remainingMinutes} min`
}

/**
 * Copy owned by operational alerts rather than a failed task's FailureKind.
 *
 * The explicit Record is intentional: a new ActionQueueKind cannot land
 * without choosing whether it needs a specialised renderer (and adding one)
 * or deliberately preserving its persisted copy. That keeps a new operational
 * alert from silently falling back to the generic task-failure message.
 *
 * Renderers may optionally return `humanSummary` — a single plain-language
 * sentence for a non-expert. When present it overrides the recipe registry's
 * computed `humanSummary`, which is derived from the kind alone without access
 * to the live pause-state or escalation context the renderer sees. Kinds whose
 * renderer returns `null` (no override) continue to use the recipe's sentence.
 *
 * Exported for the jargon-ban test (action-queue-jargon-ban.test.ts).
 */
export const OPERATIONAL_ALERT_COPY: Record<
  ActionQueueKind,
  ((row: PersistedActionQueueRow, pauseState: DispatchPauseState | null) => { title: string; body: string; humanSummary?: string }) | null
> = {
  failed: null,
  'steward-repeat': null,
  'cancelled-blocker-cascade': null,
  'diagnose-inconclusive': null,
  'daemon-killed': null,
  'coder-question': null,
  'daemon-died': (row, _pauseState) => {
    const detectedAt =
      typeof row.payload.crashDetectedAt === 'string'
        ? row.payload.crashDetectedAt
        : new Date(row.lastSeenAt).toISOString()
    const pid = typeof row.payload.pid === 'number' ? row.payload.pid : null
    const pidClause = pid !== null ? ` (pid ${pid})` : ''
    return {
      title: `The background engine${pidClause} crashed and has restarted`,
      body:
        `The crash was detected at ${detectedAt} and the engine has already respawned. ` +
        `There is no task transcript for this system-level alert. Inspect \`.mars/watch.log\` for the crash, then run \`mars list\` to find interrupted tasks.`,
    }
  },
  'daemon-outage': (row, _pauseState) => {
    const outageMs = typeof row.payload.outageMs === 'number' ? row.payload.outageMs : null
    const strandedCount =
      typeof row.payload.strandedTaskCount === 'number' ? row.payload.strandedTaskCount : null
    const detectedAt =
      typeof row.payload.detectedAt === 'string'
        ? row.payload.detectedAt
        : new Date(row.lastSeenAt).toISOString()
    const outageSummary = outageMs !== null
      ? `${formatOperationalDuration(outageMs)} outage`
      : 'an outage of unknown duration'
    const strandedNote = strandedCount !== null
      ? `${strandedCount} task(s) were queued when it came back up.`
      : 'Queued-task count unknown.'
    return {
      title: `The background engine was offline (~${outageSummary}) and restarted at ${detectedAt}`,
      body:
        `The background engine was offline for ${outageSummary}. ${strandedNote} ` +
        `Queued tasks will be dispatched automatically. Inspect \`.mars/watch.log\` ` +
        `and run \`mars list\` to review tasks that accumulated during the outage.`,
    }
  },
  'stale-worktree': null,
  'worktree-ahead': null,
  'prerequisite-failed': null,
  'draft-proposal': null,
  'slices-dropped': null,
  'slice-failed': null,
  'hitl-slice-needs-operator': null,
  'awaiting-validation': null,
  'awaiting-validation-preview-gone': null,
  'awaiting-human': null,
  'behaviour-unverified': null,
  'subscriber-stalled': (row, _pauseState) => {
    const rawSubscriber =
      typeof row.payload.subscriberId === 'string'
        ? row.payload.subscriberId
        : (row.signature?.replace(/^subscriber-stalled:/, '') ?? 'unknown subscriber')
    const pidMatch = rawSubscriber.match(/^(.*):(\d+)$/)
    const processor = pidMatch
      ? `${pidMatch[1]} (pid ${pidMatch[2]})`
      : rawSubscriber
    const stalledFor = formatOperationalDuration(
      Math.max(0, row.lastSeenAt - row.raisedAt),
    )
    return {
      title: `Processor ${processor} is stalled for ${stalledFor}`,
      body:
        `Processor ${processor} has not advanced for ${stalledFor}. There is no task transcript for this alert. ` +
        `Inspect \`.mars/watch.log\` and the processor cursor before restarting the daemon.`,
    }
  },
  'observability-store-oversize': null,
  'orphaned-origin': null,
  'phantom-task': (row, _pauseState) => {
    const taskId =
      typeof row.payload.taskId === 'string' ? row.payload.taskId : (row.signature ?? 'unknown task')
    const status =
      typeof row.payload.previousStatus === 'string' ? row.payload.previousStatus : 'running'
    const age =
      typeof row.payload.ageMinutes === 'number'
        ? `${row.payload.ageMinutes} min`
        : 'an unknown duration'
    const reason = typeof row.payload.reason === 'string' ? row.payload.reason : 'watchdog timeout'
    return {
      title: `Task ${taskId} is stuck in ${status} for ${age}`,
      body:
        `Task ${taskId} was auto-failed by the phantom-task watchdog (${reason}). ` +
        `Inspect task ${taskId} and its worktree or log, then restart it with \`mars restart ${taskId}\` when the cause is clear.`,
    }
  },
  'outbox-lag': null,
  'reflect-recommended': null,
  'done-with-unmerged-commits': null,
  'api-outage': null,
  'daemon-code-drift': null,
  'workflow-install-drift': null,
  'provider-rate-limited': null,
  'gate-broken': (row, _pauseState) => {
    const verdict =
      typeof row.payload.verdict === 'string'
        ? row.payload.verdict
        : (row.signature?.replace(/^gate-broken:/, '') ?? 'unknown verdict')
    const gate =
      typeof row.payload.gate === 'string'
        ? row.payload.gate
        : (verdict.match(/^verify:([^/]+)/)?.[1] ?? 'unknown')
    const scope = typeof row.payload.scope === 'string' ? row.payload.scope : null
    const name = typeof row.payload.name === 'string' ? row.payload.name : null
    // Prefer "scope/name" over the raw UUID — matches what `mars verify-gate list` shows.
    const identity =
      scope && name && !(scope === gate && name === gate) ? `${scope}/${name}` : gate
    const streak = typeof row.payload.streak === 'number' ? ` (${row.payload.streak} tasks)` : ''
    // Surface the origin task only when it is still active (dropped tasks are
    // excluded by the deriveGateBrokenConditions JOIN). A null originTaskId means
    // the task was purged or dropped — do not mention it.
    const originTaskId =
      typeof row.payload.originTaskId === 'string' ? row.payload.originTaskId : null
    const lastTripped = originTaskId ? ` Last tripped by ${originTaskId}.` : ''
    return {
      title: `The ${identity} check keeps failing${streak}`,
      body:
        `The ${identity} check has repeatedly produced \`${verdict}\`. Recovery is suppressed while it is broken.${lastTripped} ` +
        `Inspect \`.mars/watch.log\`, fix or disable the check, then restart the affected tasks.`,
    }
  },
  'verify-uncovered': null,
  'workflow-draft-pending': null,
  'gate-enrichment': null,
  'budget-window': null,
  'budget-arc': null,
  'scorer-suggested': null,
  'promotion-decision': null,
  'tool-promotion': null,
  'arc-verification-failed': null,
  'signature-storm': (row, pauseState) => {
    const signature =
      typeof row.payload.signature === 'string'
        ? row.payload.signature
        : (row.signature?.replace(/^signature-storm(?:-unresolved)?:/, '') ?? 'unknown signature')
    const streak = typeof row.payload.streak === 'number' ? row.payload.streak : 'multiple'
    // The escalation row shares this kind under a distinct dedup key: the
    // Steward budget for this signature is spent, so Mars has stopped pausing
    // for it. Saying "dispatch is paused" there would be a lie.
    const attempts =
      typeof row.payload.stewardAttempts === 'number' ? row.payload.stewardAttempts : null
    if (attempts !== null) {
      return {
        title: `${attempts} attempt${attempts === 1 ? '' : 's'} to fix the recurring error \`${signature}\` all failed — Mars has stopped auto-pausing for it`,
        body:
          `The same error keeps recurring and every automated fix attempt produced no resolution. Mars will not pause task processing for this pattern again — cycling ` +
          `pause and retry against a root cause the automated system cannot reach only wastes worktrees. Tasks keep ` +
          `running and keep failing until the shared cause is fixed. Inspect \`.mars/watch.log\` and the ` +
          `\`steward_ledger\` rows for target '${signature}'.`,
        // Overrides the recipe's generic "N tasks failed with the same error …" sentence:
        // the Steward budget is spent and Mars is no longer handling this automatically,
        // so the operator is now on the hook — that context belongs in the summary.
        humanSummary:
          `${attempts} automatic fix attempt${attempts === 1 ? '' : 's'} all failed for the recurring error "${signature}" — Mars will no longer pause task processing automatically. Fix the root cause manually to stop the failures.`,
      }
    }
    // Derive the "task processing is paused" clause from current state, not the
    // frozen instant the breaker tripped. The action queue is a pure
    // projection: a row that was raised while the storm breaker was armed
    // must not keep claiming task processing is paused once the breaker clears.
    const dispatchPausedByStorm =
      pauseState !== null && pauseState.paused && pauseState.reason === 'storm'
    if (dispatchPausedByStorm) {
      return {
        title: `${streak} tasks failed with \`${signature}\` — Mars has paused new work`,
        body:
          `The same error keeps recurring across tasks, so Mars has paused starting new work. ` +
          `There is no single task transcript for this incident. New tasks will resume as soon as the automated monitor reports ` +
          `an outcome (fix, no-op, or failure), or on the bounded crash/hang fallback. ` +
          `Inspect \`.mars/watch.log\`, correct the shared cause, then inspect \`mars operator\` before resuming.`,
        humanSummary: `Mars detected ${streak} tasks failing with \`${signature}\` — Mars has paused new work while it monitors, no action needed from you.`,
      }
    }
    return {
      title: `${streak} tasks failed with \`${signature}\``,
      body:
        `The same error kept recurring across tasks. Mars has since resumed starting new tasks. ` +
        `There is no single task transcript for this incident. ` +
        `Inspect \`.mars/watch.log\` and correct the shared cause to prevent future occurrences.`,
      humanSummary: `Mars detected ${streak} tasks failing with \`${signature}\` — Mars has since resumed starting new tasks, no action needed from you.`,
    }
  },
  'signature-wave': (row, _pauseState) => {
    const count =
      typeof row.payload.caughtTaskCount === 'number' ? row.payload.caughtTaskCount : 'multiple'
    const sig =
      typeof row.payload.signature === 'string' ? row.payload.signature : 'an unknown pattern'
    const ids =
      Array.isArray(row.payload.caughtTaskIds)
        ? (row.payload.caughtTaskIds as string[]).join(', ')
        : ''
    return {
      title: `${count} tasks failed for the same reason — one fix likely unblocks all`,
      body: [
        `${count} tasks all failed with the same failure pattern. This is the shape of an`,
        `environmental or systemic failure, not a per-task regression.`,
        ``,
        `Shared failure pattern: ${sig}`,
        ...(ids ? [`Affected tasks (${count}): ${ids}`] : []),
        ``,
        `Fix the root cause, then \`mars continue\` or \`mars restart\` each affected task.`,
      ].join('\n'),
    }
  },
  'gate-enrichment-stale': null,
  'env-incident': null,
  'stale-queued': (row, _pauseState) => {
    const taskId =
      typeof row.payload.taskId === 'string' ? row.payload.taskId : (row.signature ?? 'unknown task')
    const age =
      typeof row.payload.queuedAgeMs === 'number'
        ? formatOperationalDuration(row.payload.queuedAgeMs)
        : 'an unknown duration'
    return {
      title: `${taskId} has been queued for ${age} and hasn't started yet`,
      body:
        `Task ${taskId} is still queued after ${age}; inspect it with \`mars list\` and check \`.mars/watch.log\` for dispatcher decisions. ` +
        `No task transcript exists until a worker picks it up.`,
    }
  },
  'stale-queued-summary': (row, _pauseState) => {
    const suppressed =
      typeof row.payload.suppressedCount === 'number' ? row.payload.suppressedCount : 'Additional'
    const queueDepth = typeof row.payload.queueDepth === 'number' ? ` Queue depth is ${row.payload.queueDepth}.` : ''
    return {
      title: `${suppressed} queued tasks were suppressed from the alert list`,
      body:
        `The watchdog limited this sweep to individual alerts for the oldest tasks.${queueDepth} ` +
        `Run \`mars action-queue list open --kind stale-queued\` to see the surfaced tasks; there is no transcript for this aggregate alert.`,
    }
  },
  'spend-control-notice': null,
  'scheduling-decision': null,
  'requeue-warning': null,
  'arc-superseded-on-main': null,
  'e2e-tooling-missing': null,
  'low-disk-space': (row, _pauseState) => {
    const freeMiB =
      typeof row.payload['freeBytes'] === 'number'
        ? Math.round((row.payload['freeBytes'] as number) / (1024 * 1024))
        : '?'
    // The disk guard refuses individual dispatches, not the whole queue —
    // no PauseController is involved, so no "task processing is paused" clause.
    return {
      title: `Running low on disk space (${freeMiB} MiB left) — new tasks won't start until space is freed`,
      body: row.body,
    }
  },
  'dirty-integration': null,
  'health-check-alert': null,
  'baseline-broken': (row, pauseState) => {
    const gateName =
      typeof row.payload.failingGateName === 'string'
        ? row.payload.failingGateName
        : 'unknown gate'
    const caughtTaskCount =
      typeof row.payload.caughtTaskCount === 'number' ? row.payload.caughtTaskCount : 0
    const caughtSuffix =
      caughtTaskCount > 0
        ? ` — caught ${caughtTaskCount} task failure${caughtTaskCount === 1 ? '' : 's'} that would otherwise look unrelated`
        : ''
    // Emit the task-processing-paused clause only when the live pause reason is 'baseline'.
    // First-cause-wins means a check failing while task processing is already paused for
    // 'operator' or 'quota' must not claim credit for that pause.
    const dispatchPausedByBaseline =
      pauseState !== null && pauseState.paused && pauseState.reason === 'baseline'
    const pauseSuffix = dispatchPausedByBaseline
      ? ' — Mars has stopped starting new tasks until it is fixed'
      : ''
    return {
      title: `A check is failing on the main branch "${gateName}"${caughtSuffix}${pauseSuffix}`,
      body: typeof row.payload.output === 'string' ? row.payload.output : '',
      humanSummary: dispatchPausedByBaseline
        ? `A check is failing on the main branch "${gateName}"${caughtSuffix} — Mars has stopped starting new tasks until it is fixed.`
        : undefined,
    }
  },
  'fragmented-repo-layout': (row) => {
    const workspace =
      typeof row.payload.workspace === 'string' ? row.payload.workspace : 'a workspace'
    return {
      title: `Fragmented repo layout detected in ${workspace}`,
      body: `The node_modules virtual store for ${workspace} escaped the checkout boundary. A fix task has been enqueued to reinstall dependencies in the correct location.`,
    }
  },
  'recovery-abandoned': null,
  'mockup-ready': null,
  'qa-step-list-opt-in': null,
  'qa-step-list-promote': null,
  'phantom-merge': null,
  'phantom-merge-unknown': null,
  'worktree-hook-trust-request': null,
  // Transport failures during slicing: one provider-level alert instead of per-PRD.
  // The recipe humanSummary is accurate; no override needed.
  'slicer-transport-outage': null,
}

const renderOperationalAlertCopy = (
  row: PersistedActionQueueRow,
  pauseState: DispatchPauseState | null,
): { title: string; body: string; humanSummary?: string } | null =>
  isActionQueueKind(row.kind) ? OPERATIONAL_ALERT_COPY[row.kind]?.(row, pauseState) ?? null : null

/** Narrow task shape `buildActionQueueView` needs — a subset of the queue Task. */
export interface TaskForActionQueue {
  id: string
  status: string
  prompt: string
  /** Full list of task ids that block this task (from task_blockers). */
  blockedBy: string[]
  /** The proposal this task was sliced from, or null. */
  parentProposalId: string | null
  failureSignature: string | null
  /**
   * First line of captured stderr/stdout from the failing step, used as the
   * `verboseReason` hint in `unknownFailureKind` when the signature is not
   * registered. Null on legacy tasks or when no output was captured.
   */
  lastErrorOutput?: string | null
  branch: string | null
  updatedAt: string
  /**
   * When this task is a fix/recovery task, the id of the origin task it was
   * spawned to fix. Null for origin tasks. Drives arc-keyed DAG rendering:
   * origin rows carry the fix task in `dag.descendants`; fix rows carry this
   * id in `fixForTaskId` so the UI can link back.
   */
  fixForTaskId?: string | null
  /**
   * Human-readable intent label for this task, as stored in `tasks.intent`.
   * Empty string when not set. Used by `deriveArcGoal` to produce a legible
   * headline instead of truncating the raw prompt.
   */
  intent?: string
  /**
   * The id of the task this task supersedes, as stored in `tasks.origin_id`.
   * Self-referencing on origin tasks (originId === id). Null when no lineage
   * is recorded. Used by `deriveArcGoal` to follow supersede lineage.
   */
  originId?: string | null
  /**
   * Live lease owner for an 'awaiting-human' task. Preferred over the
   * action-queue payload snapshot because the task row is always current.
   */
  leaseOwner?: string | null
  /** ISO timestamp when the current lease was acquired. */
  leasedAt?: string | null
  /** Optional human note attached to the lease. */
  leaseNote?: string | null
  /**
   * Raw `failure_reason` from the task row. Used by the `recovery-abandoned`
   * enrichment pass to gate `continuable` on the same condition that
   * `continue-task.ts` enforces at the command level: the prefix
   * `recovery_exhausted:` (or `recovery_disabled:`) means `mars continue`
   * would reject the task — suppress the verb.
   * Optional: absent on legacy stored rows that pre-date this field; the
   * enrichment treats absence as no-prefix-match (safe default).
   */
  failureReason?: string | null
  /**
   * Absolute path to this task's worktree. Used by the `recovery-abandoned`
   * enrichment pass: a missing worktree means `mars continue` would have
   * nothing to resume on, so `continuable` must be false.
   * Optional for the same backwards-compat reason as `failureReason`.
   */
  worktreePath?: string | null
}

/**
 * Source of synthetic action-queue rows derived from live system state.
 *
 * Condition kinds (signature-storm, gate-broken, baseline-broken, daemon-died,
 * daemon-code-drift, subscriber-stalled, steward-repeat) are pure functions of
 * state the system already holds. They are computed on read instead of being
 * stored so stale alerts become unrepresentable.
 *
 * Each call should derive only items for kinds in `opts.kinds` when that set
 * is non-empty (as an efficiency hint); `buildActionQueueView` also applies
 * the filter itself as a safety net.
 */
export interface ConditionItemsSource {
  derive(opts: { kinds?: ReadonlySet<string> }): Promise<PersistedActionQueueRow[]>
}

/**
 * State-store dependency: reads open actionQueue items.
 * In the daemon this is backed by the in-process actionQueue module;
 * in tests it can be stubbed.
 */
export interface ActionQueueStateStore {
  listOpenActionQueueItems(): Promise<PersistedActionQueueRow[]>
  /** Cursor-paged resolved rows, newest-first. Used by the history view. */
  listResolvedActionQueueItems(opts: {
    limit?: number
    cursor?: string | null
  }): Promise<{ items: PersistedActionQueueRow[]; nextCursor: string | null }>
}

/**
 * Task-store dependency: returns tasks with blocker and proposal info.
 * The daemon builds this from queue.ts + a task_blockers query.
 */
export interface ActionQueueTaskStore {
  /** Loads only the task graph required by the supplied visible queue rows. */
  listTasksForActionQueueItems(
    rows: readonly PersistedActionQueueRow[],
  ): Promise<TaskForActionQueue[]>
}

/**
 * Store for checking whether a set of proposal IDs are currently in `draft`
 * status. Used to guard `draft-proposal` action-queue rows whose proposalId
 * points at a proposal that is no longer actionable (e.g. already dismissed).
 *
 * Injected as an optional dep so tests that do not need proposal-status
 * checking can omit it (the guard degrades to proposalId-presence-only).
 */
export interface ProposalStatusStore {
  /**
   * Returns the subset of the given IDs whose proposal exists AND is in
   * `draft` status. IDs for absent proposals or proposals in any other status
   * are excluded from the returned set.
   */
  getDraftProposalIds(ids: readonly string[]): Promise<ReadonlySet<string>>
}

export interface BuildActionQueueViewParams {
  stateStore: ActionQueueStateStore
  taskStore: ActionQueueTaskStore
  /** Absolute path to the repo root — used for the stale-worktree git probe. */
  repoRoot: string
  filter: DerivedActionQueueFilter
  /**
   * Current dispatch-pause state, supplied by the daemon so the action-queue
   * projection can derive live-accurate titles (e.g. whether a
   * `signature-storm` row should claim "dispatch is paused"). When null the
   * renderers that depend on it default to the unpaused branch — safe for
   * tests, CLI fall-through paths, and history views.
   */
  pauseState?: DispatchPauseState | null
  /**
   * When provided, only rows whose `kind` is in this set are enriched and
   * returned. Applied before the task-graph query so callers that filter to a
   * small subset (e.g. `--kind failed,stale-queued`) avoid paying the
   * enrichment cost for every unrelated open row.
   */
  kinds?: ReadonlySet<string>
  /**
   * Optional source for condition-derived synthetic rows. When provided, its
   * output is merged with persisted rows before enrichment so the projection
   * pipeline sees no difference between stored and derived items.
   *
   * In the daemon this is backed by `createConditionItemsSource`; in tests
   * and CLI contexts it may be omitted (defaults to no derived items).
   */
  conditionsSource?: ConditionItemsSource
  /**
   * Optional proposal status store. When provided, `draft-proposal` rows
   * whose proposalId points at a proposal that is absent or not in `draft`
   * status are treated as mis-kinded: their verbs are suppressed so unusable
   * actions (promote/dismiss) cannot reach the daemon.
   *
   * When omitted (tests, CLI contexts), the guard degrades to checking only
   * whether the proposalId field is present — sufficient for the most common
   * mis-kinded case (no proposalId at all).
   */
  proposalStore?: ProposalStatusStore
}

export interface BuildActionQueueHistoryViewParams {
  stateStore: ActionQueueStateStore
  taskStore: ActionQueueTaskStore
  /** Absolute path to the repo root — used for the stale-worktree git probe. */
  repoRoot: string
  limit?: number
  cursor?: string | null
}

/** Extract the task, proposal, worktree, or synthetic entity an action row represents. */
export const getActionQueueEntityId = (row: PersistedActionQueueRow): string => {
  if (row.kind === 'stale-worktree') {
    if (typeof row.context.taskId === 'string') return row.context.taskId
  }
  if (row.kind === 'draft-proposal') {
    if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
  }
  if (row.kind === 'scorer-suggested') {
    if (typeof row.payload.scorerId === 'string') return row.payload.scorerId
  }
  if (row.kind === 'slices-dropped') {
    if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
  }
  if (row.kind === 'slice-failed') {
    if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
  }
  if (row.kind === 'reflect-recommended') return row.signature ?? row.id
  if (row.kind === 'workflow-draft-pending') {
    if (typeof row.payload.workflowName === 'string') return row.payload.workflowName
    return row.signature ?? row.id
  }
  // gate-broken: the gate is the entity, not the task that tripped it.
  // Using originTaskId here caused operatorGoal to be derived from the tripping
  // task's intent and rendered as the card headline — wrong subject entirely.
  if (row.kind === 'gate-broken') {
    return typeof row.payload.gate === 'string' ? row.payload.gate : (row.signature ?? row.id)
  }
  if (typeof row.payload.taskId === 'string') return row.payload.taskId
  if (typeof row.payload.originTaskId === 'string') return row.payload.originTaskId
  return row.signature ?? row.id
}

/**
 * The persisted kinds that ARE a task's structured failure row, and whose
 * operator copy therefore belongs to the failure-kind registry rather than to
 * whoever raised the row. Every other kind that lands in the `failed-task`
 * bucket is a situational alert with its own purpose-built copy.
 */
const REGISTRY_TITLED_KINDS: ReadonlySet<string> = new Set([
  'failed',
  'daemon-killed',
])

/**
 * Derive the operator-facing title and body of a row that lands in the
 * `failed-task` bucket.
 *
 * `toUiKind` funnels every unrecognised kind into `failed-task`, so this
 * bucket holds two very different things and they are treated differently:
 *
 *  - **{@link REGISTRY_TITLED_KINDS}** — structured task failures. Their
 *    canonical copy lives in the failure-kind registry, and
 *    {@link failedTaskTitle} renders it with the failure signature and the
 *    failed task's short id so a queue of sixteen failures reads as sixteen
 *    distinct rows. Registration in the registry — NOT recipe presence —
 *    decides the reason: `daemon-killed` is registered with a warmTitle but
 *    has `recipe: null` and must still render it. When such a row's task
 *    carries no signature at all, a persisted title the raiser wrote on
 *    purpose beats the generic label and is kept.
 *  - **every other kind** (daemon-code-drift, signature-storm,
 *    requeue-ceiling, hitl-slice-needs-operator, …) — purpose-built alerts
 *    whose raiser already wrote specific operator copy ("Daemon running stale
 *    code — a1b2c3d → e4f5g6h"). Derived failure copy must never overwrite
 *    it; the row is only tagged with its task id when it has one.
 *
 * Shared by the live view and the history view so the two can never drift.
 */
const failedRowCopy = (
  row: PersistedActionQueueRow,
  task: TaskForActionQueue | undefined,
): { title: string; body: string } => {
  const signature = task?.failureSignature ?? null
  const capturedError = task?.lastErrorOutput ?? ''
  const persistedIsGeneric =
    row.title.trim().length === 0 || isGenericFailureLabel(row.title)

  // Keep the raiser's copy unless it says nothing the derived copy would not.
  // The [task mars-…] suffix is intentionally absent: arcGoal now serves as
  // the operator-facing headline that disambiguates rows of the same kind.
  if (
    !REGISTRY_TITLED_KINDS.has(row.kind) ||
    (signature === null && !persistedIsGeneric)
  ) {
    return {
      title: row.title,
      body: row.body,
    }
  }

  // §9 beat 3: headline names what happened, body names the decision.
  // The task id and failing phase anchor the card so the operator can act
  // without opening the transcript. Technical internals (signature, verbose
  // reason, captured error) are available via the task graph; they no longer
  // occupy the primary card face.
  const taskPart = task?.id ? `Task ${shortId(task.id)} ` : 'Task '

  // The body used to be a constant — "Continue on the existing worktree,
  // restart from scratch, or drop" — printed on every failed row regardless of
  // which verbs the row actually carried. A setup failure has no worktree, so
  // its action menu is restart/drop, and the card was naming Continue as the
  // first option while offering no way to run it. Read the menu instead of
  // asserting one.
  const decisionBody = (actions: readonly { label: string }[]): string => {
    const labels = actions.map((a) => a.label.toLowerCase())
    if (labels.length === 0) return 'No automatic recovery is available — inspect the transcript'
    if (labels.length === 1) return `Your one option: ${labels[0]}`
    const head = labels.slice(0, -1).join(', ')
    return `Your options: ${head} or ${labels[labels.length - 1]}`
  }

  if (signature !== null) {
    const kind = lookupFailureKind(signature)
    const phase = failingStepFromSignature(signature)
    const resolved = kind ?? unknownFailureKind(phase, capturedError)
    return {
      title: `${taskPart}failed at ${phase}: ${resolved.warmTitle}`,
      body: decisionBody(resolved.actions),
    }
  }

  // Null signature AND no captured error: the failure was recorded without any
  // diagnostic evidence — this is itself a bug (see 2026-09-07 incident, task
  // mars-87b7c958). Do not present the normal decision body; the operator has
  // nothing to base a decision on. Name the bug so they can investigate why
  // the failure arrived with no reason rather than presenting a false choice.
  if (!capturedError) {
    return {
      title: `${taskPart}failed: no diagnostic recorded`,
      body:
        'This failure was recorded without an error, reason, or phase — the diagnostic ' +
        'data is missing. This is itself a bug. Inspect the task transcript to understand ' +
        'what happened, then restart or drop once the cause is known.',
    }
  }

  // Null signature with captured error: use failedTaskTitle for the
  // summary (handles error-head extraction and recovery-prefix stripping).
  const summary = failedTaskTitle({ signature: null, capturedError })
  return {
    title: `${taskPart}failed: ${summary}`,
    body: decisionBody(unknownFailureKind('', capturedError).actions),
  }
}

/**
 * Build recipe fields (humanSummary, humanDetail, verbs) for a row.
 * Falls back to generic copy when the kind has no registered recipe
 * (e.g. a future kind added before a recipe is written).
 */
const buildRecipeFields = (
  row: PersistedActionQueueRow,
  entityId: string,
  title: string,
  body: string,
): { humanSummary: string; humanDetail: RecipeHumanDetail; verbs: RecipeVerb[]; decisions: RecipeDecision[] } => {
  const kind = row.kind
  if (!isActionQueueKind(kind)) {
    return {
      humanSummary: title || body || `Action required (kind: ${kind})`,
      humanDetail: { raisedAt: new Date(row.raisedAt).toISOString(), entityId },
      verbs: [
        { op: 'dismiss', label: 'Dismiss', style: 'default' },
        { op: 'snooze', label: 'Snooze', style: 'default' },
      ],
      decisions: [],
    }
  }
  const recipe = lookupRecipe(kind)
  const ctx = {
    kind,
    entityId,
    payload: row.payload,
    context: row.context,
    title,
    body,
    raisedAt: new Date(row.raisedAt).toISOString(),
  }
  const rawDecisions = recipe.decisions
  const decisions: RecipeDecision[] =
    rawDecisions == null
      ? []
      : typeof rawDecisions === 'function'
      ? rawDecisions(ctx)
      : rawDecisions
  return {
    humanSummary: recipe.humanSummary(ctx),
    humanDetail: recipe.humanDetail(ctx),
    verbs: getRecipeVerbs(recipe, ctx),
    decisions,
  }
}

/**
 * Normalises a raw intent or prompt string into a single-line arc goal of at
 * most 80 characters. Strips leading markdown heading markers (`#`, `##`,
 * `###`), takes the first non-empty line, collapses internal whitespace, and
 * truncates with an ellipsis suffix when needed.
 */
const normaliseGoalText = (text: string): string => {
  const firstLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const stripped = firstLine.replace(/^#{1,3}\s*/, '').trim()
  const oneLine = stripped.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 79)}…`
}

/**
 * Normalises a raw intent or prompt string into a single-line operator-facing
 * goal of at most 100 characters. Strips leading markdown heading markers
 * (`#`, `##`, `###`), removes inline backtick pairs and bold markers (`**`),
 * rewrites a leading second-person construction ('You should …', 'You need to
 * …', 'You must …') to imperative, takes the first non-empty line, collapses
 * internal whitespace, and truncates with an ellipsis suffix when needed.
 */
const normaliseOperatorGoal = (text: string): string => {
  const firstLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  // Strip markdown heading markers
  let stripped = firstLine.replace(/^#{1,3}\s*/, '').trim()
  // Strip inline code backtick pairs and bold markers
  stripped = stripped.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1')
  // Rewrite leading second-person to imperative
  stripped = stripped.replace(/^You\s+(should|need\s+to|must)\s+/i, '')
  // Re-capitalise the first character after stripping
  if (stripped.length > 0) {
    stripped = stripped.charAt(0).toUpperCase() + stripped.slice(1)
  }
  const oneLine = stripped.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 100 ? oneLine : `${oneLine.slice(0, 99)}…`
}

/**
 * Derives the human-readable arc goal for an action-queue row.
 *
 * Resolution order:
 * 1. Follow `fixForTaskId` to the recovery origin (fix/recovery tasks).
 * 2. When `fixForTaskId` is null, follow `originId` one hop when it is set and
 *    differs from the task's own id (supersede lineage). A second hop is taken
 *    if needed, but visited ids are tracked so a cycle cannot hang.
 * 3. Fall back to the task itself when no origin is resolvable.
 *
 * Source preference: the resolved origin's `intent` when non-empty; otherwise
 * its `prompt`. The result is normalised through `normaliseGoalText`.
 *
 * Returns `null` when `task` is undefined — callers that only have a
 * task-backed entity id should guard before calling.
 */
export const deriveArcGoal = (
  task: TaskForActionQueue,
  taskById: ReadonlyMap<string, TaskForActionQueue>,
): string => {
  let current: TaskForActionQueue = task

  // Step 1: follow fixForTaskId (recovery tasks point at their origin).
  if (current.fixForTaskId) {
    current = taskById.get(current.fixForTaskId) ?? current
  } else {
    // Step 2: follow originId one or two hops (supersede lineage).
    // Guard against self-reference and cycles.
    const visited = new Set<string>([task.id])
    for (let hop = 0; hop < 2; hop++) {
      const oId = current.originId
      if (!oId || oId === current.id || visited.has(oId)) break
      const next = taskById.get(oId)
      if (!next) break
      visited.add(oId)
      current = next
    }
  }

  const source =
    current.intent && current.intent.trim().length > 0
      ? current.intent
      : current.prompt
  return normaliseGoalText(source)
}

/**
 * Derives the operator-facing goal sentence for an action-queue row.
 *
 * Mirrors the resolution chain of `deriveArcGoal` (fixForTaskId → originId
 * → self) but applies `normaliseOperatorGoal` instead of `normaliseGoalText`.
 * Prefers the resolved origin's `intent` when non-empty; otherwise falls back
 * to its `prompt`.
 *
 * Returns a normalised plain-language string. Callers that only have a
 * task-backed entity id should guard for a null task before calling.
 */
export const deriveOperatorGoal = (
  task: TaskForActionQueue,
  taskById: ReadonlyMap<string, TaskForActionQueue>,
): string => {
  let current: TaskForActionQueue = task

  // Step 1: follow fixForTaskId (recovery tasks point at their origin).
  if (current.fixForTaskId) {
    current = taskById.get(current.fixForTaskId) ?? current
  } else {
    // Step 2: follow originId one or two hops (supersede lineage).
    // Guard against self-reference and cycles.
    const visited = new Set<string>([task.id])
    for (let hop = 0; hop < 2; hop++) {
      const oId = current.originId
      if (!oId || oId === current.id || visited.has(oId)) break
      const next = taskById.get(oId)
      if (!next) break
      visited.add(oId)
      current = next
    }
  }

  const source =
    current.intent && current.intent.trim().length > 0
      ? current.intent
      : current.prompt
  return normaliseOperatorGoal(source)
}

/**
 * Derive the full ActionQueueRow[] view from injected stores.
 *
 * Behaviour mirrors ui/server/index.ts's `/api/action-queue/action-queue` handler
 * (lines 177–531 before this slice) exactly: same sort, same daemon-killed-
 * batch synthesis, same diagnose-failure gate, same stale-worktree git probe.
 */
// DERIVED_KINDS is imported from action-queue-kinds and covers all 15 derived kinds.

export const buildActionQueueView = async ({
  stateStore,
  taskStore,
  repoRoot,
  filter: _filter,
  pauseState: rawPauseState,
  kinds,
  conditionsSource,
  proposalStore,
}: BuildActionQueueViewParams): Promise<ActionQueueRow[]> => {
  const pauseState = rawPauseState ?? null
  const profileStart = performance.now()
  const allPersistedRows = await stateStore.listOpenActionQueueItems()
  // Strip stored rows for derived kinds only when a conditionsSource is present
  // (i.e. in the live daemon path). Without conditionsSource (test/CLI contexts),
  // pass through whatever the stateStore has so test helpers that supply
  // synthetic derived-kind rows via the stateStore continue to work without change.
  // In production the migration (pg-schema.ts) already deleted all stored rows
  // for these kinds, so the filter is a belt-and-suspenders guard, not a primary
  // mechanism.
  const filteredPersistedRows = conditionsSource
    ? allPersistedRows.filter((r) => !DERIVED_KINDS.has(r.kind as ActionQueueKind))
    : allPersistedRows
  // Early kind filter: skip enrichment for non-matching rows. Applied before
  // the task-graph query so callers with a small kind set (e.g. the polling
  // pattern `--kind failed,stale-queued`) avoid loading the full task graph
  // for 60+ unrelated open rows.
  const storedRows =
    kinds && kinds.size > 0
      ? filteredPersistedRows.filter((row) => kinds.has(row.kind))
      : filteredPersistedRows

  // Derive condition rows and merge with stored rows. Run in parallel with the
  // stored-rows load — the derivation cost is bounded: each derivation is one
  // cheap DB query or in-memory read.
  const allDerivedRows = conditionsSource
    ? await conditionsSource.derive({ kinds }).catch(() => [] as PersistedActionQueueRow[])
    : []
  // Safety-net: filter derived rows by the caller's kinds filter too.  The
  // conditionsSource is only given the kinds hint (it may choose to ignore it),
  // so we enforce the filter here to keep the output consistent regardless of
  // what the derivation layer returned.
  const derivedRows =
    kinds && kinds.size > 0
      ? allDerivedRows.filter((r) => kinds.has(r.kind))
      : allDerivedRows

  const persistedRows = [...derivedRows, ...storedRows]
  const persistedRowsLoadedAt = performance.now()

  // Pre-fetch the set of proposal IDs that are currently in `draft` status, so
  // the per-row guard can detect rows pointing at dismissed/absent proposals
  // without issuing one DB round-trip per row. Only queried when a proposalStore
  // is wired and there are draft-proposal rows with a proposalId in this batch.
  const draftProposalRowIds: string[] = proposalStore
    ? persistedRows
        .filter((r) => r.kind === 'draft-proposal' && typeof r.payload.proposalId === 'string')
        .map((r) => r.payload.proposalId as string)
    : []
  const validDraftProposalIds: ReadonlySet<string> =
    proposalStore && draftProposalRowIds.length > 0
      ? await proposalStore.getDraftProposalIds(draftProposalRowIds).catch(() => new Set<string>())
      : new Set<string>()

  const allTasks = await taskStore.listTasksForActionQueueItems(persistedRows)
  const taskGraphLoadedAt = performance.now()
  const taskById = new Map(allTasks.map((t) => [t.id, t]))
  const blockingMap = new Map<string, string[]>()
  for (const t of allTasks) {
    for (const blkId of t.blockedBy) {
      const arr = blockingMap.get(blkId) ?? []
      arr.push(t.id)
      blockingMap.set(blkId, arr)
    }
  }

  // fixForTaskMap: origin task id → list of fix/recovery task ids that point at it.
  // Drives dag.descendants enrichment so each arc row shows its recovery chain.
  const fixForTaskMap = new Map<string, string[]>()
  for (const t of allTasks) {
    if (t.fixForTaskId) {
      const arr = fixForTaskMap.get(t.fixForTaskId) ?? []
      arr.push(t.id)
      fixForTaskMap.set(t.fixForTaskId, arr)
    }
  }

  // ── recovery-abandoned payload enrichment ──────────────────────────────────
  // Stored `recovery-abandoned` rows raised before the subscriber gained
  // `continuable` and `commitsAhead` payload fields are missing those keys.
  // Enrich from live task state on every read so the recipe renders the correct
  // verbs regardless of when the row was stored.
  //
  // Pattern mirrors the `worktreeDirtyCount` probe in deriveFailedConditions:
  // dynamic, change-over-time facts belong in a read-time probe, not in a stored
  // payload that goes stale the moment the task is continued or the worktree moves.
  //
  // Gate: `continuable` mirrors the exact guard `continue-task.ts` applies at the
  // command level.  `commitsAhead` is a `git rev-list --count main..<branch>` probe;
  // null means the branch is absent or git failed — recipe falls back to plain "Restart".
  for (const row of persistedRows) {
    if (row.kind !== 'recovery-abandoned') continue
    const originId =
      typeof row.payload.originTaskId === 'string'
        ? row.payload.originTaskId
        : typeof row.payload.taskId === 'string'
          ? row.payload.taskId
          : null
    if (originId === null) continue
    const originTask = taskById.get(originId)
    if (originTask === undefined) continue

    const branch = originTask.branch
    const failureReason = originTask.failureReason ?? ''
    const worktreePath = originTask.worktreePath ?? null

    const continuable =
      !!branch &&
      !!worktreePath &&
      !failureReason.startsWith(RECOVERY_EXHAUSTED_PREFIX) &&
      !failureReason.startsWith(RECOVERY_DISABLED_PREFIX)

    let commitsAhead: number | null = null
    if (branch) {
      try {
        const out = execFileSync(
          'git',
          ['-C', repoRoot, 'rev-list', '--count', `main..${branch}`],
          { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
        )
        const n = parseInt(out.trim(), 10)
        if (Number.isFinite(n)) commitsAhead = n
      } catch {
        // Branch absent, git unavailable, or probe timed out. Leave null so
        // the recipe falls back to a plain "Restart" label with no commit count.
      }
    }

    row.payload.continuable = continuable
    row.payload.commitsAhead = commitsAhead
  }

  const toUiPriority = (p: string): 'high' | 'normal' | 'low' => {
    if (p === 'urgent' || p === 'high') return 'high'
    if (p === 'low') return 'low'
    return 'normal'
  }

  // 'failed' maps to 'failed-task' for backwards compat with the action registry.
  const toErrorKind = (k: string): string =>
    k === 'failed' ? 'failed-task' : k

  // Truncates a task's display title to a single line of at most 80 characters.
  // Used by toNode (DAG summaries). Prefers intent over raw prompt — see
  // taskDisplayTitle in core/lib/task-display-title.ts for the full chain.
  const summarizeTask = (t: TaskForActionQueue): string => {
    const title = taskDisplayTitle(t)
    return title.length <= 80 ? title : `${title.slice(0, 79)}…`
  }

  const toNode = (id: string) => {
    const t = taskById.get(id)
    return {
      id,
      status: (t?.status ?? 'dropped') as string,
      summary: t ? summarizeTask(t) : '(unknown task)',
    }
  }

  const rows: ActionQueueRow[] = []

  for (const row of persistedRows) {
    const uiKind = row.kind
    const isTaskFailure = isTaskFailureKind(row.kind)
    const entityId = getActionQueueEntityId(row)
    const errorKind = toErrorKind(row.kind)

    // For failed-task rows, actions come from the FailureKind registry so
    // the title, reason, and action menu are always from the same record.
    // For stale-worktree, draft-proposal, and hitl-slice-needs-operator rows,
    // the non-failure derived-row action menu is the authority.
    //
    // A draft-proposal row is "unusable" when:
    //   (a) its payload carries no proposalId (mis-kinded — e.g. a legacy QA
    //       step-list payload stored before raisers were re-kinded to
    //       qa-step-list-opt-in / qa-step-list-promote), OR
    //   (b) its proposalId references a proposal that is absent or no longer
    //       in `draft` status (e.g. already dismissed). In both cases the
    //       promote/dismiss verbs would 500 against a nonexistent or
    //       non-actionable proposal entity.
    // The row stays visible so the operator can see it, but emits no actions or
    // recipe verbs — unactionable until the startup reconcile closes it.
    const proposalId =
      errorKind === 'draft-proposal' && typeof row.payload.proposalId === 'string'
        ? row.payload.proposalId
        : null
    const isMiskindedDraftProposal =
      errorKind === 'draft-proposal' &&
      (proposalId === null ||
        (proposalStore !== undefined && !validDraftProposalIds.has(proposalId)))
    let actions: { id: string; label: string; op: string }[]
    if (isTaskFailure) {
      const sig = taskById.get(entityId)?.failureSignature ?? null
      const fk =
        sig !== null
          ? (lookupFailureKind(sig) ??
            unknownFailureKind(failingStepFromSignature(sig), ''))
          : unknownFailureKind('unknown', '')
      actions = fk.actions as { id: string; label: string; op: string; needsConfirm?: boolean; hint?: string }[]
    } else if (isMiskindedDraftProposal) {
      actions = []
    } else {
      actions = derivedRowActions(errorKind, entityId) as {
        id: string
        label: string
        op: string
        needsConfirm?: boolean
        hint?: string
      }[]
    }

    // Suppress diagnose-failure when this is a task-failure-kind row but the
    // entityId does not resolve to a real task in the loaded task graph.
    // gate-broken and signature-storm are isTaskFailureKind rows that CAN carry
    // a taskId payload (and are genuinely task-backed when they do), but when
    // they don't, entityId resolves to a signature string — invoking
    // diagnose-failure against a non-task id is meaningless. Per-row decision,
    // not per-kind: the kind alone cannot express "this row has a task behind it".
    if (isTaskFailure && !taskById.has(entityId)) {
      actions = actions.filter((a) => a.op !== 'diagnose-failure')
    }

    // DAG enrichment for task-backed rows.
    let dag: ActionQueueRow['dag'] = null
    if (isTaskFailure) {
      const task = taskById.get(entityId)
      if (task) {
        const blockers = task.blockedBy.map(toNode)
        const blocking = (blockingMap.get(entityId) ?? []).map(toNode)
        // Enrich descendants with fix/recovery tasks that point at this origin.
        const descendants = (fixForTaskMap.get(entityId) ?? []).map(toNode)

        // Build the set of node ids present in this dag card.
        const dagNodeSet = new Set<string>([
          entityId,
          ...blockers.map((n) => n.id),
          ...blocking.map((n) => n.id),
          ...descendants.map((n) => n.id),
        ])

        // Collect candidate edges among dag nodes only.
        const rawEdges: { from: string; to: string; kind: 'blocks' | 'recovers' }[] = []

        // 'blocks' edges: for each node N, for each B in N.blockedBy that is also in the set.
        for (const nodeId of dagNodeSet) {
          for (const blockerId of (taskById.get(nodeId)?.blockedBy ?? [])) {
            if (dagNodeSet.has(blockerId)) {
              rawEdges.push({ from: blockerId, to: nodeId, kind: 'blocks' })
            }
          }
        }

        // 'recovers' edges: for each descendant D, emit D→entityId.
        for (const desc of descendants) {
          rawEdges.push({ from: desc.id, to: entityId, kind: 'recovers' })
        }

        // Deduplicate and sort deterministically (from, then to, then kind).
        const edgeKey = (e: { from: string; to: string; kind: string }) =>
          `${e.from}|${e.to}|${e.kind}`
        const seenEdges = new Set<string>()
        const edges = rawEdges
          .filter((e) => {
            const k = edgeKey(e)
            if (seenEdges.has(k)) return false
            seenEdges.add(k)
            return true
          })
          .sort((a, b) => {
            const ka = edgeKey(a)
            const kb = edgeKey(b)
            return ka < kb ? -1 : ka > kb ? 1 : 0
          })

        dag = {
          blockers,
          blocking,
          descendants,
          proposalId: task.parentProposalId,
          edges,
        }
      }
    }

    // Stale-worktree enrichment: compute git-derived `empty` flag.
    // empty=true means no diff vs merge-base with main AND no untracked files.
    // Conservative default: false (e.g. when worktree path does not exist).
    let staleWorktreeDetail: StaleWorktreeDetail | null = null
    if (uiKind === 'stale-worktree') {
      const task = taskById.get(entityId)
      const worktreePath = join(repoRoot, '.mars', 'worktrees', entityId)
      let empty = false
      if (existsSync(worktreePath)) {
        try {
          const base = execFileSync(
            'git',
            ['-C', worktreePath, 'merge-base', 'HEAD', 'main'],
            { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
          ).trim()
          let hasDiff = false
          try {
            execFileSync(
              'git',
              ['-C', worktreePath, 'diff', '--quiet', `${base}..HEAD`],
              { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
            )
          } catch {
            hasDiff = true
          }
          const porcelain = hasDiff
            ? 'X'
            : execFileSync(
                'git',
                ['-C', worktreePath, 'status', '--porcelain'],
                { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
              ).trim()
          empty = !hasDiff && porcelain === ''
        } catch {
          // git unavailable, worktree not a git repo, or probe timed out — conservative
          empty = false
        }
      }
      staleWorktreeDetail = {
        prompt:
          typeof row.payload.prompt === 'string'
            ? row.payload.prompt
            : (task?.prompt ?? null),
        status:
          task?.status ??
          (typeof row.payload.status === 'string'
            ? row.payload.status
            : 'absent (no matching task)'),
        ageHours:
          typeof row.payload.ageHours === 'number'
            ? row.payload.ageHours
            : 0,
        updatedAt:
          task?.updatedAt ??
          (typeof row.payload.updatedAt === 'string'
            ? row.payload.updatedAt
            : new Date(row.lastSeenAt).toISOString()),
        branch:
          typeof row.payload.branch === 'string'
            ? row.payload.branch
            : (task?.branch ?? null),
        empty,
        investigation:
          typeof row.payload.investigation === 'string'
            ? row.payload.investigation
            : null,
      }
    }

    // Diagnosis persisted by the diagnose-failure agent onto the actionQueue payload.
    let diagnosis: { text: string; diagnosedAt: string } | null = null
    const rawDiagnosis = row.payload.diagnosis
    if (
      rawDiagnosis !== null &&
      typeof rawDiagnosis === 'object' &&
      typeof (rawDiagnosis as { text?: unknown }).text === 'string' &&
      typeof (rawDiagnosis as { diagnosedAt?: unknown }).diagnosedAt === 'string'
    ) {
      diagnosis = {
        text: (rawDiagnosis as { text: string }).text,
        diagnosedAt: (rawDiagnosis as { diagnosedAt: string }).diagnosedAt,
      }
    }

    // Pull the failure-reason catalog code from the payload.
    const failureReasonCode =
      typeof row.payload.failureReasonCode === 'string'
        ? row.payload.failureReasonCode
        : null
    const recoveryExhausted = row.payload.recoveryExhausted === true

    // Task-failure rows derive their title and body from the failure-kind
    // registry rather than from the persisted row strings (see failedRowCopy,
    // which decides per kind whether the registry or the raiser owns the copy).
    // Non-task kinds (hitl-slice-needs-operator, draft-proposal, …) are
    // excluded outright: their persisted copy is the only copy there is.
    let title = row.title
    let body = row.body
    if (isTaskFailure) {
      const copy = failedRowCopy(row, taskById.get(entityId))
      title = copy.title
      body = copy.body
    }

    // Operational rows are not task-failure rows, even when they name a task.
    // Their renderer owns the diagnosis and pointer instead of the FailureKind
    // fallback, which only understands a task's failure signature.
    // Pass the live pause state so renderers (e.g. signature-storm) can derive
    // the "dispatch is paused" clause from current reality, not frozen history.
    const operationalCopy = renderOperationalAlertCopy(row, pauseState)
    if (operationalCopy !== null) {
      title = operationalCopy.title
      body = operationalCopy.body
    }

    // Recovery-in-flight: when the derived 'failed' row signals that a fix
    // task is currently running, override the title regardless of what
    // failedRowCopy or operationalCopy wrote — the operator-obligation
    // changes from "act now" to "Mars is handling it".
    if (row.kind === 'failed' && row.payload.recoveryInFlight === true) {
      const taskId = typeof row.payload.taskId === 'string' ? row.payload.taskId : entityId
      title = `Mars is attempting to fix task ${taskId} — no action needed yet`
    }

    // Propagate fixForTaskId so the UI can render an "origin" link on recovery rows.
    // hitl-slice-needs-operator items are not task-backed, so no fixForTaskId.
    const fixForTaskId =
      isTaskFailure
        ? (taskById.get(entityId)?.fixForTaskId ?? null)
        : null

    // Derive the arc/operator goals for any row whose entity is a task in our
    // graph. Previously gated on isTaskFailure, which excluded awaiting-human
    // and other non-failure task-backed kinds. The correct question is "do we
    // have a task for this entity?", not "is this row a failure kind?".
    let arcGoal: string | null = null
    let operatorGoal: string | null = null
    const taskForGoals = taskById.get(entityId)
    if (taskForGoals) {
      arcGoal = deriveArcGoal(taskForGoals, taskById)
      operatorGoal = deriveOperatorGoal(taskForGoals, taskById)
    }
    // Recipe-level fallback: for kinds whose entity is not a task (e.g.
    // `slice-failed` where the entity is a proposal), the recipe can supply
    // operatorGoal directly from the payload — taskById will never hold the id.
    if (operatorGoal === null && isActionQueueKind(row.kind)) {
      const _recipe = lookupRecipe(row.kind)
      if (_recipe.operatorGoal) {
        operatorGoal = _recipe.operatorGoal({
          kind: row.kind,
          entityId,
          payload: row.payload,
          context: row.context,
          title,
          body,
          raisedAt: new Date(row.raisedAt).toISOString(),
        })
      }
    }

    // Derive the entity's human-readable title via the kind's recipe, when
    // declared. Used by the UI to name cause-group members without parsing
    // the body prose. Null for kinds that do not declare an entityTitle accessor.
    let entityTitle: string | null = null
    if (isActionQueueKind(row.kind)) {
      const _recipe = lookupRecipe(row.kind)
      if (_recipe.entityTitle) {
        entityTitle = _recipe.entityTitle({
          kind: row.kind,
          entityId,
          payload: row.payload,
          context: row.context,
          title,
          body,
          raisedAt: new Date(row.raisedAt).toISOString(),
        })
      }
    }

    // Surface the live preview URL for awaiting-validation rows. The merge
    // primitive stamps it into the row payload at raise time (and persists the
    // same value on the task row), so the payload is the authoritative,
    // restart-safe source the projection reads.
    const devServerUrl =
      (uiKind === 'awaiting-validation' || uiKind === 'awaiting-validation-preview-gone') &&
      typeof row.payload.devServerUrl === 'string'
        ? row.payload.devServerUrl
        : null

    // Surface the lease state for awaiting-human rows.
    // Prefer live task-row values over the action-queue payload snapshot:
    // the payload is written at park time, while the task row's lease columns
    // reflect the current owner.
    const leaseState: ActionQueueRow['leaseState'] = (() => {
      if (uiKind !== 'awaiting-human') return null
      const t = taskById.get(entityId)
      // Use task-row values when the task is found (leaseOwner/leasedAt may be
      // undefined when the field was not included by the store — fall through).
      const owner =
        t !== undefined && t.leaseOwner !== undefined
          ? t.leaseOwner
          : typeof row.payload.leaseOwner === 'string'
            ? row.payload.leaseOwner
            : null
      const at =
        t !== undefined && t.leasedAt !== undefined
          ? t.leasedAt
          : typeof row.payload.leasedAt === 'string'
            ? row.payload.leasedAt
            : null
      const note =
        t !== undefined && t.leaseNote !== undefined
          ? t.leaseNote
          : typeof row.payload.leaseNote === 'string'
            ? row.payload.leaseNote
            : null
      return owner !== null && at !== null
        ? { leaseOwner: owner, leasedAt: at, leaseNote: note }
        : null
    })()

    // Extract preview URL and log path for awaiting-human manual-QA rows.
    const previewUrl: string | null =
      uiKind === 'awaiting-human' && typeof row.payload.previewUrl === 'string'
        ? row.payload.previewUrl
        : null
    const logPath: string | null =
      uiKind === 'awaiting-human' && typeof row.payload.logPath === 'string'
        ? row.payload.logPath
        : null

    // Extract tool-promotion benchmark detail from payload for tool-promotion rows.
    const toolPromotionDetail: ActionQueueRow['toolPromotionDetail'] =
      uiKind === 'tool-promotion'
        ? {
            helperKey:
              typeof row.payload.helperKey === 'string' ? row.payload.helperKey : '',
            motivatingArcIds: Array.isArray(row.payload.motivatingArcIds)
              ? (row.payload.motivatingArcIds as string[])
              : [],
            before: row.payload.before ?? null,
            after: row.payload.after ?? null,
          }
        : null

    // Extract stall diagnostics and pool snapshot for task-blocked rows
    // (slice 6 of PRD d23b2704). Both fields fall back to null on legacy rows
    // and on every other row kind, so pre-existing consumers never crash.
    const stallDiagnostics: unknown | null =
      isTaskFailure && row.payload.stallDiagnostics !== undefined
        ? (row.payload.stallDiagnostics ?? null)
        : null
    const poolSnapshot: ActionQueueRow['poolSnapshot'] = (() => {
      if (!isTaskFailure) return null
      const snap = row.payload.poolSnapshot
      if (
        typeof snap !== 'object' ||
        snap === null ||
        typeof (snap as Record<string, unknown>).activeWorkerCount !== 'number'
      )
        return null
      const s = snap as Record<string, unknown>
      return {
        activeWorkerCount: s.activeWorkerCount as number,
        queuedCount: typeof s.queuedCount === 'number' ? s.queuedCount : 0,
        runningCount: typeof s.runningCount === 'number' ? s.runningCount : 0,
        blockedCount: typeof s.blockedCount === 'number' ? s.blockedCount : 0,
        recentDispatchDecisions: Array.isArray(s.recentDispatchDecisions)
          ? (s.recentDispatchDecisions as string[])
          : [],
      }
    })()

    const recipeFields = buildRecipeFields(row, entityId, title, body)
    // When the operational alert renderer supplies a humanSummary, it overrides
    // the recipe's generic sentence. The recipe computes humanSummary from the
    // kind alone; operational renderers also see the live pause-state and
    // escalation context, so their sentence is more accurate when present.
    let humanSummary = operationalCopy?.humanSummary ?? recipeFields.humanSummary
    // Recovery-in-flight: the recipe's default says "Mars used up its retry"
    // which is wrong while a live fix task exists. Swap in a notice-class copy
    // so the summary reflects the notice-class obligation rather than the alert.
    if (row.kind === 'failed' && row.payload.recoveryInFlight === true) {
      humanSummary = 'Mars is attempting a repair — no action needed yet'
    }

    // Title normalisation (HR-3, DEC-18): when the recipe provides a human
    // summary and no operational copy or failure-registry title has already
    // overridden the raiser's machine string, promote humanSummary to title so
    // BOTH the CLI (`humanSummary || title`) and the UI (`title`) display the
    // same human copy. Without this, the UI shows the machine string the raiser
    // stamped (e.g. "Slicer failed for PRD 04b4e4e0-…") while the CLI shows
    // the recipe sentence ("Mars could not turn this PRD into tasks — …").
    if (humanSummary && operationalCopy === null && !REGISTRY_TITLED_KINDS.has(row.kind)) {
      title = humanSummary
    }

    // Extract conditionKey for health-check-alert rows. Used by the Steward
    // to auto-close open rows when the associated condition is gone.
    const conditionKey: string | null =
      uiKind === 'health-check-alert' && typeof row.payload.conditionKey === 'string'
        ? row.payload.conditionKey
        : null

    // Structural class and notice key for the three-class model.
    let itemClass: ActionQueueClass = isActionQueueKind(row.kind)
      ? classifyKind(row.kind)
      : 'decision'
    // Context-aware override: a notice-class condition's automated repair may be
    // exhausted at render time, shifting the operator-obligation from notice to alert.
    // classifyKind assigns based on the kind's nominal contract (KIND_CLASS); this
    // adjusts for live context the kind alone cannot encode.
    //
    // Rule: if the nominal class is `notice` AND the payload signals that Mars's
    // last automated move is spent, reclassify as `alert` so the UI surfaces the
    // item as actionable rather than informational.
    if (itemClass === 'notice' && row.kind === 'signature-storm') {
      // The escalation variant carries `stewardAttempts`: the Steward budget is
      // spent and Mars has stopped auto-pausing for this signature. No automated
      // move remains — the operator is now on the hook.
      const stewardAttempts =
        typeof row.payload.stewardAttempts === 'number' ? row.payload.stewardAttempts : null
      if (stewardAttempts !== null) {
        itemClass = 'alert'
      }
    }
    // Recovery-in-flight: a 'failed' row whose derived payload signals an
    // active fix/recovery task is classified as 'notice' — Mars is still trying
    // and the operator is not on the hook yet. classifyKind maps 'failed' →
    // 'alert' by default; this overrides for the live repair context.
    // baseline-broken is intentionally excluded: no auto-repair path exists for
    // test failures, so it stays 'alert' from the first instant.
    if (row.kind === 'failed' && row.payload.recoveryInFlight === true) {
      itemClass = 'notice'
    }
    // noticeKey: for notice items, read from the payload (set by the raiser),
    // falling back to the kind itself for notice kinds without a per-instance key.
    const noticeKey: string | null = itemClass === 'notice'
      ? (typeof row.payload.noticeKey === 'string'
          ? row.payload.noticeKey
          : (isActionQueueKind(row.kind) && KIND_CLASS[row.kind as ActionQueueKind] === 'notice' ? row.kind : null))
      : null

    // Derived items are regenerated on every read, so their `lastSeenAt` is the
    // query time — rendering it makes every derived item claim it happened "0s
    // ago" no matter how old the underlying evidence is. Their `raisedAt` is
    // the real evidence time (a gate's `last_failure_at`, a crash's
    // `crashDetectedAt`, a worktree's mtime), so read that instead.
    //
    // This was previously patched per-kind for `failed` and `daemon-died`,
    // which left the other derived kinds lying: five quarantined gates all
    // rendered "0s ago" on a live queue. It is a structural property of
    // DERIVED_KINDS, not tied to any single class, so check membership once
    // and apply it.
    //
    // `failed` keeps its sharper source: the task's own updatedAt is the exact
    // failure time, where raisedAt is only the derive-time fallback.
    //
    // `reflect-recommended` is a stored (non-derived) row, but its raiser
    // bumps `lastSeenAt` on every detector recompute — so `lastSeenAt` tracks
    // when evidence was last evaluated, NOT when the advisory was first raised.
    // Using it would make the row always appear brand-new to the operator.
    // `raisedAt` is the stable origin timestamp; use it here too.
    //
    // All other stored rows have a meaningful lastSeenAt.
    const rowAt =
      row.kind === 'failed'
        ? (taskById.get(entityId)?.updatedAt ?? new Date(row.raisedAt).toISOString())
        : DERIVED_KINDS.has(row.kind as ActionQueueKind) || row.kind === 'reflect-recommended'
          ? new Date(row.raisedAt).toISOString()
          : new Date(row.lastSeenAt).toISOString()

    rows.push({
      id: row.id,
      kind: uiKind,
      entityId,
      priority: toUiPriority(row.priority),
      title,
      body,
      at: rowAt,
      dag,
      errorKind,
      actions,
      staleWorktreeDetail,
      devServerUrl,
      leaseState,
      diagnosis,
      failureReasonCode,
      recoveryExhausted,
      fixForTaskId,
      arcGoal,
      operatorGoal,
      entityTitle,
      toolPromotionDetail,
      previewUrl,
      logPath,
      stallDiagnostics,
      poolSnapshot,
      conditionKey,
      class: itemClass,
      noticeKey,
      humanSummary,
      humanDetail: recipeFields.humanDetail,
      // Mis-kinded draft-proposal rows carry no proposalId: their promote/
      // dismiss/grill verbs would 500. Suppress all recipe verbs so the row
      // is visible but unactionable until a reconciliation pass closes it.
      verbs: isMiskindedDraftProposal ? [] : recipeFields.verbs,
      decisions: recipeFields.decisions ?? [],
    })
  }

  const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
    high: 0,
    normal: 1,
    low: 2,
  }
  // Under the pure-projection model every row in persistedRows is already
  // open (the Invalidator is the sole row-closer). 'open' and 'all' therefore
  // return the same set; both are accepted for API compatibility.
  const filtered = rows.slice()

  filtered.sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    return pr !== 0 ? pr : b.at.localeCompare(a.at)
  })

  // When ≥2 daemon-killed rows are visible, prepend a synthetic batch-restart row.
  const daemonKilledVisible = filtered.filter(
    (r) => r.errorKind === 'daemon-killed',
  )
  if (daemonKilledVisible.length >= 2) {
    // The synthetic batch row surfaces only the batch verb from the
    // daemon-killed Failure kind record (the per-task requeue / restart-daemon
    // actions stay on the individual rows).
    const batchActions = (
      lookupFailureKind(DAEMON_KILLED_SIGNATURE)?.actions ?? []
    ).filter((a) => a.op === 'continue-all-daemon-killed') as {
      id: string
      label: string
      op: string
    }[]
    const newest = daemonKilledVisible[0]!
    // Derive the batch row's title and body from the daemon-killed Failure kind
    // entry so the copy stays consistent with the registry rather than being
    // hardcoded here. The count is appended to the title for context.
    const daemonKilledKind = lookupFailureKind(DAEMON_KILLED_SIGNATURE)
    const batchTitle = daemonKilledKind
      ? `${daemonKilledKind.warmTitle} (${daemonKilledVisible.length})`
      : `Restart all daemon-killed tasks (${daemonKilledVisible.length})`
    const batchBody = daemonKilledKind
      ? daemonKilledKind.verboseReason
      : `${daemonKilledVisible.length} tasks were in flight when the daemon was killed.\n` +
        `None of these failures are task faults — a fresh dispatch is very likely to succeed.`
    const daemonKilledRecipe = lookupRecipe('daemon-killed')
    const batchRecipeCtx = {
      kind: 'daemon-killed' as const,
      entityId: '__daemon-killed-batch__',
      payload: {},
      context: {},
      title: batchTitle,
      body: batchBody,
      raisedAt: newest.at,
    }
    filtered.unshift({
      id: 'daemon-killed:__daemon-killed-batch__',
      kind: 'daemon-killed',
      entityId: '__daemon-killed-batch__',
      priority: 'high',
      title: batchTitle,
      body: batchBody,
      at: newest.at,
      dag: null,
      errorKind: 'daemon-killed-batch',
      actions: batchActions,
      staleWorktreeDetail: null,
      devServerUrl: null,
      leaseState: null,
      diagnosis: null,
      failureReasonCode: null,
      recoveryExhausted: false,
      // Synthetic aggregate row — no single arc goal or entity title applies.
      arcGoal: null,
      operatorGoal: null,
      entityTitle: null,
      class: 'alert',
      noticeKey: null,
      humanSummary: daemonKilledRecipe.humanSummary(batchRecipeCtx),
      humanDetail: daemonKilledRecipe.humanDetail(batchRecipeCtx),
      verbs: getRecipeVerbs(daemonKilledRecipe, batchRecipeCtx),
      decisions: [],
    })
  }

  if (process.env.MARS_ACTION_QUEUE_VIEW_PROFILE === '1') {
    const finishedAt = performance.now()
    console.info(
      `[action-queue-view] visible_rows=${persistedRows.length} task_graph_rows=${allTasks.length} ` +
        `visible_rows_ms=${(persistedRowsLoadedAt - profileStart).toFixed(1)} ` +
        `task_graph_ms=${(taskGraphLoadedAt - persistedRowsLoadedAt).toFixed(1)} ` +
        `derive_ms=${(finishedAt - taskGraphLoadedAt).toFixed(1)} ` +
        `total_ms=${(finishedAt - profileStart).toFixed(1)}`,
    )
  }

  return filtered
}

/**
 * Derive an ActionQueueRow[] for resolved (history) rows, cursor-paged
 * newest-first by resolved_at.
 *
 * Applies the same kind-mapping, entity-id extraction, DAG enrichment, and
 * stale-worktree git probe as buildActionQueueView so the existing detail pane
 * can render resolved rows. Resolved rows carry resolution metadata and have
 * empty actions (they are read-only).
 */
export const buildActionQueueHistoryView = async ({
  stateStore,
  taskStore,
  repoRoot,
  limit,
  cursor,
}: BuildActionQueueHistoryViewParams): Promise<{
  rows: ActionQueueRow[]
  nextCursor: string | null
}> => {
  const { items: persistedRows, nextCursor } =
    await stateStore.listResolvedActionQueueItems({ limit, cursor })

  const allTasks = await taskStore.listTasksForActionQueueItems(persistedRows)
  const taskById = new Map(allTasks.map((t) => [t.id, t]))
  const blockingMap = new Map<string, string[]>()
  for (const t of allTasks) {
    for (const blkId of t.blockedBy) {
      const arr = blockingMap.get(blkId) ?? []
      arr.push(t.id)
      blockingMap.set(blkId, arr)
    }
  }
  const fixForTaskMap = new Map<string, string[]>()
  for (const t of allTasks) {
    if (t.fixForTaskId) {
      const arr = fixForTaskMap.get(t.fixForTaskId) ?? []
      arr.push(t.id)
      fixForTaskMap.set(t.fixForTaskId, arr)
    }
  }

  const toUiPriority = (p: string): 'high' | 'normal' | 'low' => {
    if (p === 'urgent' || p === 'high') return 'high'
    if (p === 'low') return 'low'
    return 'normal'
  }

  const toErrorKind = (k: string): string =>
    k === 'failed' ? 'failed-task' : k

  const summarizePrompt = (prompt: string): string => {
    const oneLine = prompt.replace(/\s+/g, ' ').trim()
    return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 79)}…`
  }

  const toNode = (id: string) => {
    const t = taskById.get(id)
    return {
      id,
      status: (t?.status ?? 'dropped') as string,
      summary: t ? summarizePrompt(t.prompt) : '(unknown task)',
    }
  }

  const rows: ActionQueueRow[] = []

  for (const row of persistedRows) {
    const uiKind = row.kind
    const isTaskFailure = isTaskFailureKind(row.kind)
    const entityId = getActionQueueEntityId(row)
    const errorKind = toErrorKind(row.kind)

    // DAG enrichment (same as live view).
    let dag: ActionQueueRow['dag'] = null
    if (isTaskFailure) {
      const task = taskById.get(entityId)
      if (task) {
        const blockers = task.blockedBy.map(toNode)
        const blocking = (blockingMap.get(entityId) ?? []).map(toNode)
        const descendants = (fixForTaskMap.get(entityId) ?? []).map(toNode)

        // Build the set of node ids present in this dag card.
        const dagNodeSet = new Set<string>([
          entityId,
          ...blockers.map((n) => n.id),
          ...blocking.map((n) => n.id),
          ...descendants.map((n) => n.id),
        ])

        // Collect candidate edges among dag nodes only.
        const rawEdges: { from: string; to: string; kind: 'blocks' | 'recovers' }[] = []

        // 'blocks' edges: for each node N, for each B in N.blockedBy that is also in the set.
        for (const nodeId of dagNodeSet) {
          for (const blockerId of (taskById.get(nodeId)?.blockedBy ?? [])) {
            if (dagNodeSet.has(blockerId)) {
              rawEdges.push({ from: blockerId, to: nodeId, kind: 'blocks' })
            }
          }
        }

        // 'recovers' edges: for each descendant D, emit D→entityId.
        for (const desc of descendants) {
          rawEdges.push({ from: desc.id, to: entityId, kind: 'recovers' })
        }

        // Deduplicate and sort deterministically (from, then to, then kind).
        const edgeKey = (e: { from: string; to: string; kind: string }) =>
          `${e.from}|${e.to}|${e.kind}`
        const seenEdges = new Set<string>()
        const edges = rawEdges
          .filter((e) => {
            const k = edgeKey(e)
            if (seenEdges.has(k)) return false
            seenEdges.add(k)
            return true
          })
          .sort((a, b) => {
            const ka = edgeKey(a)
            const kb = edgeKey(b)
            return ka < kb ? -1 : ka > kb ? 1 : 0
          })

        dag = { blockers, blocking, descendants, proposalId: task.parentProposalId, edges }
      }
    }

    // Stale-worktree enrichment (safe — catches missing dirs).
    let staleWorktreeDetail: StaleWorktreeDetail | null = null
    if (uiKind === 'stale-worktree') {
      const task = taskById.get(entityId)
      const worktreePath = join(repoRoot, '.mars', 'worktrees', entityId)
      let empty = false
      if (existsSync(worktreePath)) {
        try {
          const base = execFileSync(
            'git',
            ['-C', worktreePath, 'merge-base', 'HEAD', 'main'],
            { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
          ).trim()
          let hasDiff = false
          try {
            execFileSync(
              'git',
              ['-C', worktreePath, 'diff', '--quiet', `${base}..HEAD`],
              { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
            )
          } catch {
            hasDiff = true
          }
          const porcelain = hasDiff
            ? 'X'
            : execFileSync(
                'git',
                ['-C', worktreePath, 'status', '--porcelain'],
                { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL' },
              ).trim()
          empty = !hasDiff && porcelain === ''
        } catch {
          // git unavailable, worktree not a git repo, or probe timed out — conservative
          empty = false
        }
      }
      staleWorktreeDetail = {
        prompt:
          typeof row.payload.prompt === 'string'
            ? row.payload.prompt
            : (task?.prompt ?? null),
        status:
          task?.status ??
          (typeof row.payload.status === 'string'
            ? row.payload.status
            : 'absent (no matching task)'),
        ageHours:
          typeof row.payload.ageHours === 'number' ? row.payload.ageHours : 0,
        updatedAt:
          task?.updatedAt ??
          (typeof row.payload.updatedAt === 'string'
            ? row.payload.updatedAt
            : new Date(row.lastSeenAt).toISOString()),
        branch:
          typeof row.payload.branch === 'string'
            ? row.payload.branch
            : (task?.branch ?? null),
        empty,
        investigation:
          typeof row.payload.investigation === 'string'
            ? row.payload.investigation
            : null,
      }
    }

    // Diagnosis.
    let diagnosis: { text: string; diagnosedAt: string } | null = null
    const rawDiagnosis = row.payload.diagnosis
    if (
      rawDiagnosis !== null &&
      typeof rawDiagnosis === 'object' &&
      typeof (rawDiagnosis as { text?: unknown }).text === 'string' &&
      typeof (rawDiagnosis as { diagnosedAt?: unknown }).diagnosedAt === 'string'
    ) {
      diagnosis = {
        text: (rawDiagnosis as { text: string }).text,
        diagnosedAt: (rawDiagnosis as { diagnosedAt: string }).diagnosedAt,
      }
    }

    const failureReasonCode =
      typeof row.payload.failureReasonCode === 'string'
        ? row.payload.failureReasonCode
        : null
    const recoveryExhausted = row.payload.recoveryExhausted === true

    // Title / body from the failure-kind registry for failed-task rows —
    // identical rule to the live view (see failedRowCopy).
    let title = row.title
    let body = row.body
    if (isTaskFailure) {
      const copy = failedRowCopy(row, taskById.get(entityId))
      title = copy.title
      body = copy.body
    }

    // History rows are already resolved; dispatch state at resolution time is
    // unknown and irrelevant. Pass null so the pause clause defaults to unpaused.
    const operationalCopy = renderOperationalAlertCopy(row, null)
    if (operationalCopy !== null) {
      title = operationalCopy.title
      body = operationalCopy.body
    }

    const fixForTaskId =
      isTaskFailure
        ? (taskById.get(entityId)?.fixForTaskId ?? null)
        : null

    // Derive the arc goal via the shared deriveArcGoal helper (same logic as the live view).
    let arcGoal: string | null = null
    if (isTaskFailure) {
      const task = taskById.get(entityId)
      if (task) {
        arcGoal = deriveArcGoal(task, taskById)
      }
    }

    // Derive the operator-facing goal (same resolution chain, richer normaliser).
    let operatorGoal: string | null = null
    if (isTaskFailure) {
      const task = taskById.get(entityId)
      if (task) {
        operatorGoal = deriveOperatorGoal(task, taskById)
      }
    }
    // Recipe-level fallback for kinds whose entity is not a task (same rule as
    // the live view builder — see the mirrored block above).
    if (operatorGoal === null && isActionQueueKind(row.kind)) {
      const _recipe = lookupRecipe(row.kind)
      if (_recipe.operatorGoal) {
        operatorGoal = _recipe.operatorGoal({
          kind: row.kind,
          entityId,
          payload: row.payload,
          context: row.context,
          title,
          body,
          raisedAt: new Date(row.raisedAt).toISOString(),
        })
      }
    }

    // Derive entity title via the kind's recipe (same rule as the live view builder).
    let entityTitle: string | null = null
    if (isActionQueueKind(row.kind)) {
      const _recipe = lookupRecipe(row.kind)
      if (_recipe.entityTitle) {
        entityTitle = _recipe.entityTitle({
          kind: row.kind,
          entityId,
          payload: row.payload,
          context: row.context,
          title,
          body,
          raisedAt: new Date(row.raisedAt).toISOString(),
        })
      }
    }

    // Build resolution metadata from the resolved row fields.
    const resolution: ActionQueueResolutionMeta | null =
      row.resolvedAt
        ? {
            resolvedAt: new Date(row.resolvedAt).toISOString(),
            resolution: row.resolution ?? null,
            resolutionNote: row.resolutionNote ?? null,
            rootCause: row.rootCause ?? null,
            resolvedBy: row.resolvedBy ?? null,
          }
        : null

    const historyRecipeFields = buildRecipeFields(row, entityId, title, body)
    // Apply the same operationalCopy humanSummary override as the live view
    // (see the matching comment in buildActionQueueView above).
    const historyHumanSummary = operationalCopy?.humanSummary ?? historyRecipeFields.humanSummary

    // Title normalisation — same rule as buildActionQueueView (HR-3, DEC-18).
    if (historyHumanSummary && operationalCopy === null && !REGISTRY_TITLED_KINDS.has(row.kind)) {
      title = historyHumanSummary
    }

    let historyItemClass: ActionQueueClass = isActionQueueKind(row.kind)
      ? classifyKind(row.kind)
      : 'decision'
    // Context-aware override — same rule as buildActionQueueView.
    if (historyItemClass === 'notice' && row.kind === 'signature-storm') {
      const stewardAttempts =
        typeof row.payload.stewardAttempts === 'number' ? row.payload.stewardAttempts : null
      if (stewardAttempts !== null) {
        historyItemClass = 'alert'
      }
    }
    const historyNoticeKey: string | null = historyItemClass === 'notice'
      ? (typeof row.payload.noticeKey === 'string'
          ? row.payload.noticeKey
          : (isActionQueueKind(row.kind) && KIND_CLASS[row.kind as ActionQueueKind] === 'notice' ? row.kind : null))
      : null

    rows.push({
      id: row.id,
      kind: uiKind,
      entityId,
      priority: toUiPriority(row.priority),
      title,
      body,
      at: new Date(row.lastSeenAt).toISOString(),
      dag,
      errorKind,
      actions: [], // Resolved rows are read-only; no actions.
      staleWorktreeDetail,
      // Resolved rows are historical: the preview server (if any) has been
      // reaped on Validate/Reject, so there is no live URL to surface.
      devServerUrl: null,
      // Resolved rows: the lease has been released, so no active lease state.
      leaseState: null,
      diagnosis,
      failureReasonCode,
      recoveryExhausted,
      fixForTaskId,
      arcGoal,
      operatorGoal,
      entityTitle,
      resolution,
      class: historyItemClass,
      noticeKey: historyNoticeKey,
      humanSummary: historyHumanSummary,
      humanDetail: historyRecipeFields.humanDetail,
      verbs: [], // Resolved rows are read-only; no action verbs.
      decisions: [], // Resolved rows are read-only; no decision buttons.
    })
  }

  return { rows, nextCursor }
}
