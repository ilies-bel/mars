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
  listActionQueue: () => Promise<readonly { kind?: string; entityId?: string }[]>
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
 * Kinds that are per-TASK conditions which can co-occur for the same task
 * (ADR-0057 condition kinds are derived independently, with no
 * reconciliation between them, so one failed task can raise several open
 * rows at once). Manually mirrors the UI's `taskFailureKinds` (in
 * ui/src/shared/schemas.ts) plus `recovery-abandoned` (which is deliberately
 * absent from that list — see clusterRows.ts's EXTRA_GROUPABLE_CONDITION_KINDS
 * for why) — the same duplication pattern that list itself already uses to
 * mirror the daemon's own classification. Kept in lockstep by hand, not by
 * import, because the UI and orchestrator are separate packages.
 */
const GROUPABLE_CONDITION_KINDS: ReadonlySet<string> = new Set([
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
 * draft-proposal rows (a backlog of shaped ideas, not an operational alert
 * needing immediate action). Every UI surface that renders this concept
 * (the triage badge, the sidebar badge, the chat greeting, the situation
 * card) must derive from this same definition — see the fix for the
 * "four different counts" bug for the full rationale.
 *
 * Several condition kinds (failed, recovery-abandoned, gate-broken, …) can
 * derive independently for the SAME task, so a naive item count would report
 * one failed task as several items. This dedups those onto one, mirroring
 * `countNeedsYou` in ui/src/entities/actionQueue/clusterRows.ts.
 */
export const countNeedsYou = (
  actionQueue: readonly { kind?: string; entityId?: string }[],
): number => {
  const seenEntities = new Set<string>()
  let count = 0
  for (const item of actionQueue) {
    if (item.kind === 'draft-proposal') continue
    if (item.entityId && item.kind && GROUPABLE_CONDITION_KINDS.has(item.kind)) {
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
