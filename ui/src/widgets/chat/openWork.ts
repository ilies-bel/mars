import { isAlertQueueItem } from './queueThreads'

import type { ActionQueueItem } from '@/shared/schemas'
import type { UITask } from '@/shared/types'

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
