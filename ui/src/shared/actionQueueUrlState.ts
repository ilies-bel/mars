/**
 * URL state encoding/decoding for the Action Queue page's filter controls.
 *
 * Three filter dimensions are encoded as query parameters appended to the
 * `#/action-queue` hash:
 *
 *   item   selected item id (omitted when null)
 *   kind   'all' (default, omitted) | 'alerts' | 'drafts'
 *   q      search text (omitted when empty)
 *
 * Example: `#/action-queue?item=failed-task%3At-1&kind=alerts`
 *
 * Default values are omitted to keep URLs clean. Absent parameters decode as
 * defaults, so a bare `#/action-queue` hash produces the full-default state.
 *
 * URL updates use `history.replaceState` — no hashchange event is emitted, so
 * the app-level hash router is not disturbed by filter-state updates.
 */

import type { KindFilter } from '../pages/ActionQueuePage'

export type AqUrlState = {
  item: string | null
  kind: KindFilter
  q: string
}

/** Returns a fresh default state (new object per call — not a shared reference). */
export const defaultAqUrlState = (): AqUrlState => ({
  item: null,
  kind: 'all',
  q: '',
})

/**
 * Encode filter state as a query string suitable for appending to `#/action-queue`.
 * Default values are omitted so an all-default state returns `''`.
 */
export const encodeAqState = (state: AqUrlState): string => {
  const parts: string[] = []

  if (state.item !== null) {
    parts.push(`item=${encodeURIComponent(state.item)}`)
  }
  if (state.kind !== 'all') {
    parts.push(`kind=${encodeURIComponent(state.kind)}`)
  }
  if (state.q) {
    parts.push(`q=${encodeURIComponent(state.q)}`)
  }

  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/**
 * Decode filter state from a hash string like `#/action-queue?item=x&kind=alerts`.
 * Unrecognised or missing parameters fall back to defaults.
 */
export const decodeAqState = (hash: string): AqUrlState => {
  const qIdx = hash.indexOf('?')
  if (qIdx === -1) return defaultAqUrlState()

  const queryStr = hash.slice(qIdx + 1)
  const params = new Map<string, string>()
  for (const pair of queryStr.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const key = pair.slice(0, eqIdx)
    const value = decodeURIComponent(pair.slice(eqIdx + 1))
    params.set(key, value)
  }

  const rawItem = params.get('item')
  const item = rawItem !== undefined && rawItem.length > 0 ? rawItem : null

  const rawKind = params.get('kind')
  const kind: KindFilter =
    rawKind === 'alerts' || rawKind === 'drafts' ? rawKind : 'all'

  const q = params.get('q') ?? ''

  return { item, kind, q }
}

/**
 * Read the current action-queue filter state from the browser URL.
 * Falls back to defaults when called outside a browser (SSR, tests).
 */
export const readAqStateFromUrl = (): AqUrlState => {
  if (typeof window === 'undefined') return defaultAqUrlState()
  const hash = window.location.hash || '#/'
  if (!hash.startsWith('#/action-queue')) return defaultAqUrlState()
  return decodeAqState(hash)
}

/**
 * Write the current action-queue filter state back to the browser URL via
 * `history.replaceState`. No hashchange event is fired, so the app-level
 * hash router is not disturbed.
 * Safe to call in non-browser environments (no-ops silently).
 */
export const writeAqStateToUrl = (state: AqUrlState): void => {
  if (typeof window === 'undefined' || typeof history === 'undefined') return
  const current = window.location.hash || ''
  if (!current.startsWith('#/action-queue')) return
  const params = encodeAqState(state)
  history.replaceState(null, '', params ? `#/action-queue${params}` : '#/action-queue')
}
