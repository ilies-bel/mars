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

export interface SituationReportSources {
  listTasks: () => Promise<readonly SituationTask[]>
  getSemaphoreSnapshot: () => SituationSemaphoreSnapshot
  listActionQueue: () => Promise<readonly { kind?: string }[]>
}

const taskCount = (tasks: readonly SituationTask[], status: string): number =>
  tasks.filter((task) => task.status === status).length

const plural = (count: number, singular: string, pluralNoun = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralNoun}`

/**
 * The single canonical "needs you" count: open action-queue items excluding
 * draft-proposal rows (a backlog of shaped ideas, not an operational alert
 * needing immediate action). Every UI surface that renders this concept
 * (the triage badge, the sidebar badge, the chat greeting, the situation
 * card) must derive from this same definition — see the fix for the
 * "four different counts" bug for the full rationale.
 */
export const countNeedsYou = (actionQueue: readonly { kind?: string }[]): number =>
  actionQueue.filter((item) => item.kind !== 'draft-proposal').length

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
  return `Situation: ${plural(queued, 'queued task')}, ${plural(running, 'running task')}, ${plural(blocked, 'blocked task')}, and ${plural(failed, 'failed task')}. Workers: ${workers.inUse} of ${workers.limit} active. ${plural(actionableCount, 'item', 'items')} need attention.`
}
