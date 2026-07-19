/**
 * Pure filtering, selection, and subtitle helpers for the ActionQueuePage.
 *
 * Extracted here so they can be unit-tested without loading React or any
 * Vite-specific module (e.g. import.meta.env).
 */

import type { StaleWorktree } from '../shared/api'
import type { ActionQueueItem, DraftFeature } from '../shared/schemas'
import { humanizeFailureCode } from '../shared/actionQueueDetail'

// ---- Types ----------------------------------------------------------------

export type AlertItem = { kind: 'stale'; id: string; worktree: StaleWorktree }
export type ProposalItem = { kind: 'draft'; id: string; draft: DraftFeature }
export type SidebarItem = AlertItem | ProposalItem

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
 * Case-insensitive substring filter for draft proposal items.
 * A trimmed empty query returns the list unchanged.
 */
export function filterProposalItems(items: ProposalItem[], query: string): ProposalItem[] {
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

// ---- History label --------------------------------------------------------

/**
 * Returns the history accordion label in operator vocabulary.
 *
 * - 0 items → "History"
 * - N items, all loaded → "History · N"
 * - N items, more pages available → "History · N+"
 */
export function historyLabel(count: number, hasMore: boolean): string {
  if (count === 0) return 'History'
  return `History · ${count}${hasMore ? '+' : ''}`
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

// ---- Why-now subtitle -----------------------------------------------------

/**
 * One-line "why now" subtitle — the most actionable reason an operator should
 * act on a failed-task card. Priority: diagnosis text → errorKind (when
 * distinct from kind) → failureReasonCode → arc reason → body first line
 * (when non-generic).
 *
 * The body fallback deliberately skips the daemon's default boilerplate
 * "A pipeline step did not complete. See the transcript for details." — that
 * string appears identically on every failed-task card and conveys no
 * actionable information.
 */
export function whyNowText(item: ActionQueueItem): string | null {
  if (item.diagnosis?.text) {
    const line = item.diagnosis.text.split('\n')[0]
    return line.length > 100 ? `${line.slice(0, 100)}…` : line
  }
  if (item.errorKind && item.errorKind !== item.kind) {
    return humanizeFailureCode(item.errorKind)
  }
  if (item.failureReasonCode) {
    return humanizeFailureCode(item.failureReasonCode)
  }
  if (item.kind === 'arc-failed') {
    const line = item.reason.split('\n')[0]
    return line.length > 100 ? `${line.slice(0, 100)}…` : line
  }
  if (item.body) {
    const line = item.body.split('\n')[0]
    const GENERIC_BODY =
      'A pipeline step did not complete. See the transcript for details.'
    if (line.length === 0 || line === GENERIC_BODY) return null
    return line.length > 100 ? `${line.slice(0, 100)}…` : line
  }
  return null
}
