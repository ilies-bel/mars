/**
 * Persists the user's last-selected Progress view (board | topology) in
 * localStorage so it survives page reloads and fresh sessions.
 *
 * Precedence (highest to lowest):
 *   1. Explicit ?view= param in the URL  (handled in ProgressPage / progressUrlState)
 *   2. readPersistedView()               (this module)
 *   3. DEFAULT_TAB ('topology')          (fallback)
 *
 * Both helpers guard against SSR / missing window and swallow storage errors
 * (e.g. private-mode quota exceeded) so they are safe to call unconditionally.
 */

import type { Tab } from './tabs'
import { TABS } from './tabs'

export const VIEW_PREFERENCE_KEY = 'mars.progress.view'

/**
 * Read the persisted view preference from localStorage.
 * Returns null when:
 *  - not in a browser (typeof window === 'undefined')
 *  - localStorage is unavailable or throws
 *  - stored value is absent or not a valid Tab
 */
export const readPersistedView = (): Tab | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(VIEW_PREFERENCE_KEY)
    if (raw === null) return null
    return (TABS as readonly string[]).includes(raw) ? (raw as Tab) : null
  } catch {
    return null
  }
}

/**
 * Write the view preference to localStorage.
 * No-ops safely when window/localStorage is unavailable or throws.
 */
export const writePersistedView = (view: Tab): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(VIEW_PREFERENCE_KEY, view)
  } catch {
    // Swallow storage errors (e.g. private-mode quota exceeded)
  }
}
