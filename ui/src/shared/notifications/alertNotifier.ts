import { useEffect, useRef } from 'react'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import type { ActionQueueItem } from '@/shared/schemas'
import { getNotificationsEnabled, notificationsSupported } from './notificationPrefs'

/**
 * Action-queue kinds that raise a desktop notification. The user opted into
 * "failed tasks + stale worktrees" — in the UI's projected taxonomy
 * (`ui/src/shared/schemas.ts`) that is `failed-task`/`arc-failed` (a failed
 * arc) and `stale-worktree`. `draft-proposal` and `awaiting-validation` are
 * intentionally excluded. Add a kind here to start notifying on it.
 */
export const NOTIFY_KINDS: ReadonlySet<ActionQueueItem['kind']> = new Set([
  'failed-task',
  'arc-failed',
  'stale-worktree',
])

/** Human-readable notification heading per notifiable kind. */
const KIND_TITLE: Record<string, string> = {
  'failed-task': 'Task failed',
  'arc-failed': 'Task failed',
  'stale-worktree': 'Stale worktree',
}

export interface DiffResult {
  /** Items that are newly present and notifiable since the last snapshot. */
  toNotify: ActionQueueItem[]
  /** The seen-set to carry into the next diff (ids of all current items). */
  nextSeen: Set<string>
}

/**
 * Pure core of the notifier. Given the set of item ids seen on the previous
 * tick and the current item list, returns which items to notify about and the
 * seen-set for the next tick.
 *
 * - `seed = true` (first settled load): notify nothing, just record current ids
 *   so pre-existing alerts don't storm the user on page open / SSE reconnect.
 * - otherwise: an item fires when its `kind` is notifiable AND its `id` was not
 *   in `prevSeen`. The next seen-set is exactly the current item ids, so a
 *   resolved-then-re-raised alert (same id reappearing) notifies again.
 *
 * Kept free of React and the DOM so it is unit-testable with plain arrays.
 */
export const diffNotifiable = (
  prevSeen: ReadonlySet<string>,
  items: readonly ActionQueueItem[],
  seed: boolean,
): DiffResult => {
  const nextSeen = new Set<string>()
  const toNotify: ActionQueueItem[] = []
  for (const item of items) {
    nextSeen.add(item.id)
    if (seed) continue
    if (!prevSeen.has(item.id) && NOTIFY_KINDS.has(item.kind)) {
      toNotify.push(item)
    }
  }
  return { toNotify, nextSeen }
}

const fireNotification = (item: ActionQueueItem): void => {
  const title = KIND_TITLE[item.kind] ?? 'New alert'
  try {
    const notification = new Notification(title, {
      body: item.title || item.entityId,
      tag: item.id,
    })
    notification.onclick = () => {
      window.focus()
      window.location.hash = `#/chat?item=${encodeURIComponent(item.id)}`
      notification.close()
    }
  } catch {
    // Construction can throw on some platforms even when permission is granted
    // (e.g. notifications disabled at the OS level) — swallow; nothing to do.
  }
}

/**
 * Watches the action queue and raises a browser notification when a new
 * failed-task / stale-worktree alert appears, while the tab is open. Gated on
 * the user's opt-in flag AND live `Notification.permission === 'granted'`.
 *
 * Render exactly once near the app root, inside the FocusedProjectProvider (so
 * it shares the focused-project scope). It owns no fetch of its own — it rides
 * the existing `useActionQueue` query, which the SSE invalidator keeps fresh.
 */
export const AlertNotifier = (): null => {
  const { items } = useActionQueue()
  const seenRef = useRef<Set<string>>(new Set())
  const seededRef = useRef(false)

  useEffect(() => {
    // Skip entirely until the user has opted in and the browser allows it.
    if (
      !notificationsSupported() ||
      !getNotificationsEnabled() ||
      Notification.permission !== 'granted'
    ) {
      // Re-seed so that re-enabling later doesn't replay the backlog as new.
      seededRef.current = false
      return
    }

    const { toNotify, nextSeen } = diffNotifiable(seenRef.current, items, !seededRef.current)
    seenRef.current = nextSeen
    seededRef.current = true
    for (const item of toNotify) fireNotification(item)
  }, [items])

  return null
}
