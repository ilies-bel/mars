/**
 * Signature-based grouping for the `mars action-queue list` CLI command.
 *
 * Groups action-queue rows that share the same `(kind, failureReasonCode)`
 * into a single summary row so a queue with 18 identical "typecheck error"
 * failures reads as ONE thing to deal with, not eighteen. Singletons —
 * rows that are the only representative of their `(kind, signature)` bucket
 * — are passed through unchanged.
 *
 * The stdout contract (`id\tpriority\tkind\t[CLASS]\tsummary`) is preserved:
 * a group row occupies exactly one tab-separated line, with a synthetic id and
 * a summary that names the count, cause, time span, and preview entity ids.
 * Use `--no-group` to opt out and receive one line per raw row.
 */

import type { ActionQueueRow } from '../core/daemon/view/action-queue'
import { lookupFailureKind } from '../core/lib/failure-kinds'

/** How many entity ids to show inline before "…and N more". */
const PREVIEW_COUNT = 3

// ── Types ─────────────────────────────────────────────────────────────────────

export type ActionQueueGroupedRow =
  | { type: 'item'; row: ActionQueueRow }
  | {
      type: 'group'
      /** Synthetic stable id: `group:<kind>:<signature>`. */
      id: string
      kind: string
      /** The shared `failureReasonCode` that defines this group. */
      signature: string
      /** Total number of member rows. */
      count: number
      /** Plain-language cause label (warmTitle when available; falls back to the error-class slug). */
      causeLabel: string
      /** ISO timestamp of the earliest member (first seen). */
      firstAt: string
      /** ISO timestamp of the latest member (last seen). */
      lastAt: string
      /** Highest priority among members (`high` > `normal` > `low`). */
      priority: 'high' | 'normal' | 'low'
      /** Structural class of the members (all share the same class in practice). */
      class: string
      /** Preview entity ids (up to PREVIEW_COUNT). */
      previewIds: string[]
      /** Count of members not shown in previewIds (0 when all fit). */
      overflowCount: number
      /** All member rows — use for bulk actions or expand display. */
      members: ActionQueueRow[]
    }

// ── Helpers ───────────────────────────────────────────────────────────────────

function highestPriority(rows: ActionQueueRow[]): 'high' | 'normal' | 'low' {
  if (rows.some((r) => r.priority === 'high')) return 'high'
  if (rows.some((r) => r.priority === 'normal')) return 'normal'
  return 'low'
}

/**
 * Derive a plain-language cause label for a failure signature.
 *
 * 1. Looks up the registered FailureKind for the exact signature.
 * 2. Falls back to the error-class slug (the portion after the first `/`).
 */
function causeLabel(signature: string): string {
  const kind = lookupFailureKind(signature)
  if (kind?.warmTitle) return kind.warmTitle
  const slash = signature.indexOf('/')
  return slash >= 0 ? signature.slice(slash + 1) : signature
}

// ── Grouping ──────────────────────────────────────────────────────────────────

/**
 * Group action-queue rows by `(kind, failureReasonCode)`.
 *
 * - Rows with no `failureReasonCode` are always emitted as plain items.
 * - A bucket of exactly one row becomes a plain item (no group wrapper).
 * - A bucket of two or more rows becomes one `group` row carrying the member
 *   list so callers can expand it or apply bulk actions.
 * - Insertion order follows the input order of the first member seen in each
 *   bucket, so the caller's sort (priority → recency) is respected.
 */
export function groupActionQueueRows(rows: ActionQueueRow[]): ActionQueueGroupedRow[] {
  // Collect buckets in first-seen insertion order.
  const buckets = new Map<string, ActionQueueRow[]>()
  const ungrouped: ActionQueueRow[] = []

  for (const row of rows) {
    const sig = row.failureReasonCode?.trim()
    if (sig) {
      const key = `${row.kind}\0${sig}`
      const bucket = buckets.get(key)
      if (bucket) {
        bucket.push(row)
      } else {
        buckets.set(key, [row])
      }
    } else {
      ungrouped.push(row)
    }
  }

  // Build the result in a two-pass approach: iterate the input once more to
  // emit rows in their original priority-sorted order.
  const emitted = new Set<string>() // bucket keys already emitted as a group
  const result: ActionQueueGroupedRow[] = []

  for (const row of rows) {
    const sig = row.failureReasonCode?.trim()
    if (!sig) continue // handled in the ungrouped pass below
    const key = `${row.kind}\0${sig}`
    if (emitted.has(key)) continue
    emitted.add(key)

    const members = buckets.get(key)!
    if (members.length === 1) {
      result.push({ type: 'item', row: members[0]! })
      continue
    }

    // Sort members by `at` to derive firstAt / lastAt.
    const byAt = [...members].sort((a, b) => a.at.localeCompare(b.at))
    const firstAt = byAt[0]!.at
    const lastAt = byAt[byAt.length - 1]!.at
    const previewIds = members.slice(0, PREVIEW_COUNT).map((r) => r.entityId)

    result.push({
      type: 'group',
      id: `group:${row.kind}:${sig}`,
      kind: row.kind,
      signature: sig,
      count: members.length,
      causeLabel: causeLabel(sig),
      firstAt,
      lastAt,
      priority: highestPriority(members),
      class: members[0]!.class ?? 'alert',
      previewIds,
      overflowCount: members.length - previewIds.length,
      members,
    })
  }

  // Append ungrouped rows in their original order.
  for (const row of ungrouped) {
    result.push({ type: 'item', row })
  }

  return result
}

// ── TSV formatting ────────────────────────────────────────────────────────────

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
