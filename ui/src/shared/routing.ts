import type { TodoPayload } from './schemas'

export type RouteName = 'action-queue' | 'proposals' | 'kanban' | 'agents'

/**
 * Derives the current route from the URL hash.
 *
 * #/proposals           → proposals
 * #/kanban[/…]          → kanban
 * #/agents[/…]          → agents
 * everything else       → action-queue  (default; also covers #/todo legacy)
 */
export const detectRoute = (hash: string): RouteName => {
  if (hash.startsWith('#/kanban')) return 'kanban'
  if (hash.startsWith('#/agents')) return 'agents'
  if (hash.startsWith('#/proposals')) return 'proposals'
  return 'action-queue'
}

/**
 * Parses an optional `#/task/<id>` overlay route. The task drawer is layered
 * on top of whatever the underlying `detectRoute(...)` route resolves to —
 * Kanban or otherwise — so this function returns the id alone (or `null` when
 * the hash carries no task fragment).
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
 * Badge count for the Action queue nav entry — stale worktrees only.
 * Drafts are proposals-domain and must not appear here.
 */
export const actionQueueCount = (todo: TodoPayload): number =>
  todo.staleWorktrees.length

/**
 * Badge count for the Proposals nav entry — drafts only.
 * Stale worktrees are action-queue-domain and must not appear here.
 */
export const proposalsCount = (todo: TodoPayload): number => todo.drafts.length
