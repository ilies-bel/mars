/**
 * URL state encoding/decoding for the chat sidebar's projection-Thread
 * filter controls (the absorbed action queue).
 *
 * Three filter dimensions are encoded as query parameters appended to the
 * `#/chat` hash:
 *
 *   item   selected action-queue item id (omitted when null)
 *   kind   'all' (default, omitted) | 'alerts' | 'drafts'
 *   q      search text (omitted when empty)
 *
 * Example: `#/chat?item=action-queue-row-id&kind=alerts`
 *
 * Default values are omitted to keep URLs clean. Absent parameters decode as
 * defaults, so a bare `#/chat` hash produces the full-default state.
 *
 * Legacy `#/action-queue` / `#/todo` deep links decode too (the App redirects
 * them onto `#/chat` preserving the query), so existing links land on the
 * right projection Thread.
 *
 * URL updates use `history.replaceState` — no hashchange event is emitted, so
 * the app-level hash router is not disturbed by filter-state updates.
 */

import type { KindFilter } from '../widgets/chat/queueThreads'

export type AqUrlState = {
  item: string | null
  kind: KindFilter
  q: string
  thread: string | null
  /** Project identifier included in shareable links so recipients land on the right project. */
  project: string | null
}

/** Returns a fresh default state (new object per call — not a shared reference). */
export const defaultAqUrlState = (): AqUrlState => ({
  item: null,
  kind: 'all',
  q: '',
  thread: null,
  project: null,
})

/**
 * Encode filter state as a query string suitable for appending to `#/chat`.
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
  if (state.thread !== null) {
    parts.push(`thread=${encodeURIComponent(state.thread)}`)
  }
  if (state.project !== null) {
    parts.push(`project=${encodeURIComponent(state.project)}`)
  }

  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/**
 * Decode filter state from a hash string like `#/chat?item=x&kind=alerts`.
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

  const rawThread = params.get('thread')
  const thread = rawThread !== undefined && rawThread.length > 0 ? rawThread : null

  const rawProject = params.get('project')
  const project = rawProject !== undefined && rawProject.length > 0 ? rawProject : null

  return { item, kind, q, thread, project }
}

/** Hash prefixes that carry projection-Thread filter state. */
const STATE_HASH_PREFIXES = ['#/chat', '#/action-queue', '#/todo']

const hasStatePrefix = (hash: string): boolean =>
  STATE_HASH_PREFIXES.some((p) => hash.startsWith(p))

/**
 * Read the current projection-Thread filter state from the browser URL.
 * Accepts the `#/chat` hash plus the legacy `#/action-queue` / `#/todo`
 * hashes (read before the App's redirect lands on `#/chat`).
 * Falls back to defaults when called outside a browser (SSR, tests).
 */
export const readAqStateFromUrl = (): AqUrlState => {
  if (typeof window === 'undefined') return defaultAqUrlState()
  const hash = window.location.hash || '#/'
  if (!hasStatePrefix(hash)) return defaultAqUrlState()
  return decodeAqState(hash)
}

/**
 * Write the current projection-Thread filter state back to the browser URL
 * via `history.replaceState`. No hashchange event is fired, so the app-level
 * hash router is not disturbed. Only writes when the current hash is a chat
 * hash (post-redirect). Safe to call in non-browser environments.
 */
export const writeAqStateToUrl = (state: AqUrlState): void => {
  if (typeof window === 'undefined' || typeof history === 'undefined') return
  const current = window.location.hash || ''
  if (!current.startsWith('#/chat')) return
  const params = encodeAqState(state)
  history.replaceState(null, '', params ? `#/chat${params}` : '#/chat')
}
