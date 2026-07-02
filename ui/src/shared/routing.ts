import type { KpiKey } from './schemas'
import type { StaleWorktreesPayload } from './schemas'

export type RouteName = 'action-queue' | 'progress' | 'events' | 'kpi'

/**
 * Derives the current route from the URL hash.
 *
 * #/progress[/…]        → progress
 * #/events[/…]          → events
 * #/kpi or #/kpi/<key>  → kpi
 * everything else       → action-queue  (default; also covers #/todo legacy)
 */
export const detectRoute = (hash: string): RouteName => {
  if (hash.startsWith('#/progress')) return 'progress'
  if (hash.startsWith('#/events')) return 'events'
  if (hash === '#/kpi' || hash.startsWith('#/kpi/')) return 'kpi'
  return 'action-queue'
}

/**
 * Returns true when `hash` matches a page route, overlay route, or the empty
 * root — i.e. the router can handle it without a redirect.
 *
 * Used by App to detect truly unknown hashes (e.g. `#/typo`) so they can be
 * redirected to `#/progress` via `history.replaceState` rather than silently
 * rendering the Action Queue under the wrong URL.
 */
export const isKnownRoute = (hash: string): boolean => {
  // Empty / root hashes → Action Queue (intentional default)
  if (hash === '' || hash === '#' || hash === '#/') return true
  // Named page routes
  if (hash.startsWith('#/action-queue')) return true
  if (hash.startsWith('#/progress')) return true
  if (hash.startsWith('#/events')) return true
  if (hash === '#/kpi' || hash.startsWith('#/kpi/')) return true
  // Overlay routes (task drawer, proposal drawers, release notes)
  if (hash.startsWith('#/task/')) return true
  if (hash.startsWith('#/proposal/')) return true
  if (hash.startsWith('#/proposal-node/')) return true
  if (hash === '#/release-notes') return true
  return false
}

/**
 * Parses an optional `#/kpi/<key>` full-page route.
 *
 * Returns the KPI key when the hash matches, or `null` otherwise.
 * Unrecognised keys normalise to `null`.
 */
export const parseKpiRoute = (hash: string): KpiKey | null => {
  const m = /^#\/kpi\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const key = decodeURIComponent(m[1]) as KpiKey
  const valid: KpiKey[] = [
    'cost_per_arc',
    'failure_rate',
    'autonomous_completion_rate',
    'recovery_success_rate',
  ]
  return valid.includes(key) ? key : null
}

/**
 * Builds a `#/kpi/<key>` hash for navigating to the KPI detail page.
 */
export const kpiHash = (key: KpiKey): string => `#/kpi/${encodeURIComponent(key)}`

/**
 * Parses an optional `#/task/<id>` overlay route. The task drawer is layered
 * on top of whatever the underlying `detectRoute(...)` route resolves to —
 * Progress or otherwise — so this function returns the id alone (or `null`
 * when the hash carries no task fragment).
 *
 * Trailing slashes and empty ids are normalised to `null` so a stray
 * `#/task/` never opens an empty drawer.
 */
export const parseTaskRoute = (hash: string): string | null => {
  const m = /^#\/task\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return id.length > 0 ? id : null
}

const ROUTE_NAMES: readonly RouteName[] = [
  'action-queue',
  'progress',
  'events',
  'kpi',
]

const isRouteName = (value: string): value is RouteName =>
  (ROUTE_NAMES as readonly string[]).includes(value)

/**
 * Reads the origin page encoded in a `#/task/<id>?from=<route>` hash.
 *
 * The `from` query param records which page the task drawer was opened from so
 * that closing the drawer can return there (the Action queue, say) instead of
 * always snapping back to Progress. Returns the matching `RouteName`, or `null`
 * when the hash carries no `from`, an empty value, or an unrecognised route.
 *
 * Parsing is intentionally simple string-splitting — no `URL`/`URLSearchParams`
 * polyfill — to match the rest of this file and stay framework-free.
 */
export const parseTaskOrigin = (hash: string): RouteName | null => {
  if (parseTaskRoute(hash) === null) return null
  const queryIndex = hash.indexOf('?')
  if (queryIndex === -1) return null
  const query = hash.slice(queryIndex + 1)
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq) !== 'from') continue
    const value = decodeURIComponent(pair.slice(eq + 1))
    return isRouteName(value) ? value : null
  }
  return null
}

/**
 * Builds a task overlay hash, optionally tagging the origin page so the drawer
 * knows where to return on close. `taskHash('x')` → `#/task/x` (origin
 * defaults to Progress); `taskHash('x', 'action-queue')` →
 * `#/task/x?from=action-queue`.
 *
 * Pass an optional `step` (a step name such as `'code'`) to encode the active
 * step into the hash so the drawer can highlight the matching step row on open:
 * `taskHash('x', 'events', 'code')` → `#/task/x?from=events&step=code`.
 */
export const taskHash = (id: string, from?: RouteName, step?: string): string => {
  const base = `#/task/${encodeURIComponent(id)}`
  const params: string[] = []
  if (from) params.push(`from=${from}`)
  if (step) params.push(`step=${encodeURIComponent(step)}`)
  return params.length > 0 ? `${base}?${params.join('&')}` : base
}

/**
 * Reads the active step name encoded in a `#/task/<id>?…&step=<name>` hash.
 *
 * Returns the decoded step name, or `null` when the hash carries no `step`
 * param or carries an empty one. Parsing mirrors `parseTaskOrigin` — plain
 * string-splitting, no `URLSearchParams`.
 */
export const parseTaskStep = (hash: string): string | null => {
  if (parseTaskRoute(hash) === null) return null
  const queryIndex = hash.indexOf('?')
  if (queryIndex === -1) return null
  const query = hash.slice(queryIndex + 1)
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq) !== 'step') continue
    const value = decodeURIComponent(pair.slice(eq + 1))
    return value.length > 0 ? value : null
  }
  return null
}

/**
 * Builds a proposal overlay hash. `proposalHash('x')` → `#/proposal/x`.
 * Mirrors `taskHash` for the proposal routing shape.
 */
export const proposalHash = (id: string): string =>
  `#/proposal/${encodeURIComponent(id)}`

/**
 * Parses an optional `#/proposal/<id>` overlay route. Proposal rows route here
 * instead of `#/task/<id>` so the App can render the proposal drawer while task
 * rows keep opening the task drawer unchanged.
 *
 * Mirrors `parseTaskRoute`: trailing slashes and empty ids normalise to `null`.
 */
export const parseProposalRoute = (hash: string): string | null => {
  const m = /^#\/proposal\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return id.length > 0 ? id : null
}

/**
 * Parses an optional `#/proposal-node/<id>` overlay route.  Proposal nodes on
 * the DAG canvas navigate here so the ProposalNodeDrawer opens instead of the
 * generic ProposalDetailDrawer (which is used for action-queue proposals).
 *
 * Mirrors `parseTaskRoute`: trailing slashes and empty ids normalise to `null`.
 */
export const parseProposalNodeRoute = (hash: string): string | null => {
  const m = /^#\/proposal-node\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return id.length > 0 ? id : null
}

/**
 * Returns the constant `#/release-notes` hash for the Release Notes overlay.
 */
export const releaseNotesHash = (): string => '#/release-notes'

/**
 * Returns true when the hash matches the `#/release-notes` overlay route.
 *
 * The release-notes drawer is an overlay on top of the Progress page —
 * closing it returns to `#/progress`, mirroring the proposal overlay.
 */
export const parseReleaseNotesRoute = (hash: string): boolean =>
  hash === '#/release-notes'

/**
 * Badge count for the Action queue nav entry — stale worktrees only.
 * Drafts are surfaced inline in the Action queue and must not appear here.
 */
export const actionQueueCount = (payload: StaleWorktreesPayload): number =>
  payload.staleWorktrees.length

/**
 * Resolves the page route that should render beneath a potential overlay.
 *
 * A task overlay hash (`#/task/<id>`) keeps a page mounted beneath the drawer:
 *
 * - `#/task/<id>?from=<route>` resolves to THAT `<route>` — so opening the
 *   drawer from the Action queue (`?from=action-queue`) leaves the Action
 *   queue list mounted behind it, and closing returns there.
 * - `#/task/<id>` with no `from` resolves to 'progress' (today's behaviour),
 *   preserving the operator's Progress view state (active tab, cluster
 *   toggles, recency slider) across the drawer's open/close cycle.
 *
 * Proposal overlay hashes (`#/proposal/<id>`) always force 'progress'
 * (proposals are out of scope for the `from` mechanism).
 *
 * Use this instead of `detectRoute` as the single source of truth in the App.
 */
export const resolvePageRoute = (hash: string): RouteName => {
  const taskId = parseTaskRoute(hash)
  if (taskId !== null && hash.startsWith('#/task/')) {
    return parseTaskOrigin(hash) ?? 'progress'
  }
  const proposalId = parseProposalRoute(hash)
  if (proposalId !== null && hash.startsWith('#/proposal/')) {
    return 'progress'
  }
  const proposalNodeId = parseProposalNodeRoute(hash)
  if (proposalNodeId !== null) {
    return 'progress'
  }
  if (parseReleaseNotesRoute(hash)) {
    return 'progress'
  }
  const kpiKey = parseKpiRoute(hash)
  if (kpiKey !== null) {
    return 'kpi'
  }
  return detectRoute(hash)
}
