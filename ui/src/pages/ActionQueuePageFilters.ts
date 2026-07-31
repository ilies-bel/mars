/**
 * Shared action-queue wording and search rules.
 *
 * The Action Queue page is gone, but these rules still describe its queue
 * items when they appear as alert-origin threads in chat.
 */
import type { ActionQueueItem } from '../shared/schemas'
import { humanizeFailureCode } from '../shared/actionQueueDetail'

/** Case-insensitive text filtering that preserves the caller's item shape. */
export function filterByQuery<T>(items: T[], query: string, textFor: (item: T) => string): T[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return items
  return items.filter((item) => textFor(item).toLowerCase().includes(normalizedQuery))
}

/** The most actionable one-line reason an operator should act now. */
export function whyNowText(item: ActionQueueItem): string | null {
  if (item.diagnosis?.text) return item.diagnosis.text.split('\n')[0].slice(0, 100)
  if (item.errorKind && item.errorKind !== item.kind) return humanizeFailureCode(item.errorKind)
  if (item.failureReasonCode) return humanizeFailureCode(item.failureReasonCode)
  if (item.kind === 'arc-failed') return item.reason.split('\n')[0].slice(0, 100)
  const line = item.body?.split('\n')[0] ?? ''
  return line && line !== 'A pipeline step did not complete. See the transcript for details.'
    ? line.slice(0, 100)
    : null
}

/** Compact operator-facing description for an action-queue-backed thread. */
export function subtitleFor(item: ActionQueueItem): string {
  return whyNowText(item) ?? item.title
}
