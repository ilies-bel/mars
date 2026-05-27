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
 * Task and proposal overlay hashes (`#/task/<id>`, `#/proposal/<id>`) force
 * the Progress page to stay mounted so that the operator's local view state
 * (active tab, cluster toggles, recency slider) is preserved.  Closing the
 * drawer resets the hash to `#/progress`, which also resolves to 'progress',
 * so the ProgressPage component is never unmounted during the open/close cycle.
 *
 * Use this instead of `detectRoute` as the single source of truth in the App.
 */
export const resolvePageRoute = (hash: string): RouteName => {
  const taskId = parseTaskRoute(hash)
  const proposalId = parseProposalRoute(hash)
  if (
    (taskId !== null && hash.startsWith('#/task/')) ||
    (proposalId !== null && hash.startsWith('#/proposal/'))
  ) {
    return 'progress'
  }
  return detectRoute(hash)
}
