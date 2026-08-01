/**
 * useThreadFocus — resolves the entity (ActionQueueItem or ProgressTask) linked
 * to the active chat thread so FocusPanel can render a kind badge + status.
 *
 * Resolution rules:
 *   1. If thread has no alertItemId → kind='none'.
 *   2. Look up alertItemId in the live action-queue then history.
 *   3. For draft-proposal items → kind='proposal', entity=ActionQueueItem.
 *   4. For task-failure kinds and arc-failed rows → cross-
 *      look up ProgressTask via item.entityId; kind='task', entity=ProgressTask.
 *      If the task isn't found in progress data, fall back to kind='alert'.
 *   5. All other action-queue kinds → kind='alert', entity=ActionQueueItem.
 */

import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useActionQueueHistory } from '@/entities/actionQueue/useActionQueueHistory'
import { useProgress } from '@/hooks/useProgress'
import { kindBadgeLabel } from '@/shared/actionQueueDetail'
import {
  isTaskFailureActionQueueKind,
  type ActionQueueItem,
  type ChatThread,
  type ProgressTask,
} from '@/shared/schemas'

export interface ThreadFocusResult {
  kind: 'alert' | 'task' | 'proposal' | 'none'
  entity: ActionQueueItem | ProgressTask | null
  sourceLabel: string
}

export const useThreadFocus = (thread?: ChatThread): ThreadFocusResult => {
  const { items: activeItems } = useActionQueue()
  const { items: historyItems } = useActionQueueHistory()
  const { tasks } = useProgress()

  if (!thread?.alertItemId) {
    return { kind: 'none', entity: null, sourceLabel: '' }
  }

  const item = [...activeItems, ...historyItems].find((i) => i.id === thread.alertItemId)
  if (!item) {
    return { kind: 'none', entity: null, sourceLabel: '' }
  }

  if (item.kind === 'draft-proposal') {
    return { kind: 'proposal', entity: item, sourceLabel: 'proposal' }
  }

  if (isTaskFailureActionQueueKind(item.kind) || item.kind === 'arc-failed') {
    const task = tasks?.find((t) => t.id === item.entityId) ?? null
    if (task) {
      return { kind: 'task', entity: task, sourceLabel: 'task' }
    }
  }

  return { kind: 'alert', entity: item, sourceLabel: kindBadgeLabel(item.kind) }
}
