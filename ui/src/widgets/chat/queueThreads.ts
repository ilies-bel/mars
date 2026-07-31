/**
 * Pure helpers for the chat sidebar's thread list.
 *
 * The chat sidebar is a plain list of conversation threads (alerts live on the
 * top-bar Bell, not in chat). These helpers stay free of React / Vite imports
 * so the filter semantics are unit-testable under plain bun:test.
 */

import type { ActionQueueItem, ChatThread } from '@/shared/schemas'
import { filterByQuery } from '@/pages/ActionQueuePageFilters'

// ---------------------------------------------------------------------------
// Open-thread filter — drops resolved projections
// ---------------------------------------------------------------------------

/**
 * Keeps only threads whose backing action-queue item is still open.
 * User-created threads (no backing alert, alertResolved defaults to false)
 * are always retained. Alert-origin threads evaporate once their backing item
 * is resolved (alertResolved === true).
 */
export function filterOpen(threads: ChatThread[]): ChatThread[] {
  return threads.filter((t) => t.alertResolved !== true)
}

// ---------------------------------------------------------------------------
// Urgency → age sort
// ---------------------------------------------------------------------------

/** Urgency rank for sidebar ordering — lower number = higher urgency. */
const URGENCY_RANK: Record<string, number> = {
  ready: 0,
  generating: 1,
  drafting: 2,
  idle: 3,
}

/**
 * Sorts threads by urgency descending (attention status), then age ascending
 * (oldest first among equal urgency), with id as final tiebreaker.
 */
export function sortByUrgencyThenAge(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort((a, b) => {
    const urgencyDiff =
      (URGENCY_RANK[a.attentionStatus ?? 'idle'] ?? 3) -
      (URGENCY_RANK[b.attentionStatus ?? 'idle'] ?? 3)
    if (urgencyDiff !== 0) return urgencyDiff
    const ageDiff = a.createdAt.localeCompare(b.createdAt)
    if (ageDiff !== 0) return ageDiff
    return a.id.localeCompare(b.id)
  })
}

/**
 * Kind toggle retained for the action-queue URL state contract
 * (`@/shared/actionQueueUrlState`). The chat sidebar no longer renders the
 * toggle, but the type is still part of the persisted URL shape.
 */
export type KindFilter = 'all' | 'alerts' | 'drafts'

export interface ThreadListFilters {
  query: string
  kind: 'all' | 'failed-task' | 'draft-proposal'
  origin: 'all' | 'alerts' | 'operator'
}

/**
 * Draft-proposal rows carry the full multi-paragraph PRD body in `item.title`.
 * A queue row must show only a scannable headline: the first sentence
 * (up to `. ` / `.\n`) or the first line, whichever comes first. The complete
 * body still renders in the detail pane, so nothing is lost.
 *
 * Non-draft rows return their title untouched — their titles are already short.
 * Exported for unit-testing and consumed by `QueueThreadRow`.
 */
export function draftRowHeadline(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') return ''
  // First hard newline wins if it comes before the first sentence-ending period.
  const newlineIdx = trimmed.search(/\r?\n/)
  const sentenceMatch = trimmed.match(/[.!?]["')\]]?(?=\s|$)/)
  const sentenceIdx = sentenceMatch ? (sentenceMatch.index ?? -1) + sentenceMatch[0].length : -1
  const candidates = [newlineIdx, sentenceIdx].filter((i) => i > 0)
  if (candidates.length === 0) return trimmed
  const cut = Math.min(...candidates)
  return trimmed.slice(0, cut).trim()
}

/**
 * Case-insensitive title search over conversation threads. An empty (trimmed)
 * query matches every thread. Threads with no title match under the
 * "New thread" placeholder so a search for "new" still finds them.
 */
export function filterThreadsByTitle(threads: ChatThread[], query: string): ChatThread[] {
  return filterByQuery(threads, query, (thread) => `${thread.title || 'New thread'}\n${thread.alertItemId ?? ''}`)
}

/** Applies the chat sidebar's open, query, failure-kind, and origin scopes. */
export function filterSidebarThreads(threads: ChatThread[], filters: ThreadListFilters): ChatThread[] {
  return filterThreadsByTitle(filterOpen(threads), filters.query).filter((thread) => {
    const kind = thread.alertItemId?.split(':')[0] ?? null
    const matchesKind = filters.kind === 'all' || kind === filters.kind
    const matchesOrigin =
      filters.origin === 'all' ||
      (filters.origin === 'alerts' ? thread.origin === 'alert' : thread.origin !== 'alert')
    return matchesKind && matchesOrigin
  })
}

/**
 * True when a pinned queue selection has vanished from the live queue —
 * i.e. the row was resolved by a Decision or superseded server-side.
 * Guarded on items.length > 0 so the initial empty-load frame never flashes
 * "resolved".
 */
export function isResolvedSelection(
  selectedQueueItemId: string | null,
  liveItems: ActionQueueItem[],
): boolean {
  return (
    selectedQueueItemId !== null &&
    liveItems.length > 0 &&
    liveItems.find((i) => i.id === selectedQueueItemId) == null
  )
}
