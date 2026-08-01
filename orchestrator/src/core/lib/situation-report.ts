/**
 * Deterministic opening narration for a Subthread. Its collaborators are reads
 * from the daemon's current stores, deliberately keeping this path outside the
 * paid chat runner/provider boundary.
 */

export interface SituationTask {
  status: string
}

export interface SituationSemaphoreSnapshot {
  inUse: number
  limit: number
}

export interface SituationReportSources {
  listTasks: () => Promise<readonly SituationTask[]>
  getSemaphoreSnapshot: () => SituationSemaphoreSnapshot
  listActionQueue: () => Promise<readonly unknown[]>
}

const taskCount = (tasks: readonly SituationTask[], status: string): number =>
  tasks.filter((task) => task.status === status).length

const plural = (count: number, singular: string, pluralNoun = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralNoun}`

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

  return `Situation: ${plural(queued, 'queued task')}, ${plural(running, 'running task')}, ${plural(blocked, 'blocked task')}, and ${plural(failed, 'failed task')}. Workers: ${workers.inUse} of ${workers.limit} active. ${plural(actionQueue.length, 'item', 'items')} need attention.`
}
