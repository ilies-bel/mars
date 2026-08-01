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
import { DAEMON_KILLED_SIGNATURE } from '../../lib/retry-budget'
import {
  lookupFailureKind,
  unknownFailureKind,
  failingStepFromSignature,
  failedTaskTitle,
  isGenericFailureLabel,
} from '../../lib/failure-kinds'
import { derivedRowActions } from '../../lib/derived-row-actions'
import {
  lookupRecipe,
  getRecipeVerbs,
  type RecipeHumanDetail,
  type RecipeVerb,
} from '../../lib/action-queue-recipes'
import { isActionQueueKind, type ActionQueueKind } from '../../lib/action-queue'

/**
 * The display kind is the persisted action-queue kind. It is deliberately not
 * collapsed into a smaller UI vocabulary: operators need to distinguish the
 * condition that raised each row.
 */
export type DerivedActionQueueKind = string
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
])

/** Preserves the former failure-specific enrichment without changing labels. */
const isTaskFailureKind = (kind: string): boolean => !NON_TASK_FAILURE_KINDS.has(kind)

/** Resolution metadata carried by resolved rows in history responses. */
export interface ActionQueueResolutionMeta {
  resolvedAt: string
  resolution: string | null
  resolutionNote: string | null
  rootCause: string | null
  resolvedBy: string | null
}

export interface StaleWorktreeDetail {
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
   * The main intent of the arc that raised this action-queue item. For origin
   * failed-task rows, this is the task's own prompt (truncated to 80 chars).
   * For recovery/fix task rows, this is the origin task's prompt so the
   * operator sees what was being attempted, not just that recovery failed.
   * Null on non-task-backed rows (stale-worktree, draft-proposal, etc.) and
   * when the referenced task cannot be found.
   */
  arcGoal?: string | null
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
 */
const OPERATIONAL_ALERT_COPY: Record<
  ActionQueueKind,
  ((row: PersistedActionQueueRow) => { title: string; body: string }) | null
> = {
  failed: null,
  'steward-repeat': null,
  'cancelled-blocker-cascade': null,
  'diagnose-inconclusive': null,
  'daemon-killed': null,
  'coder-question': null,
  'daemon-died': (row) => {
    const pid = typeof row.payload.pid === 'number' ? row.payload.pid : 'unknown'
    const detectedAt =
      typeof row.payload.crashDetectedAt === 'string'
        ? row.payload.crashDetectedAt
        : new Date(row.lastSeenAt).toISOString()
    return {
      title: `Daemon pid ${pid} exited unexpectedly; restarted at ${detectedAt}`,
      body:
        `The daemon crash was detected at ${detectedAt} and the current daemon has already respawned. ` +
        `There is no task transcript for this daemon-level alert. Inspect \`.mars/watch.log\` for the crash, then run \`mars list\` to find interrupted tasks.`,
    }
  },
  'stale-worktree': null,
  'worktree-ahead': null,
  'prerequisite-failed': null,
  'draft-proposal': null,
  'slices-dropped': null,
  'hitl-slice-needs-operator': null,
  'awaiting-validation': null,
  'awaiting-validation-preview-gone': null,
  'awaiting-human': null,
  'behaviour-unverified': null,
  'subscriber-stalled': (row) => {
    const rawSubscriber =
      typeof row.payload.subscriberId === 'string'
        ? row.payload.subscriberId
        : (row.signature?.replace(/^subscriber-stalled:/, '') ?? 'unknown subscriber')
    const pidMatch = rawSubscriber.match(/^(.*):(\d+)$/)
    const subscriber = pidMatch
      ? `${pidMatch[1]} (pid ${pidMatch[2]})`
      : rawSubscriber
    const stalledFor = formatOperationalDuration(
      Math.max(0, row.lastSeenAt - row.raisedAt),
    )
    return {
      title: `Subscriber ${subscriber} is stalled for ${stalledFor}`,
      body:
        `Subscriber ${subscriber} has not advanced for ${stalledFor}. There is no task transcript for this subscriber-level alert. ` +
        `Inspect \`.mars/watch.log\` and the subscriber cursor before restarting the daemon.`,
    }
  },
  'observability-store-oversize': null,
  'orphaned-origin': null,
  'phantom-task': (row) => {
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
  'plan-approval': null,
  'done-with-unmerged-commits': null,
  'api-outage': null,
  'daemon-code-drift': null,
  'workflow-install-drift': null,
  'provider-rate-limited': null,
  'gate-broken': (row) => {
    const verdict =
      typeof row.payload.verdict === 'string'
        ? row.payload.verdict
        : (row.signature?.replace(/^gate-broken:/, '') ?? 'unknown verdict')
    const gate =
      typeof row.payload.gate === 'string'
        ? row.payload.gate
        : (verdict.match(/^verify:([^/]+)/)?.[1] ?? 'unknown')
    const streak = typeof row.payload.streak === 'number' ? ` (${row.payload.streak} tasks)` : ''
    return {
      title: `Gate ${gate} is failing with \`${verdict}\`${streak}`,
      body:
        `The ${gate} gate repeatedly produced \`${verdict}\`. Recovery is suppressed while it is broken. ` +
        `Inspect \`.mars/watch.log\`, fix or disable the gate, then restart the affected tasks.`,
    }
  },
  'workflow-draft-pending': null,
  'gate-enrichment': null,
  'budget-window': null,
  'budget-arc': null,
  'scorer-suggested': null,
  'promotion-decision': null,
  'tool-promotion': null,
  'arc-verification-failed': null,
  'signature-storm': (row) => {
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
        title: `${attempts} Steward attempts failed on \`${signature}\`; Mars has stopped auto-pausing for it`,
        body:
          `The same failure signature keeps tripping the circuit breaker and every write-capable Steward ` +
          `dispatch produced no fix. Mars will not pause dispatch for this signature again — cycling ` +
          `pause/Steward/resume against a cause the Steward cannot reach only burns worktrees. Tasks keep ` +
          `dispatching and keep failing until the shared cause is fixed. Inspect \`.mars/watch.log\` and the ` +
          `\`steward_ledger\` rows for target '${signature}'.`,
      }
    }
    return {
      title: `${streak} tasks failed with \`${signature}\`; dispatch is paused`,
      body:
        `The same failure signature is recurring across tasks, so dispatch is paused. ` +
        `There is no single task transcript for this incident. Dispatch resumes as soon as the Steward reports ` +
        `an outcome (fix, no-op, or failure), or on the bounded crash/hang fallback. ` +
        `Inspect \`.mars/watch.log\`, correct the shared cause, then inspect \`mars operator\` before resuming dispatch.`,
    }
  },
  'gate-enrichment-stale': null,
  'env-incident': null,
  'stale-queued': (row) => {
    const taskId =
      typeof row.payload.taskId === 'string' ? row.payload.taskId : (row.signature ?? 'unknown task')
    const age =
      typeof row.payload.queuedAgeMs === 'number'
        ? formatOperationalDuration(row.payload.queuedAgeMs)
        : 'an unknown duration'
    return {
      title: `Task ${taskId} has been queued for ${age}`,
      body:
        `Task ${taskId} is still queued after ${age}; inspect it with \`mars list\` and check \`.mars/watch.log\` for dispatcher decisions. ` +
        `No task transcript exists until dispatch starts.`,
    }
  },
  'stale-queued-summary': (row) => {
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
}

const renderOperationalAlertCopy = (
  row: PersistedActionQueueRow,
): { title: string; body: string } | null =>
  isActionQueueKind(row.kind) ? OPERATIONAL_ALERT_COPY[row.kind]?.(row) ?? null : null

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
   * Live lease owner for an 'awaiting-human' task. Preferred over the
   * action-queue payload snapshot because the task row is always current.
   */
  leaseOwner?: string | null
  /** ISO timestamp when the current lease was acquired. */
  leasedAt?: string | null
  /** Optional human note attached to the lease. */
  leaseNote?: string | null
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

export interface BuildActionQueueViewParams {
  stateStore: ActionQueueStateStore
  taskStore: ActionQueueTaskStore
  /** Absolute path to the repo root — used for the stale-worktree git probe. */
  repoRoot: string
  filter: DerivedActionQueueFilter
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
  if (row.kind === 'reflect-recommended') return row.signature ?? row.id
  if (row.kind === 'workflow-draft-pending') {
    if (typeof row.payload.workflowName === 'string') return row.payload.workflowName
    return row.signature ?? row.id
  }
  if (typeof row.payload.taskId === 'string') return row.payload.taskId
  if (typeof row.payload.originTaskId === 'string') return row.payload.originTaskId
  return row.signature ?? row.id
}

/**
 * Append ` [task <id8>]` to a purpose-built title when the row is backed by a
 * task and does not already name it, so two rows of the same kind stay
 * distinguishable. Non-task-backed rows (daemon-code-drift, plan-approval,
 * signature-storm) are returned untouched — their entity id is not a task id.
 */
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

const tagWithTask = (title: string, taskId: string | null): string => {
  if (taskId === null || taskId.length === 0) return title
  const short = taskId.slice(0, 8)
  return title.includes(short) ? title : `${title} [task ${short}]`
}

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
 *  - **every other kind** (daemon-code-drift, plan-approval, signature-storm,
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
  entityId: string,
): { title: string; body: string } => {
  const signature = task?.failureSignature ?? null
  const capturedError = task?.lastErrorOutput ?? ''
  const persistedIsGeneric =
    row.title.trim().length === 0 || isGenericFailureLabel(row.title)

  // Keep the raiser's copy unless it says nothing the derived copy would not.
  if (
    !REGISTRY_TITLED_KINDS.has(row.kind) ||
    (signature === null && !persistedIsGeneric)
  ) {
    return {
      title: tagWithTask(row.title, task === undefined ? null : entityId),
      body: row.body,
    }
  }

  const kind = signature !== null ? lookupFailureKind(signature) : null
  const fallbackKind =
    kind === null
      ? unknownFailureKind(failingStepFromSignature(signature), capturedError)
      : null
  return {
    title: failedTaskTitle({ signature, taskId: entityId, capturedError }),
    body:
      kind !== null
        ? kind.verboseReason
        : signature !== null
          ? `Failure signature: ${signature}.\n${fallbackKind!.verboseReason}`
          : fallbackKind!.verboseReason,
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
): { humanSummary: string; humanDetail: RecipeHumanDetail; verbs: RecipeVerb[] } => {
  const kind = row.kind
  if (!isActionQueueKind(kind)) {
    return {
      humanSummary: title || body || `Action required (kind: ${kind})`,
      humanDetail: { raisedAt: new Date(row.raisedAt).toISOString(), entityId },
      verbs: [
        { op: 'dismiss', label: 'Dismiss', style: 'default' },
        { op: 'snooze', label: 'Snooze', style: 'default' },
      ],
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
  return {
    humanSummary: recipe.humanSummary(ctx),
    humanDetail: recipe.humanDetail(ctx),
    verbs: getRecipeVerbs(recipe, ctx),
  }
}

/**
 * Derive the full ActionQueueRow[] view from injected stores.
 *
 * Behaviour mirrors ui/server/index.ts's `/api/action-queue/action-queue` handler
 * (lines 177–531 before this slice) exactly: same sort, same daemon-killed-
 * batch synthesis, same diagnose-failure gate, same stale-worktree git probe.
 */
export const buildActionQueueView = async ({
  stateStore,
  taskStore,
  repoRoot,
  filter: _filter,
}: BuildActionQueueViewParams): Promise<ActionQueueRow[]> => {
  const profileStart = performance.now()
  const persistedRows = await stateStore.listOpenActionQueueItems()
  const persistedRowsLoadedAt = performance.now()

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

  const toUiPriority = (p: string): 'high' | 'normal' | 'low' => {
    if (p === 'urgent' || p === 'high') return 'high'
    if (p === 'low') return 'low'
    return 'normal'
  }

  // 'failed' maps to 'failed-task' for backwards compat with the action registry.
  const toErrorKind = (k: string): string =>
    k === 'failed' ? 'failed-task' : k

  // Truncates a task prompt to a single line of at most 80 characters.
  // Used both by toNode (DAG summaries) and arcGoal derivation.
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

    // For failed-task rows, actions come from the FailureKind registry so
    // the title, reason, and action menu are always from the same record.
    // For stale-worktree, draft-proposal, and hitl-slice-needs-operator rows,
    // the non-failure derived-row action menu is the authority.
    let actions: { id: string; label: string; op: string }[]
    if (isTaskFailure) {
      const sig = taskById.get(entityId)?.failureSignature ?? null
      const fk =
        sig !== null
          ? (lookupFailureKind(sig) ??
            unknownFailureKind(failingStepFromSignature(sig), ''))
          : unknownFailureKind('unknown', '')
      actions = fk.actions as { id: string; label: string; op: string; needsConfirm?: boolean; hint?: string }[]
    } else {
      actions = derivedRowActions(errorKind, entityId) as {
        id: string
        label: string
        op: string
        needsConfirm?: boolean
        hint?: string
      }[]
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

    // Task-failure rows derive their title and body from the failure-kind
    // registry rather than from the persisted row strings (see failedRowCopy,
    // which decides per kind whether the registry or the raiser owns the copy).
    // Non-task kinds (hitl-slice-needs-operator, draft-proposal, …) are
    // excluded outright: their persisted copy is the only copy there is.
    let title = row.title
    let body = row.body
    if (isTaskFailure) {
      const copy = failedRowCopy(row, taskById.get(entityId), entityId)
      title = copy.title
      body = copy.body
    }

    // Operational rows are not task-failure rows, even when they name a task.
    // Their renderer owns the diagnosis and pointer instead of the FailureKind
    // fallback, which only understands a task's failure signature.
    const operationalCopy = renderOperationalAlertCopy(row)
    if (operationalCopy !== null) {
      title = operationalCopy.title
      body = operationalCopy.body
    }

    // Propagate fixForTaskId so the UI can render an "origin" link on recovery rows.
    // hitl-slice-needs-operator items are not task-backed, so no fixForTaskId.
    const fixForTaskId =
      isTaskFailure
        ? (taskById.get(entityId)?.fixForTaskId ?? null)
        : null

    // Derive the arc goal from the origin task's prompt. For recovery/fix tasks,
    // follow fixForTaskId to the origin task; for origin tasks, use their own prompt.
    // This lets the operator see what was being attempted, not just that recovery failed.
    let arcGoal: string | null = null
    if (isTaskFailure) {
      const task = taskById.get(entityId)
      if (task) {
        const originTask = task.fixForTaskId
          ? (taskById.get(task.fixForTaskId) ?? task)
          : task
        arcGoal = summarizePrompt(originTask.prompt)
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
      actions,
      staleWorktreeDetail,
      devServerUrl,
      leaseState,
      diagnosis,
      failureReasonCode,
      fixForTaskId,
      arcGoal,
      toolPromotionDetail,
      previewUrl,
      logPath,
      stallDiagnostics,
      poolSnapshot,
      humanSummary: recipeFields.humanSummary,
      humanDetail: recipeFields.humanDetail,
      verbs: recipeFields.verbs,
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
    ).filter((a) => a.op === 'restart-all-daemon-killed') as {
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
      id: 'failed-task:__daemon-killed-batch__',
      kind: 'failed-task',
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
      humanSummary: daemonKilledRecipe.humanSummary(batchRecipeCtx),
      humanDetail: daemonKilledRecipe.humanDetail(batchRecipeCtx),
      verbs: getRecipeVerbs(daemonKilledRecipe, batchRecipeCtx),
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

    // Title / body from the failure-kind registry for failed-task rows —
    // identical rule to the live view (see failedRowCopy).
    let title = row.title
    let body = row.body
    if (isTaskFailure) {
      const copy = failedRowCopy(row, taskById.get(entityId), entityId)
      title = copy.title
      body = copy.body
    }

    const operationalCopy = renderOperationalAlertCopy(row)
    if (operationalCopy !== null) {
      title = operationalCopy.title
      body = operationalCopy.body
    }

    const fixForTaskId =
      isTaskFailure
        ? (taskById.get(entityId)?.fixForTaskId ?? null)
        : null

    // Derive the arc goal from the origin task's prompt (same logic as the live view).
    let arcGoal: string | null = null
    if (isTaskFailure) {
      const task = taskById.get(entityId)
      if (task) {
        const originTask = task.fixForTaskId
          ? (taskById.get(task.fixForTaskId) ?? task)
          : task
        arcGoal = summarizePrompt(originTask.prompt)
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
      fixForTaskId,
      arcGoal,
      resolution,
      humanSummary: historyRecipeFields.humanSummary,
      humanDetail: historyRecipeFields.humanDetail,
      verbs: [], // Resolved rows are read-only; no action verbs.
    })
  }

  return { rows, nextCursor }
}
