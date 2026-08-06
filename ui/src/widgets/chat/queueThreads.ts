/**
 * Pure helpers for the chat sidebar's thread list.
 *
 * The chat sidebar is a plain list of conversation threads (alerts live on the
 * top-bar Bell, not in chat). These helpers stay free of React / Vite imports
 * so the filter semantics are unit-testable under plain bun:test.
 */

import type { ActionQueueItem, ChatThread } from '@/shared/schemas'
import { filterByQuery } from '@/pages/ActionQueuePageFilters'
import { smartTitle } from '@/pages/chatPageUtils'

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
  origin: 'all' | 'alerts' | 'operator'
}

export interface ForkFilter {
  parentThreadId?: string
  hasParent?: boolean
}

/** Operational action-queue rows, excluding draft proposals. */
export function isAlertQueueItem(item: { kind: string }): boolean {
  return item.kind !== 'draft-proposal'
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
 * query matches every thread. The search key uses the same derived title that
 * the rail renders: threads with a firstUserMessage match against that derived
 * title, and genuinely empty threads (no title, no messages) match under the
 * "New thread" placeholder.
 */
export function filterThreadsByTitle(threads: ChatThread[], query: string): ChatThread[] {
  return filterByQuery(
    threads,
    query,
    (thread) => `${smartTitle(thread.title, thread.firstUserMessage)}\n${thread.alertItemId ?? ''}`,
  )
}

/** Applies the archive's fork-tree scope to a thread list. */
export function filterThreadsByFork(threads: ChatThread[], forkFilter: ForkFilter): ChatThread[] {
  if (forkFilter.parentThreadId) {
    return threads.filter((thread) => thread.parentThreadId === forkFilter.parentThreadId)
  }
  if (forkFilter.hasParent) return threads.filter((thread) => typeof thread.parentThreadId === 'string')
  return threads
}

/** Applies the chat sidebar's open, query, and origin scopes. */
export function filterSidebarThreads(
  threads: ChatThread[],
  filters: ThreadListFilters,
  forkFilter: ForkFilter = {},
): ChatThread[] {
  return filterThreadsByFork(filterThreadsByTitle(filterOpen(threads), filters.query), forkFilter).filter((thread) => {
    const matchesOrigin =
      filters.origin === 'all' ||
      (filters.origin === 'alerts' ? thread.origin === 'alert' : thread.origin !== 'alert')
    return matchesOrigin
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
