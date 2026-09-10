import type { KpiKey } from './schemas'
import type { StaleWorktreesPayload } from './schemas'
import { type PrimitiveName } from '@/entities/primitive/types'

/**
 * Thin wrapper around `decodeURIComponent` that catches `URIError` and
 * returns `null` instead of throwing.
 *
 * Use this at every client-side decode site.  A `null` return means the
 * segment was malformed (e.g. a bare `%` with no following hex digits), and
 * the calling parser must treat the hash as "no match" so the unknown-route
 * redirect in App kicks in rather than blanking the app.
 */
export const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export type RouteName = 'progress' | 'events' | 'kpi' | 'studio' | 'chat' | 'steward' | 'reflections' | 'control' | 'triage' | 'proposals' | 'arc-qa'

/**
 * Derives the current route from the URL hash.
 *
 * (empty / root)        → triage (default landing page — "Action Queue")
 * #/triage              → triage
 * #/chat[/…]            → chat
 * #/progress[/…]        → progress
 * #/events[/…]          → events
 * #/kpi or #/kpi/<key>  → kpi
 * #/studio              → studio (index listing recent scored runs)
 * #/studio/<taskId>     → studio (per-task execution tree)
 * everything else       → chat  (also covers the legacy #/action-queue and
 *                                #/todo hashes — the chat page absorbed the
 *                                action queue as projection Threads)
 */
export const detectRoute = (hash: string): RouteName => {
  if (hash === '' || hash === '#' || hash === '#/') return 'triage'
  if (hash.startsWith('#/triage')) return 'triage'
  if (hash.startsWith('#/chat')) return 'chat'
  if (hash.startsWith('#/progress')) return 'progress'
  if (hash.startsWith('#/events')) return 'events'
  if (hash === '#/kpi' || hash.startsWith('#/kpi/')) return 'kpi'
  if (hash === '#/studio') return 'studio'
  if (parseStudioRoute(hash) !== null) return 'studio'
  if (parseArcQaRoute(hash) !== null) return 'arc-qa'
  if (hash === '#/steward') return 'steward'
  if (hash.startsWith('#/reflections')) return 'reflections'
  if (hash === '#/control') return 'control'
  if (hash === '#/proposals') return 'proposals'
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
  // Empty / root hashes → Triage (the default landing page)
  if (hash === '' || hash === '#' || hash === '#/') return true
  // Named page routes
  if (hash.startsWith('#/triage')) return true
  if (hash.startsWith('#/chat')) return true
  // Legacy action-queue hashes — the App redirects them onto #/chat.
  if (hash.startsWith('#/action-queue')) return true
  if (hash.startsWith('#/todo')) return true
  if (hash.startsWith('#/progress')) return true
  if (hash.startsWith('#/events')) return true
  if (hash === '#/kpi' || hash.startsWith('#/kpi/')) return true
  // Studio: bare #/studio is the index page; #/studio/<taskId> is the per-task view.
  // #/studio/ (trailing slash, no id) is still unknown — parseStudioRoute returns null for it.
  if (hash === '#/studio') return true
  if (parseStudioRoute(hash) !== null) return true
  // Arc QA requires a non-empty origin id — a bare `#/arc//qa` redirects.
  if (parseArcQaRoute(hash) !== null) return true
  if (hash === '#/steward') return true
  if (hash.startsWith('#/reflections')) return true
  if (hash === '#/control') return true
  if (hash === '#/proposals') return true
  // Overlay routes (task drawer, proposal drawers, primitive drawer,
  // release notes, shortcuts)
  if (hash.startsWith('#/task/')) return true
  if (hash.startsWith('#/proposal/')) return true
  if (hash.startsWith('#/proposal-node/')) return true
  // Any non-empty `#/primitive/<name>` is a known address — unknown names render
  // a not-found overlay instead of silently redirecting to #/progress.
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
  const key = safeDecode(m[1]) as KpiKey | null
  if (key === null) return null
  const valid: KpiKey[] = [
    'cost_per_arc',
    'failure_rate',
    'autonomous_completion_rate',
    'recovery_success_rate',
    'cost-per-merged-task',
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
  const id = safeDecode(m[1])
  if (id === null) return null
  return id.length > 0 ? id : null
}

/**
 * Builds a `#/studio/<taskId>` hash for navigating to the Studio page.
 */
export const studioHash = (taskId: string): string =>
  `#/studio/${encodeURIComponent(taskId)}`

/**
 * Parses an optional `#/arc/<originId>/qa` full-page route — the per-arc
 * QA walk viewer showing criteria, step screenshots, and the stop reason.
 *
 * Returns the decoded origin task id, or `null` when the hash is not an
 * arc-qa route. Trailing slashes and empty ids normalise to `null`.
 */
export const parseArcQaRoute = (hash: string): string | null => {
  const m = /^#\/arc\/([^/?#]+)\/qa/.exec(hash)
  if (!m) return null
  const id = safeDecode(m[1])
  if (id === null) return null
  return id.length > 0 ? id : null
}

/**
 * Builds a `#/arc/<originId>/qa` hash for navigating to the Arc QA page.
 */
export const arcQaHash = (originId: string): string =>
  `#/arc/${encodeURIComponent(originId)}/qa`

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
  const id = safeDecode(m[1])
  if (id === null) return null
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
  'control',
  'triage',
  'proposals',
  'arc-qa',
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
    const value = safeDecode(pair.slice(eq + 1))
    if (value === null) return null
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
    const value = safeDecode(pair.slice(eq + 1))
    if (value === null) return null
    if (value.length === 0) return null
    const valid: KpiKey[] = [
      'cost_per_arc',
      'failure_rate',
      'autonomous_completion_rate',
      'recovery_success_rate',
      'cost-per-merged-task',
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
    const value = safeDecode(pair.slice(eq + 1))
    if (value === null) return null
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
    const value = safeDecode(pair.slice(eq + 1))
    if (value === null) return null
    return isRouteName(value) ? value : null
  }
  return null
}

/**
 * Reads the kind filter encoded in a `#/triage?kind=<kind>` hash.
 *
 * The parked-task chip in the app header links here to open Needs You already
 * narrowed to the tasks waiting on a person. That link existed and the Triage
 * page ignored the param outright, so the one persistent affordance in the
 * chrome navigated and then visibly did nothing — which reads as a broken app
 * rather than a missing feature.
 *
 * Returns the raw kind (the same value the filter's `<option>`s carry, e.g.
 * `awaiting-human` — NOT the short display label), or `null` when the hash is
 * not a Triage hash, carries no `kind`, or carries an undecodable one.
 *
 * Parsing is the plain string-splitting the rest of this file uses.
 */
export const parseTriageKind = (hash: string): string | null => {
  const queryIndex = hash.indexOf('?')
  if (queryIndex === -1) return null
  const path = hash.slice(0, queryIndex)
  if (path !== '#/triage' && path !== '#/triage/') return null
  for (const pair of hash.slice(queryIndex + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq) !== 'kind') continue
    const value = safeDecode(pair.slice(eq + 1))
    return value !== null && value !== '' ? value : null
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
  const id = safeDecode(m[1])
  if (id === null) return null
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
  const id = safeDecode(m[1])
  if (id === null) return null
  return id.length > 0 ? id : null
}

/**
 * Parses an optional `#/primitive/<name>` overlay route — the per-primitive
 * facet drawer (PrimitiveDetailDrawer), layered over the underlying page like
 * the proposal overlays. Studio step nodes link here; the route stays
 * deep-linkable on its own.
 *
 * The name is NOT checked against a code-pinned list. It used to be, and that
 * made every operator-registered primitive unreachable: the daemon serves it
 * from its live registry, but `#/primitive/<thatName>` normalised to null and
 * the router rendered "<name> is not a known primitive" — a flat contradiction
 * of what the API would have returned. The daemon owns the answer, so the
 * drawer asks it and renders whatever comes back, including a fetch failure.
 */
export const parsePrimitiveRoute = (hash: string): PrimitiveName | null => {
  const m = /^#\/primitive\/([^/?#]+)/.exec(hash)
  if (!m) return null
  return safeDecode(m[1])
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
    const value = safeDecode(pair.slice(eq + 1))
    if (value === null) return null
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
 * Parsed reflection detail route — uniquely identifies one report file.
 */
export interface ReflectionDetailRoute {
  originId: string
  recordedAt: string
}

/**
 * Parses an optional `#/reflections/<originId>/<recordedAt>` detail sub-route
 * within the Reflection page.  Returns `{originId, recordedAt}` when present,
 * `null` for the list route `#/reflections`.
 *
 * The two-segment form is required so that multiple reports that share the
 * same originId each get a stable, unambiguous URL.
 */
export const parseReflectionDetailRoute = (hash: string): ReflectionDetailRoute | null => {
  const m = /^#\/reflections\/([^/?#]+)\/([^/?#]+)/.exec(hash)
  if (!m) return null
  const originId = safeDecode(m[1])
  const recordedAt = safeDecode(m[2])
  if (originId === null || recordedAt === null) return null
  return originId.length > 0 && recordedAt.length > 0 ? { originId, recordedAt } : null
}

/**
 * Builds the `#/reflections/<originId>/<recordedAt>` hash for a reflection
 * detail view.  Both segments are required so each report file gets a unique URL
 * even when several share the same originId.
 */
export const reflectionDetailHash = (originId: string, recordedAt: string): string =>
  `#/reflections/${encodeURIComponent(originId)}/${encodeURIComponent(recordedAt)}`

/**
 * Badge count for the Chat nav entry — stale worktrees only.
 * Drafts are surfaced as projection Threads and must not appear here.
 */
export const actionQueueCount = (payload: StaleWorktreesPayload): number =>
  payload.staleWorktrees.length

/**
 * Returns the document.title string for the given page route. Page name
 * first so the distinctive part survives tab-width truncation.
 */
export const pageTitle = (route: RouteName): string => {
  switch (route) {
    case 'triage':
      return 'Needs You — mars'
    case 'chat':
      return 'Chat — mars'
    case 'progress':
      return 'Progress — mars'
    case 'events':
      return 'Events — mars'
    case 'kpi':
      return 'KPIs — mars'
    case 'studio':
      return 'Studio — mars'
    case 'steward':
      return 'Steward — mars'
    case 'reflections':
      return 'Reflections — mars'
    case 'control':
      return 'Control Room — mars'
    case 'proposals':
      return 'Proposals — mars'
    case 'arc-qa':
      return 'Arc QA — mars'
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
  // Any `#/primitive/<name>` (valid or not) keeps Progress behind the overlay.
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
