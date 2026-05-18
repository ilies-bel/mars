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
