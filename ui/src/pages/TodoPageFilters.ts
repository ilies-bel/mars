/**
 * Pure filtering and selection helpers for the ActionQueuePage inbox sidebar.
 *
 * Extracted here so they can be unit-tested without loading React or any
 * Vite-specific module (e.g. import.meta.env).
 */

import type { StaleWorktree } from '../shared/api'
import type { DraftFeature } from '../shared/schemas'

// ---- Types ----------------------------------------------------------------

export type AlertItem = { kind: 'stale'; id: string; worktree: StaleWorktree }
export type IdeaItem = { kind: 'draft'; id: string; draft: DraftFeature }
export type SidebarItem = AlertItem | IdeaItem

export const itemKey = (item: SidebarItem): string => `${item.kind}:${item.id}`

// ---- Constants ------------------------------------------------------------

/** Tokens that should make every alert visible when typed. */
const ALERT_KIND_TOKENS = ['stale', 'alert', 'task-blocked']

/** Tokens that should make every proposal visible when typed. */
const PROPOSAL_KIND_TOKENS = ['draft', 'proposal', 'draft-proposal']

// ---- Filter functions -----------------------------------------------------

/**
 * Case-insensitive substring filter for alert (stale-worktree) items.
 * A trimmed empty query returns the list unchanged.
 */
export function filterAlertItems(items: AlertItem[], query: string): AlertItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => {
    const w = item.worktree
    const haystack = [
      w.taskId,
      w.prompt,
      w.status,
      w.error ?? '',
      ...ALERT_KIND_TOKENS,
    ]
      .join('\n')
      .toLowerCase()
    return haystack.includes(q)
  })
}

/**
 * Case-insensitive substring filter for idea (draft/proposal) items.
 * A trimmed empty query returns the list unchanged.
 */
export function filterIdeaItems(items: IdeaItem[], query: string): IdeaItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => {
    const d = item.draft
    const haystack = [
      d.id,
      d.title,
      d.problem,
      d.solution,
      d.source,
      d.status,
      ...PROPOSAL_KIND_TOKENS,
    ]
      .join('\n')
      .toLowerCase()
    return haystack.includes(q)
  })
}

// ---- Selection helper -----------------------------------------------------

/**
 * Derives the next selected key given a (possibly filtered) item list and the
 * currently selected key.
 *
 * Rules:
 * - Empty list → null (clear selection).
 * - Current key is in the list → keep it.
 * - Current key missing from list (or null) → select the first item.
 */
export function deriveSelectedKey(
  filteredItems: SidebarItem[],
  currentKey: string | null,
): string | null {
  if (filteredItems.length === 0) return null
  if (!currentKey || !filteredItems.some((i) => itemKey(i) === currentKey)) {
    return itemKey(filteredItems[0])
  }
  return currentKey
}
