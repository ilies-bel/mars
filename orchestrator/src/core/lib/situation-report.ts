/**
 * Deterministic opening narration for a Subthread. Its collaborators are reads
 * from the daemon's current stores, deliberately keeping this path outside the
 * paid chat runner/provider boundary.
 */

interface SituationTask {
  status: string
}

export interface SituationSemaphoreSnapshot {
  inUse: number
  limit: number
}

export interface SituationDispatchState {
  paused: boolean
  reason: 'operator' | 'storm' | 'quota' | 'baseline' | null
}

export interface SituationReportSources {
  listTasks: () => Promise<readonly SituationTask[]>
  getSemaphoreSnapshot: () => SituationSemaphoreSnapshot
  listActionQueue: () => Promise<readonly { kind?: string; entityId?: string; class?: string }[]>
  /**
   * Dispatch pause state. Optional so existing callers keep working; when
   * absent the report simply omits the pause clause.
   */
  getDispatchState?: () => SituationDispatchState
}

const PAUSE_REASON_LABEL: Record<
  NonNullable<SituationDispatchState['reason']>,
  string
> = {
  operator: 'paused by the operator',
  storm: 'paused by the signature-storm breaker',
  quota: 'paused by a provider quota rejection',
  baseline: 'paused by a broken baseline',
}

const taskCount = (tasks: readonly SituationTask[], status: string): number =>
  tasks.filter((task) => task.status === status).length

const plural = (count: number, singular: string, pluralNoun = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralNoun}`

/**
 * Kinds that are per-TASK and can co-occur for the same task (ADR-0057
 * derived kinds are computed independently, with no reconciliation between
 * them, so one failed task can raise several open rows at once). Manually
 * mirrors the UI's `taskFailureKinds` (in ui/src/shared/schemas.ts), which
 * itself mirrors this file's own `NON_TASK_FAILURE_KINDS` complement (in
 * `orchestrator/src/core/daemon/view/action-queue.ts`) — including
 * `recovery-abandoned`, which the UI mirror omitted until that drift was
 * fixed. Kept in lockstep by hand, not by import, because the UI and
 * orchestrator are separate packages.
 */
const GROUPABLE_DERIVED_KINDS: ReadonlySet<string> = new Set([
  'failed',
  'steward-repeat',
  'cancelled-blocker-cascade',
  'diagnose-inconclusive',
  'daemon-killed',
  'coder-question',
  'daemon-died',
  'worktree-ahead',
  'prerequisite-failed',
  'slices-dropped',
  'behaviour-unverified',
  'subscriber-stalled',
  'observability-store-oversize',
  'orphaned-origin',
  'phantom-task',
  'outbox-lag',
  'done-with-unmerged-commits',
  'api-outage',
  'daemon-code-drift',
  'workflow-install-drift',
  'provider-rate-limited',
  'gate-broken',
  'gate-enrichment',
  'budget-window',
  'budget-arc',
  'promotion-decision',
  'arc-verification-failed',
  'signature-storm',
  'gate-enrichment-stale',
  'env-incident',
  'stale-queued',
  'stale-queued-summary',
  'spend-control-notice',
  'scheduling-decision',
  'requeue-warning',
  'recovery-abandoned',
])

/**
 * The single canonical "needs you" count: distinct open subjects excluding
 * two classes of row the operator does not need to act on:
 *
 *  1. `draft-proposal` rows — a backlog of shaped ideas, not operational alerts.
 *  2. Any row whose `class === 'notice'` — informational by construction;
 *     Mars handles these itself and their copy says so ("no action needed").
 *     A notice CAN be promoted to `class: 'alert'` by `action-queue.ts` under
 *     certain conditions (e.g. a signature-storm that trips the breaker), in
 *     which case it IS counted — we use the row's own `class`, not a kind list,
 *     so a promoted notice is counted and a demoted alert is skipped correctly.
 *
 * Every UI surface that renders this concept (the triage badge, the sidebar
 * badge, the chat greeting, the situation card) must derive from this same
 * definition — see the fix for the "four different counts" bug for the full
 * rationale. Mirrored client-side by `countNeedsYou` in
 * ui/src/entities/actionQueue/clusterRows.ts; both exclusions must match.
 *
 * Several condition kinds (failed, recovery-abandoned, gate-broken, …) can
 * derive independently for the SAME task, so a naive item count would report
 * one failed task as several items. This dedups those onto one.
 */
export const countNeedsYou = (
  actionQueue: readonly { kind?: string; entityId?: string; class?: string }[],
): number => {
  const seenEntities = new Set<string>()
  let count = 0
  for (const item of actionQueue) {
    if (item.kind === 'draft-proposal') continue
    if (item.class === 'notice') continue
    if (item.entityId && item.kind && GROUPABLE_DERIVED_KINDS.has(item.kind)) {
      if (seenEntities.has(item.entityId)) continue
      seenEntities.add(item.entityId)
    }
    count++
  }
  return count
}

/** Read current stored state and render the first, zero-token Subthread message. */
export const buildSituationReport = async (
  sources: SituationReportSources,
): Promise<string> => {
  const [tasks, actionQueue] = await Promise.all([
    sources.listTasks(),
    sources.listActionQueue(),
  ])
  const workers = sources.getSemaphoreSnapshot()
  const queued = taskCount(tasks, 'queued')
  const running = taskCount(tasks, 'running')
  const blocked = taskCount(tasks, 'blocked')
  const failed = taskCount(tasks, 'failed')

  const actionableCount = countNeedsYou(actionQueue)

  // A pause is the reason every counter above may read zero, so say it rather
  // than leaving the reader to infer "idle and healthy" from "0 running".
  const dispatch = sources.getDispatchState?.()
  const pauseClause =
    dispatch?.paused === true
      ? ` Dispatch is ${dispatch.reason ? PAUSE_REASON_LABEL[dispatch.reason] : 'paused'} — no new work is being dispatched.`
      : ''

  return `Situation: ${plural(queued, 'queued task')}, ${plural(running, 'running task')}, ${plural(blocked, 'blocked task')}, and ${plural(failed, 'failed task')}. Workers: ${workers.inUse} of ${workers.limit} active. ${plural(actionableCount, 'item', 'items')} need attention.${pauseClause}`
}
