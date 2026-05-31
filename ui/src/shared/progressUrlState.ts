/**
 * URL state encoding/decoding for the Progress tab's filter controls.
 *
 * Five filter dimensions are encoded as query parameters appended to the
 * `#/progress` hash:
 *
 *   view        'topology' (default, omitted) | 'board'
 *   q           search text (omitted when empty)
 *   proposal    proposal id to filter by (omitted when null)
 *   clusters    comma-separated list of active ClusterToggle values
 *               (omitted when all four are active — the default)
 *   recency     '1h' | '6h' | '24h' (default, omitted) | '7d' | '30d' | 'all'
 *
 * Example: `#/progress?view=board&q=deploy&clusters=Proposal,Blocked&recency=7d`
 *
 * Default values are omitted to keep URLs clean. Absent parameters decode as
 * defaults, so a bare `#/progress` hash produces the full-default state.
 *
 * URL updates use `history.replaceState` — no hashchange event is emitted, so
 * the app-level hash router is not disturbed by filter-state updates.
 */

import type { Tab } from './tabs'
import { DEFAULT_TAB } from './tabs'
import type { ClusterToggle } from '@/widgets/ClusterToggleBar'
import { ALL_CLUSTER_TOGGLES } from '@/widgets/ClusterToggleBar'
import type { RecencyStop } from './recencyStop'
import { RECENCY_STOP_DEFAULT, RECENCY_STOPS } from './recencyStop'

export type ProgressUrlState = {
  view: Tab
  query: string
  proposal: string | null
  clusters: Set<ClusterToggle>
  recency: RecencyStop
}

/** Returns a fresh default state (new Set per call — not a shared reference). */
export const defaultProgressUrlState = (): ProgressUrlState => ({
  view: DEFAULT_TAB,
  query: '',
  proposal: null,
  clusters: new Set(ALL_CLUSTER_TOGGLES),
  recency: RECENCY_STOP_DEFAULT,
})

/**
 * Encode filter state as a query string suitable for appending to `#/progress`.
 *
 * Default values are omitted so an all-default state returns `''`.
 */
export const encodeProgressState = (state: ProgressUrlState): string => {
  const parts: string[] = []

  if (state.view !== DEFAULT_TAB) {
    parts.push(`view=${encodeURIComponent(state.view)}`)
  }
  if (state.query) {
    parts.push(`q=${encodeURIComponent(state.query)}`)
  }
  if (state.proposal !== null) {
    parts.push(`proposal=${encodeURIComponent(state.proposal)}`)
  }

  // Include the clusters param only when NOT all four toggles are active.
  // This lets a bare `#/progress` mean "default = all active".
  const activeList = ALL_CLUSTER_TOGGLES.filter((c) => state.clusters.has(c))
  if (activeList.length !== ALL_CLUSTER_TOGGLES.length) {
    parts.push(`clusters=${activeList.map(encodeURIComponent).join(',')}`)
  }

  if (state.recency !== RECENCY_STOP_DEFAULT) {
    parts.push(`recency=${encodeURIComponent(state.recency)}`)
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
    const value = decodeURIComponent(pair.slice(eqIdx + 1))
    params.set(key, value)
  }

  const rawView = params.get('view')
  const view: Tab = rawView === 'board' ? 'board' : DEFAULT_TAB

  const query = params.get('q') ?? ''

  const rawProposal = params.get('proposal')
  const proposal =
    rawProposal !== undefined && rawProposal.length > 0 ? rawProposal : null

  let clusters: Set<ClusterToggle>
  if (params.has('clusters')) {
    const raw = params.get('clusters') ?? ''
    clusters = new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is ClusterToggle =>
          (ALL_CLUSTER_TOGGLES as readonly string[]).includes(s),
        ),
    )
  } else {
    clusters = new Set(ALL_CLUSTER_TOGGLES)
  }

  const rawRecency = params.get('recency')
  const recency: RecencyStop =
    rawRecency !== undefined &&
    (RECENCY_STOPS as readonly string[]).includes(rawRecency)
      ? (rawRecency as RecencyStop)
      : RECENCY_STOP_DEFAULT

  return { view, query, proposal, clusters, recency }
}

/**
 * Read the current progress filter state from the browser URL.
 * Falls back to defaults when called outside a browser (SSR, tests).
 */
export const readProgressStateFromUrl = (): ProgressUrlState => {
  if (typeof window === 'undefined') return defaultProgressUrlState()
  const hash = window.location.hash || '#/'
  if (!hash.startsWith('#/progress')) return defaultProgressUrlState()
  return decodeProgressState(hash)
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
