import { useSyncExternalStore } from 'react'

/**
 * Tiny external store + permission helpers gating the desktop-notification
 * feature. Mirrors the `sseStatus` / `openTaskId` store pattern: a module-level
 * value, a listener set, and a `useSyncExternalStore` hook — but this one also
 * persists to `localStorage` so the user's opt-in survives a reload.
 *
 * The feature is *opt-in*: the flag defaults to `false` and is only flipped on
 * by the NavBar toggle after `Notification.requestPermission()` resolves
 * `'granted'`. The diff-and-notify hook reads `getNotificationsEnabled()` (and
 * re-checks `Notification.permission` live) before firing anything.
 */

const STORAGE_KEY = 'mars.notifications.enabled'

/** True when the browser exposes the Notification API at all. */
export const notificationsSupported = (): boolean => typeof Notification !== 'undefined'

const readPersisted = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts — treat as off.
    return false
  }
}

// Seed from localStorage once at module load. If the API is unsupported we hold
// `false` regardless of any stale persisted value.
let enabled = notificationsSupported() && readPersisted()
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const l of listeners) l()
}

export const getNotificationsEnabled = (): boolean => enabled

export const setNotificationsEnabled = (value: boolean): void => {
  if (enabled === value) return
  enabled = value
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
  } catch {
    // Persist is best-effort; the in-memory flag still drives this session.
  }
  emit()
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** React hook reflecting the current enabled flag. */
export const useNotificationsEnabled = (): boolean =>
  useSyncExternalStore(subscribe, getNotificationsEnabled, () => false)

/**
 * Current browser permission, or `'unsupported'` when the API is absent.
 * Not reactive — the browser does not emit a change event for this, so callers
 * read it at decision time (toggle click, notify attempt).
 */
export const notificationPermission = (): NotificationPermission | 'unsupported' =>
  notificationsSupported() ? Notification.permission : 'unsupported'

/**
 * Prompt for permission. Resolves to the resulting permission string, or
 * `'denied'` when unsupported or when the request throws. Safe to call when
 * already granted (returns `'granted'` without re-prompting).
 */
export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (!notificationsSupported()) return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}
