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
// formatRelative — compact relative duration for thread rail timestamps
// ---------------------------------------------------------------------------

/**
 * Compact relative duration without the "ago" suffix: 2m, 4h, 3d.
 * Designed for tight sidebar rows where brevity matters.
 *
 * Bands:
 *   < 60 s  → "now"
 *   < 60 m  → "Nm"
 *   < 24 h  → "Nh"
 *   otherwise → "Nd"
 *
 * @param ms  Epoch-milliseconds timestamp of the event.
 * @param now Optional anchor for testing (defaults to Date.now()).
 */
export function formatRelative(ms: number, now = Date.now()): string {
  const age = Math.max(0, now - ms)
  if (age < 60_000) return 'now'
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`
  return `${Math.floor(age / 86_400_000)}d`
}

// ---------------------------------------------------------------------------
// isArchived — archive predicate for sidebar folding
// ---------------------------------------------------------------------------

/** Threads older than this threshold fold into the archived block by default. */
const ARCHIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Untitled threads older than this threshold fold into the stale-untitled disclosure row. */
export const STALE_UNTITLED_THRESHOLD_MS = 48 * 60 * 60 * 1000 // 48 hours

/**
 * A thread is archived when:
 *   - its `archivedAt` field is set (explicit operator archive), OR
 *   - its `createdAt` is more than 7 days old (age threshold).
 *
 * @param thread  The chat thread to evaluate.
 * @param now     Optional anchor for testing (defaults to Date.now()).
 */
export function isArchived(thread: ChatThread, now = Date.now()): boolean {
  if (thread.archivedAt != null) return true
  const age = now - new Date(thread.createdAt).getTime()
  return age > ARCHIVE_THRESHOLD_MS
}

/**
 * A thread is "stale untitled" when it has no user-visible title AND is older
 * than 48 hours. These rows carry zero information and are folded into a single
 * collapsed disclosure row in the sidebar to reduce visual noise.
 *
 * A thread has a user-visible title when:
 *   - its `title` field is non-empty, OR
 *   - its `firstUserMessage` is set (rendered via `smartTitle`).
 *
 * @param thread  The chat thread to evaluate.
 * @param now     Optional anchor for testing (defaults to Date.now()).
 */
export function isStaleUntitled(thread: ChatThread, now = Date.now()): boolean {
  const hasTitle = Boolean(thread.title?.trim()) || Boolean(thread.firstUserMessage?.trim())
  if (hasTitle) return false
  const age = now - new Date(thread.createdAt).getTime()
  return age > STALE_UNTITLED_THRESHOLD_MS
}

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
