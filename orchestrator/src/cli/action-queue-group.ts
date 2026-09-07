/**
 * Terminal formatting for action-queue grouped rows.
 *
 * The grouping logic itself (groupActionQueueRows, ActionQueueGroupedRow) lives
 * in `core/daemon/view/action-queue-group.ts` so it is shared by the HTTP
 * endpoint and all callers — both the CLI and the UI receive pre-grouped rows
 * from `/view/action-queue` (HR-3).
 *
 * This module contains only the terminal-column formatter that is the CLI's
 * sole presentation concern.
 */

export type { ActionQueueGroupedRow } from '../core/daemon/view/action-queue-group'
export { groupActionQueueRows } from '../core/daemon/view/action-queue-group'

// ── TSV formatting ────────────────────────────────────────────────────────────

import type { ActionQueueGroupedRow } from '../core/daemon/view/action-queue-group'

/**
 * Format a date string (ISO 8601) as just the `YYYY-MM-DD` portion for
 * compact CLI display.
 */
function dateSlug(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso
}

/**
 * Render a grouped row as a single tab-separated line following the same
 * column layout as the plain-row format used by `action-queue list`:
 *
 *   `id\tpriority\tkind\t[CLASS]\tsummary`
 *
 * The summary carries the count, cause, time span, and preview entity ids
 * so a human can read the group row without expanding it.
 */
export function formatGroupRowTsv(group: Extract<ActionQueueGroupedRow, { type: 'group' }>): string {
  const classCol = `[${(group.class ?? 'alert').toUpperCase()}]`
  const preview = group.previewIds.join(', ')
  const overflow = group.overflowCount > 0 ? ` …and ${group.overflowCount} more` : ''
  const timeSpan =
    group.firstAt === group.lastAt
      ? dateSlug(group.firstAt)
      : `${dateSlug(group.firstAt)} → ${dateSlug(group.lastAt)}`
  const summary = `${group.count}× ${group.causeLabel} · ${timeSpan} · ${preview}${overflow}`
  return `${group.id}\t${group.priority}\t${group.kind}\t${classCol}\t${summary}`
}
