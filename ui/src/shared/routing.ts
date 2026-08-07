import type { KpiKey } from './schemas'
import type { StaleWorktreesPayload } from './schemas'
import { PRIMITIVE_NAMES, type PrimitiveName } from '@/entities/primitive/types'

export type RouteName = 'progress' | 'events' | 'kpi' | 'studio' | 'chat' | 'steward' | 'reflections'

/**
 * Derives the current route from the URL hash.
 *
 * (empty / root)        → chat  (default landing page)
 * #/chat[/…]            → chat
 * #/progress[/…]        → progress
 * #/events[/…]          → events
 * #/kpi or #/kpi/<key>  → kpi
 * #/studio/<taskId>     → studio
 * everything else       → chat  (also covers the legacy #/action-queue and
 *                                #/todo hashes — the chat page absorbed the
 *                                action queue as projection Threads)
 */
export const detectRoute = (hash: string): RouteName => {
  if (hash === '' || hash === '#' || hash === '#/') return 'chat'
  if (hash.startsWith('#/chat')) return 'chat'
  if (hash.startsWith('#/progress')) return 'progress'
  if (hash.startsWith('#/events')) return 'events'
  if (hash === '#/kpi' || hash.startsWith('#/kpi/')) return 'kpi'
  if (parseStudioRoute(hash) !== null) return 'studio'
  if (hash === '#/steward') return 'steward'
  if (hash.startsWith('#/reflections')) return 'reflections'
  return 'chat'
}

/**
 * Returns true when `hash` matches a page route, overlay route, or the empty
 * root — i.e. the router can handle it without a redirect.
 *
 * Used by App to detect truly unknown hashes (e.g. `#/typo`) so they can be
 * redirected to `#/chat` via `history.replaceState` rather than silently
 * rendering the wrong page.
 */
export const isKnownRoute = (hash: string): boolean => {
  // Empty / root hashes → Chat (the default landing page)
  if (hash === '' || hash === '#' || hash === '#/') return true
  // Named page routes
  if (hash.startsWith('#/chat')) return true
  // Legacy action-queue hashes — the App redirects them onto #/chat.
  if (hash.startsWith('#/action-queue')) return true
  if (hash.startsWith('#/todo')) return true
  if (hash.startsWith('#/progress')) return true
  if (hash.startsWith('#/events')) return true
  if (hash === '#/kpi' || hash.startsWith('#/kpi/')) return true
  // Studio requires a non-empty task id — a bare `#/studio/` redirects.
  if (parseStudioRoute(hash) !== null) return true
  if (hash === '#/steward') return true
  if (hash.startsWith('#/reflections')) return true
  // Overlay routes (task drawer, proposal drawers, primitive drawer,
  // release notes, shortcuts)
  if (hash.startsWith('#/task/')) return true
  if (hash.startsWith('#/proposal/')) return true
  if (hash.startsWith('#/proposal-node/')) return true
  // Primitive requires one of the six known names — `#/primitive/typo` redirects.
  if (parsePrimitiveRoute(hash) !== null) return true
  if (hash === '#/release-notes') return true
  if (hash === '#/shortcuts') return true
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
 * Parses the `#/studio/<taskId>` full-page route — Studio, the live
 * per-instance step execution tree for one task's workflow runs.
 *
 * Returns the decoded task id, or `null` when the hash is not a Studio route.
 * Mirrors `parseTaskRoute`: trailing slashes and empty ids normalise to
 * `null` so a stray `#/studio/` never opens an empty page.
 */
export const parseStudioRoute = (hash: string): string | null => {
  const m = /^#\/studio\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return id.length > 0 ? id : null
}

/**
 * Builds a `#/studio/<taskId>` hash for navigating to the Studio page.
 */
export const studioHash = (taskId: string): string =>
  `#/studio/${encodeURIComponent(taskId)}`

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
  'progress',
  'events',
  'kpi',
  'studio',
  'chat',
  'steward',
  'reflections',
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
 *
 * When opening from a KPI detail page, pass `from='kpi'` and the KPI key so
 * the drawer can return to the exact detail page on close:
 * `taskHash('x', 'kpi', undefined, 'failure_rate')` →
 * `#/task/x?from=kpi&kpiKey=failure_rate`.
 */
export const taskHash = (id: string, from?: RouteName, step?: string, kpiKey?: KpiKey): string => {
  const base = `#/task/${encodeURIComponent(id)}`
  const params: string[] = []
  if (from) params.push(`from=${from}`)
  if (step) params.push(`step=${encodeURIComponent(step)}`)
  if (kpiKey) params.push(`kpiKey=${encodeURIComponent(kpiKey)}`)
  return params.length > 0 ? `${base}?${params.join('&')}` : base
}

/**
 * Reads the KPI key encoded in a `#/task/<id>?…&kpiKey=<key>` hash.
 *
 * When a task drawer is opened from a KPI detail page, `taskHash` encodes
 * both `from=kpi` and `kpiKey=<key>` in the URL so the drawer can return to
 * the exact KPI detail page on close rather than the KPI index (`#/kpi`).
 *
 * Returns the validated `KpiKey`, or `null` when the hash carries no
 * `kpiKey` param, an empty value, or an unrecognised key.
 *
 * Parsing mirrors `parseTaskStep` — plain string-splitting, no `URLSearchParams`.
 */
export const parseTaskKpiKey = (hash: string): KpiKey | null => {
  if (parseTaskRoute(hash) === null) return null
  const queryIndex = hash.indexOf('?')
  if (queryIndex === -1) return null
  const query = hash.slice(queryIndex + 1)
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq) !== 'kpiKey') continue
    const value = decodeURIComponent(pair.slice(eq + 1))
    if (value.length === 0) return null
    const valid: KpiKey[] = [
      'cost_per_arc',
      'failure_rate',
      'autonomous_completion_rate',
      'recovery_success_rate',
    ]
    return valid.includes(value as KpiKey) ? (value as KpiKey) : null
  }
  return null
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
 * Builds a proposal overlay hash, optionally tagging the origin page so the
 * drawer knows where to return on close. `proposalHash('x')` → `#/proposal/x`
 * (origin defaults to Progress); `proposalHash('x', 'action-queue')` →
 * `#/proposal/x?from=action-queue`.
 *
 * Mirrors `taskHash` for the proposal routing shape.
 */
export const proposalHash = (id: string, from?: RouteName): string => {
  const base = `#/proposal/${encodeURIComponent(id)}`
  return from ? `${base}?from=${from}` : base
}

/**
 * Reads the origin page encoded in a `#/proposal/<id>?from=<route>` hash.
 *
 * Mirrors `parseTaskOrigin` exactly but for proposal overlay hashes: the `from`
 * query param records which page the proposal drawer was opened from so that
 * closing returns there rather than always snapping to Progress.
 *
 * Returns the matching `RouteName`, or `null` when the hash carries no `from`,
 * an empty value, or an unrecognised route.
 */
export const parseProposalOrigin = (hash: string): RouteName | null => {
  if (parseProposalRoute(hash) === null) return null
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
 * Parses an optional `#/primitive/<name>` overlay route — the per-primitive
 * facet drawer (PrimitiveDetailDrawer), layered over the underlying page like
 * the proposal overlays. Studio step nodes link here; the route stays
 * deep-linkable on its own.
 *
 * Mirrors `parseKpiRoute`: the name must be one of the six known primitives;
 * unrecognised names normalise to `null` so a stray `#/primitive/typo` never
 * opens an empty drawer.
 */
export const parsePrimitiveRoute = (hash: string): PrimitiveName | null => {
  const m = /^#\/primitive\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const name = decodeURIComponent(m[1])
  return (PRIMITIVE_NAMES as readonly string[]).includes(name)
    ? (name as PrimitiveName)
    : null
}

/**
 * Builds a `#/primitive/<name>` hash for opening the primitive facet drawer.
 * Mirrors `kpiHash`/`proposalHash` for the overlay routing shape.
 */
export const primitiveHash = (name: PrimitiveName): string =>
  `#/primitive/${encodeURIComponent(name)}`

/**
 * Generic origin parser for any overlay hash that carries `?from=<route>`.
 * Reusable for proposal-node, primitive, release-notes, and shortcuts overlays
 * that previously hardcoded their close target.
 */
export const parseOverlayOrigin = (hash: string): RouteName | null => {
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
 * Builds a `#/proposal-node/<id>` hash, optionally tagging the origin page.
 */
export const proposalNodeHash = (id: string, from?: RouteName): string => {
  const base = `#/proposal-node/${encodeURIComponent(id)}`
  return from ? `${base}?from=${from}` : base
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
 * Returns true when the hash matches the `#/shortcuts` overlay route.
 *
 * The shortcuts overlay is a centered dialog layered on top of the Progress
 * page, opened by pressing `?` via the global keyboard shortcuts handler.
 * Closing it returns to `#/progress`.
 */
export const parseShortcutsRoute = (hash: string): boolean => hash === '#/shortcuts'

/**
 * Parses an optional `#/reflections/<originId>` detail sub-route within the
 * Reflection page. Returns the originId when present, `null` otherwise.
 *
 * The list route `#/reflections` returns `null` (no detail selected).
 */
export const parseReflectionDetailRoute = (hash: string): string | null => {
  const m = /^#\/reflections\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const id = decodeURIComponent(m[1])
  return id.length > 0 ? id : null
}

/**
 * Builds the `#/reflections/<originId>` hash for a reflection detail view.
 */
export const reflectionDetailHash = (originId: string): string =>
  `#/reflections/${encodeURIComponent(originId)}`

/**
 * Badge count for the Chat nav entry — stale worktrees only.
 * Drafts are surfaced as projection Threads and must not appear here.
 */
export const actionQueueCount = (payload: StaleWorktreesPayload): number =>
  payload.staleWorktrees.length

/**
 * Returns the document.title string for the given page route.
 *
 * When the route is 'chat' and `aqCount` is positive, the live action-queue
 * item count is appended in parentheses so multiple mars tabs are
 * distinguishable in the browser tab bar and history (e.g. "mars — chat (3)").
 */
export const pageTitle = (route: RouteName, aqCount = 0): string => {
  switch (route) {
    case 'chat':
      return aqCount > 0 ? `mars — chat (${aqCount})` : 'mars — chat'
    case 'progress':
      return 'mars — progress'
    case 'events':
      return 'mars — events'
    case 'kpi':
      return 'mars — kpis'
    case 'studio':
      return 'mars — studio'
    case 'steward':
      return 'mars — steward'
    case 'reflections':
      return 'mars — reflections'
  }
}

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
 * Proposal overlay hashes (`#/proposal/<id>?from=<route>`) respect the same
 * `from` mechanism as task overlays — the `from` param records the origin page
 * so closing the drawer returns there. A bare `#/proposal/<id>` (no `from`)
 * falls back to 'progress'.
 *
 * Primitive overlay hashes (`#/primitive/<name>`) always keep Progress
 * mounted beneath the drawer, mirroring the proposal-node overlay.
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
    return parseProposalOrigin(hash) ?? 'progress'
  }
  const proposalNodeId = parseProposalNodeRoute(hash)
  if (proposalNodeId !== null) {
    return parseOverlayOrigin(hash) ?? 'progress'
  }
  const primitiveName = parsePrimitiveRoute(hash)
  if (primitiveName !== null) {
    return parseOverlayOrigin(hash) ?? 'progress'
  }
  if (parseReleaseNotesRoute(hash)) {
    return 'progress'
  }
  if (parseShortcutsRoute(hash)) {
    return 'progress'
  }
  const kpiKey = parseKpiRoute(hash)
  if (kpiKey !== null) {
    return 'kpi'
  }
  return detectRoute(hash)
}
