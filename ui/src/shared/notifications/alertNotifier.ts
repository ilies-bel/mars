import { useEffect, useRef } from 'react'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import type { ActionQueueItem } from '@/shared/schemas'
import { getNotificationsEnabled, notificationsSupported } from './notificationPrefs'

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
 * - otherwise: an item fires when its `class` is 'alert' AND its `id` was not
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
    if (!prevSeen.has(item.id) && item.class === 'alert') {
      toNotify.push(item)
    }
  }
  return { toNotify, nextSeen }
}

const fireNotification = (item: ActionQueueItem): void => {
  try {
    const notification = new Notification('Alert', {
      body: item.humanSummary || item.title || item.entityId,
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
 * alert-class item appears, while the tab is open. Gated on the user's
 * opt-in flag AND live `Notification.permission === 'granted'`.
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
