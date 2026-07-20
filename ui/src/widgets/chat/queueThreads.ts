/**
 * Pure helpers for projection Threads — the action-queue rows surfaced in the
 * chat sidebar as virtual (server-projected) Thread entries.
 *
 * A projection Thread exists iff the backing action-queue row exists; it
 * clears only via entity mutation (a Decision firing a daemon op), never a
 * chat-side close. When a chat thread with origin='alert' points at a live
 * row (alertItemId), the two merge into ONE sidebar entry whose selection
 * opens the conversation.
 *
 * Kept free of React / Vite imports so the merge and filter semantics are
 * unit-testable under plain bun:test.
 */

import type { ActionQueueItem, ChatThread } from '@/shared/schemas'

export type KindFilter = 'all' | 'alerts' | 'drafts'

/** Pure helper: returns true when `item` should be shown for the given `filter`. */
export function matchesKindFilter(item: ActionQueueItem, filter: KindFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'alerts')
    return (
      item.kind === 'failed-task' ||
      item.kind === 'stale-worktree' ||
      item.kind === 'awaiting-validation'
    )
  return item.kind === 'draft-proposal'
}

/**
 * Draft-proposal rows carry the full multi-paragraph PRD body in `item.title`.
 * The sidebar row must show only a scannable headline: the first sentence
 * (up to `. ` / `.\n`) or the first line, whichever comes first. The complete
 * body still renders in the detail pane, so nothing is lost.
 *
 * Non-draft rows return their title untouched — their titles are already short.
 * Exported for unit-testing.
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
 * Case-insensitive search over the queue row's id / title / body / kind /
 * entityId, combined with the kind toggle. An empty (trimmed) query matches
 * everything.
 */
export function filterQueueItems(
  items: ActionQueueItem[],
  query: string,
  filter: KindFilter,
): ActionQueueItem[] {
  const q = query.trim().toLowerCase()
  return items.filter(
    (i) =>
      matchesKindFilter(i, filter) &&
      (!q ||
        i.id.toLowerCase().includes(q) ||
        i.title.toLowerCase().includes(q) ||
        i.body.toLowerCase().includes(q) ||
        i.kind.toLowerCase().includes(q) ||
        (i.entityId != null && i.entityId.toLowerCase().includes(q))),
  )
}

/** One sidebar entry: a live queue row plus its conversation, if one exists. */
export interface ProjectionEntry {
  item: ActionQueueItem
  /** The alert-origin chat thread merged into this entry, or null. */
  thread: ChatThread | null
}

export interface SidebarMerge {
  /** Projection Threads — always float above regular chat threads. */
  projections: ProjectionEntry[]
  /** Remaining chat threads (server order preserved). */
  regular: ChatThread[]
}

/**
 * Merges live action-queue rows and chat threads into the lateral list.
 *
 * - Every open queue row (post-filter) becomes a projection entry, in server
 *   order, floating above regular chat threads.
 * - A chat thread with origin='alert' whose alertItemId matches a live row is
 *   absorbed into that row's projection entry (one entry, selection opens the
 *   conversation). Alert threads whose row has left the queue fall back to
 *   regular entries.
 * - Regular chat threads are filtered by title when a query is set, and are
 *   only shown under the 'all' kind filter — the Alerts/Drafts toggles scope
 *   the list to projection Threads.
 */
export function mergeSidebarEntries(
  queueItems: ActionQueueItem[],
  threads: ChatThread[],
  query: string,
  filter: KindFilter,
): SidebarMerge {
  const filteredItems = filterQueueItems(queueItems, query, filter)
  const byAlertId = new Map(filteredItems.map((i) => [i.id, i]))

  const mergedThreadIds = new Set<string>()
  const threadByItemId = new Map<string, ChatThread>()
  for (const t of threads) {
    const alertItemId = t.alertItemId
    if (t.origin === 'alert' && alertItemId != null && byAlertId.has(alertItemId)) {
      // First matching thread wins; later duplicates stay regular.
      if (!threadByItemId.has(alertItemId)) {
        threadByItemId.set(alertItemId, t)
        mergedThreadIds.add(t.id)
      }
    }
  }

  const projections: ProjectionEntry[] = filteredItems.map((item) => ({
    item,
    thread: threadByItemId.get(item.id) ?? null,
  }))

  const q = query.trim().toLowerCase()
  const regular =
    filter === 'all'
      ? threads.filter(
          (t) =>
            !mergedThreadIds.has(t.id) &&
            (!q || (t.title || 'New thread').toLowerCase().includes(q)),
        )
      : []

  return { projections, regular }
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
