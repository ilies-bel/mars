/**
 * URL state encoding/decoding for the Progress tab's filter controls.
 *
 * Four dimensions are encoded as query parameters appended to the
 * `#/progress` hash:
 *
 *   view        'topology' (default, omitted) | 'board'
 *   q           search text (omitted when empty)
 *   proposal    proposal id to filter by (omitted when null)
 *   col         sidebar shortcut origin: 'proposals' (omitted when null)
 *
 * Example: `#/progress?view=board&q=deploy`
 * Example: `#/progress?col=proposals`  (sidebar Proposals entry shortcut)
 *
 * Default values are omitted to keep URLs clean. Absent parameters decode as
 * defaults, so a bare `#/progress` hash produces the full-default state.
 *
 * URL updates use `history.replaceState` — no hashchange event is emitted, so
 * the app-level hash router is not disturbed by filter-state updates.
 *
 * The `col=proposals` parameter serves a dual purpose:
 *   1. It tells the sidebar that the Proposals entry should be highlighted
 *      (mutually exclusive with bare Progress).
 *   2. It causes the board view to be activated on initial load (the board
 *      view is where proposal arcs surface most clearly).
 *   When the user explicitly changes the tab, `col` is cleared and the URL
 *   normalises to the selected view.
 */

import type { Tab } from './tabs'
import { DEFAULT_TAB } from './tabs'
import { safeDecode } from './routing'

export type ProgressUrlState = {
  view: Tab
  query: string
  proposal: string | null
  /** Sidebar shortcut origin — 'proposals' when navigated via the Proposals
   *  sidebar entry; null for all other Progress visits. Cleared when the
   *  user explicitly changes the view tab. */
  col: 'proposals' | null
}

/** Returns a fresh default state (new object per call — not a shared reference). */
export const defaultProgressUrlState = (): ProgressUrlState => ({
  view: DEFAULT_TAB,
  query: '',
  proposal: null,
  col: null,
})

/**
 * Encode filter state as a query string suitable for appending to `#/progress`.
 *
 * Default values are omitted so an all-default state returns `''`.
 *
 * When `col === 'proposals'` the `view` param is omitted (the sidebar
 * shortcut always activates the board view; the `col` param is sufficient
 * to imply it). This keeps URLs like `#/progress?col=proposals` clean.
 */
export const encodeProgressState = (state: ProgressUrlState): string => {
  const parts: string[] = []

  // col=proposals implies board view — skip redundant view=board when col is set.
  if (state.col === null && state.view !== DEFAULT_TAB) {
    parts.push(`view=${encodeURIComponent(state.view)}`)
  }
  if (state.query) {
    parts.push(`q=${encodeURIComponent(state.query)}`)
  }
  if (state.proposal !== null) {
    parts.push(`proposal=${encodeURIComponent(state.proposal)}`)
  }
  if (state.col !== null) {
    parts.push(`col=${encodeURIComponent(state.col)}`)
  }

  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/**
 * Decode filter state from a hash string like `#/progress?view=board&q=foo`.
 *
 * Unrecognised or missing parameters fall back to defaults.
 */
export const decodeProgressState = (hash: string): ProgressUrlState => {
  const qIdx = hash.indexOf('?')
  if (qIdx === -1) return defaultProgressUrlState()

  const queryStr = hash.slice(qIdx + 1)
  const params = new Map<string, string>()
  for (const pair of queryStr.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const key = pair.slice(0, eqIdx)
    const value = safeDecode(pair.slice(eqIdx + 1))
    // Skip pairs whose value is malformed percent-encoding — treat as absent.
    if (value === null) continue
    params.set(key, value)
  }

  const rawView = params.get('view')
  const rawCol = params.get('col')
  const col: 'proposals' | null = rawCol === 'proposals' ? 'proposals' : null

  // col=proposals implies board view (the sidebar shortcut activates the board).
  const view: Tab = rawView === 'board' ? 'board' : col !== null ? 'board' : DEFAULT_TAB

  const query = params.get('q') ?? ''

  const rawProposal = params.get('proposal')
  const proposal =
    rawProposal !== undefined && rawProposal.length > 0 ? rawProposal : null

  return { view, query, proposal, col }
}

/**
 * Encode progress filter state as additional params appended to a task hash.
 *
 * Uses `p`-prefixed names (`pView`, `pQ`, `pProposal`) to avoid collisions
 * with the task hash's own params (`from`, `step`, `kpiKey`). Default values
 * are omitted to keep URLs clean.
 *
 * Returns a `&`-prefixed string (e.g. `&pProposal=abc`) or `''` when all
 * state is at its default so the URL stays clean for a bare topology visit.
 */
export const encodeProgressStateAsTaskParams = (state: ProgressUrlState): string => {
  const parts: string[] = []
  if (state.view !== DEFAULT_TAB) {
    parts.push(`pView=${encodeURIComponent(state.view)}`)
  }
  if (state.query) {
    parts.push(`pQ=${encodeURIComponent(state.query)}`)
  }
  if (state.proposal !== null) {
    parts.push(`pProposal=${encodeURIComponent(state.proposal)}`)
  }
  return parts.length > 0 ? `&${parts.join('&')}` : ''
}

/**
 * Decode progress filter state from the `p*` params embedded in a task hash.
 *
 * Task hashes opened from the topology view carry the current progress filter
 * state as `pView`, `pQ`, and `pProposal` params so it can be restored when
 * the drawer closes (or on a page reload with the drawer open).
 *
 * Returns defaults when none of the `p*` params are present.
 */
export const decodeProgressStateFromTaskHash = (hash: string): ProgressUrlState => {
  const qIdx = hash.indexOf('?')
  if (qIdx === -1) return defaultProgressUrlState()

  const queryStr = hash.slice(qIdx + 1)
  const params = new Map<string, string>()
  for (const pair of queryStr.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const decoded = safeDecode(pair.slice(eqIdx + 1))
    // Skip pairs whose value is malformed percent-encoding — treat as absent.
    if (decoded === null) continue
    params.set(pair.slice(0, eqIdx), decoded)
  }

  const rawView = params.get('pView')
  const view: Tab = rawView === 'board' ? 'board' : DEFAULT_TAB

  const query = params.get('pQ') ?? ''

  const rawProposal = params.get('pProposal')
  const proposal =
    rawProposal !== undefined && rawProposal.length > 0 ? rawProposal : null

  // col is not encoded in task overlay params — task overlay restores the progress
  // filter state but does not restore the sidebar shortcut origin.
  return { view, query, proposal, col: null }
}

/**
 * Read the current progress filter state from the browser URL.
 * Falls back to defaults when called outside a browser (SSR, tests).
 *
 * Handles two URL shapes:
 *  - `#/progress?…` — the normal progress-page URL; decoded directly.
 *  - `#/task/<id>?from=progress&pView=…` — a task overlay opened from the
 *    progress page (e.g. after a reload with the drawer open); decoded from
 *    the embedded `p*` params.
 */
export const readProgressStateFromUrl = (): ProgressUrlState => {
  if (typeof window === 'undefined') return defaultProgressUrlState()
  const hash = window.location.hash || '#/'
  if (hash.startsWith('#/progress')) return decodeProgressState(hash)
  if (hash.startsWith('#/task/')) return decodeProgressStateFromTaskHash(hash)
  return defaultProgressUrlState()
}

/**
 * Write the current progress filter state back to the browser URL via
 * `history.replaceState`. No hashchange event is fired, so the app-level
 * hash router is not disturbed.
 * Safe to call in non-browser environments (no-ops silently).
 */
export const writeProgressStateToUrl = (state: ProgressUrlState): void => {
  if (typeof window === 'undefined' || typeof history === 'undefined') return
  const params = encodeProgressState(state)
  history.replaceState(null, '', params ? `#/progress${params}` : '#/progress')
}

/**
 * Returns the view param from the URL if it is explicitly present and valid,
 * or null otherwise.
 *
 * Unlike `decodeProgressState` (which falls back to DEFAULT_TAB when the
 * param is absent), this function distinguishes "no view param in the URL"
 * from "view=topology", so callers can fall through to a persisted preference
 * when the hash is bare.
 *
 * Returns 'board' when `col=proposals` is present (the sidebar shortcut
 * always activates the board view and takes precedence over a missing view
 * param). This ensures ProgressPage initialises into board mode when
 * navigated via the Proposals sidebar entry.
 *
 * Returns null when:
 *  - not in a browser (typeof window === 'undefined')
 *  - the hash does not start with '#/progress'
 *  - there is no '?' in the hash (no query string at all)
 *  - neither 'view' nor 'col=proposals' is present in the query string
 *  - the 'view' param value is not a recognised Tab
 */
export const readExplicitViewFromUrl = (): Tab | null => {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash || '#/'
  if (!hash.startsWith('#/progress')) return null
  const qIdx = hash.indexOf('?')
  if (qIdx === -1) return null
  const queryStr = hash.slice(qIdx + 1)
  let hasColProposals = false
  for (const pair of queryStr.split('&')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx === -1) continue
    const key = pair.slice(0, eqIdx)
    const val = safeDecode(pair.slice(eqIdx + 1))
    if (val === null) continue
    if (key === 'view') {
      return val === 'board' || val === 'topology' ? (val as Tab) : null
    }
    if (key === 'col' && val === 'proposals') {
      hasColProposals = true
    }
  }
  // col=proposals without an explicit view param → activate board view.
  return hasColProposals ? 'board' : null
}
