import type { TodoPayload } from './schemas'

export type RouteName = 'action-queue' | 'progress' | 'agents' | 'events'

/**
 * Derives the current route from the URL hash.
 *
 * #/progress[/…]        → progress
 * #/agents[/…]          → agents
 * #/events[/…]          → events
 * everything else       → action-queue  (default; also covers #/todo legacy)
 */
export const detectRoute = (hash: string): RouteName => {
  if (hash.startsWith('#/progress')) return 'progress'
  if (hash.startsWith('#/agents')) return 'agents'
  if (hash.startsWith('#/events')) return 'events'
  return 'action-queue'
}

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
  'agents',
  'events',
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
 */
export const taskHash = (id: string, from?: RouteName): string => {
  const base = `#/task/${encodeURIComponent(id)}`
  return from ? `${base}?from=${from}` : base
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
 * Badge count for the Action queue nav entry — stale worktrees only.
 * Drafts are surfaced inline in the Action queue and must not appear here.
 */
export const actionQueueCount = (todo: TodoPayload): number =>
  todo.staleWorktrees.length

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
  return detectRoute(hash)
}
