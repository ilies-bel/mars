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
  /**
   * True when the row this thread was opened about is no longer live and
   * nothing has superseded it — the thread is about something that is over.
   * FocusPanel must mark it, never present it as current state.
   */
  stale: boolean
}

export const useThreadFocus = (thread?: ChatThread): ThreadFocusResult => {
  const { items: activeItems } = useActionQueue()
  const { items: historyItems } = useActionQueueHistory()
  const { tasks } = useProgress()

  if (!thread?.alertItemId) {
    return { kind: 'none', entity: null, sourceLabel: '', stale: false }
  }

  // Prefer the LIVE row, then fall back to history.
  //
  // Condition kinds are derived on read (ADR-0057) and their ids are computed
  // from the state they describe, so a condition that changes gets a NEW id and
  // the old one survives only in history. A thread pinned to the old id then
  // resolved to a closed snapshot — FOCUS, the panel that answers "what am I
  // looking at right now", rendered "5 commits behind — f3f7fa8 → 8ed338d"
  // while the ALERTS block directly beneath it, in the same rail, read "1
  // commit behind — 905f571 → 68d9032".
  //
  // So when the pinned row is gone from the live queue, look for the row that
  // SUPERSEDED it: same kind, same subject, currently open. That is the same
  // condition, re-derived. Only when there is no such row is the thread really
  // about something that is over, and then `stale` says so rather than letting
  // a frozen title pose as current state.
  const liveItem = activeItems.find((i) => i.id === thread.alertItemId)
  const pinned = liveItem ?? historyItems.find((i) => i.id === thread.alertItemId)
  if (!pinned) {
    return { kind: 'none', entity: null, sourceLabel: '', stale: false }
  }
  const successor =
    liveItem === undefined
      ? activeItems.find((i) => i.kind === pinned.kind && i.entityId === pinned.entityId)
      : undefined
  const item = successor ?? pinned
  const stale = liveItem === undefined && successor === undefined

  if (item.kind === 'draft-proposal') {
    return { kind: 'proposal', entity: item, sourceLabel: 'proposal', stale }
  }

  if (isTaskFailureActionQueueKind(item.kind) || item.kind === 'arc-failed') {
    const task = tasks?.find((t) => t.id === item.entityId) ?? null
    if (task) {
      return { kind: 'task', entity: task, sourceLabel: 'task', stale }
    }
  }

  return { kind: 'alert', entity: item, sourceLabel: kindBadgeLabel(item.kind), stale }
}
