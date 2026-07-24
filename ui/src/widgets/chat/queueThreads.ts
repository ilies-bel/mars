/**
 * Pure helpers for the chat sidebar's thread list.
 *
 * The chat sidebar is a plain list of conversation threads (alerts live on the
 * top-bar Bell, not in chat). These helpers stay free of React / Vite imports
 * so the filter semantics are unit-testable under plain bun:test.
 */

import type { ActionQueueItem, ChatThread } from '@/shared/schemas'

/**
 * Kind toggle retained for the action-queue URL state contract
 * (`@/shared/actionQueueUrlState`). The chat sidebar no longer renders the
 * toggle, but the type is still part of the persisted URL shape.
 */
export type KindFilter = 'all' | 'alerts' | 'drafts'

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
  const q = query.trim().toLowerCase()
  if (!q) return threads
  return threads.filter((t) => (t.title || 'New thread').toLowerCase().includes(q))
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
