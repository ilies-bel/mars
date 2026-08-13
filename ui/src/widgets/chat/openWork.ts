import { isAlertQueueItem } from './queueThreads'

import type { ActionQueueItem } from '@/shared/schemas'
import type { UITask } from '@/shared/types'

// ---------------------------------------------------------------------------
// Greeting counts helper
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES: string[] = ['running', 'verifying', 'merging', 'vega-reconciling']

export interface GreetingCounts {
  running: number
  recovering: number
  needYou: number
  doneToday: number
}

/**
 * Derives the four aggregate counts shown in the two-line greeting from data
 * already fetched for the board. No extra API calls.
 *
 * @param openWork  Result of buildRankedOpenWork — items that need operator attention.
 * @param inProgressTasks  taskSnapshot.columns.in_progress
 * @param doneTasks  taskSnapshot.columns.done
 * @param todayPrefix  ISO date prefix, e.g. "2026-08-13" — used to filter done-today.
 */
export const buildStatusCounts = (
  openWork: OpenWorkItem[],
  inProgressTasks: UITask[],
  doneTasks: UITask[],
  todayPrefix: string,
): GreetingCounts => ({
  running: inProgressTasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
  recovering: inProgressTasks.filter((t) => t.status === 'under_investigation').length,
  needYou: openWork.length,
  doneToday: doneTasks.filter((t) => t.updatedAt.startsWith(todayPrefix)).length,
})

export type OpenWorkItem =
  | {
      source: 'alert'
      id: string
      item: ActionQueueItem
      priority: number
      at: string
    }
  | {
      source: 'blocked-task'
      id: string
      task: UITask
      priority: number
      at: string
    }

export const buildRankedOpenWork = (
  queueItems: ActionQueueItem[],
  blockedTasks: UITask[],
): OpenWorkItem[] => {
  const alerts = queueItems
    .filter((item) => isAlertQueueItem(item) && item.resolution == null)
    .map((item): OpenWorkItem => ({
      source: 'alert',
      id: item.id,
      item,
      priority: item.priority === 'high' ? 3 : item.priority === 'normal' ? 2 : 1,
      at: item.at,
    }))
  const queueEntityIds = new Set(queueItems.map((item) => item.entityId))
  const blocked = blockedTasks
    .filter((task) => task.status === 'blocked' && !queueEntityIds.has(task.id))
    .map((task): OpenWorkItem => ({
      source: 'blocked-task',
      id: task.id,
      task,
      priority: task.priority,
      at: task.updatedAt,
    }))

  return [...alerts, ...blocked].sort((a, b) =>
    b.priority - a.priority || b.at.localeCompare(a.at),
  )
}
