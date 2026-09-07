/**
 * Signature-based grouping for action-queue rows — shared by the daemon's
 * HTTP view layer and all callers that read from it.
 *
 * Groups action-queue rows that share the same `(kind, failureReasonCode)`
 * into a single summary row so a queue with 18 identical "typecheck error"
 * failures reads as ONE thing to deal with, not eighteen. Singletons —
 * rows that are the only representative of their `(kind, signature)` bucket
 * — are passed through unchanged.
 *
 * **Cause-key fallback.** When a row carries no `failureReasonCode` (e.g.
 * rows raised by the proposal slicer), the grouping falls back to a *cause
 * key* derived by normalising `humanDetail.errorExcerpt`: UUIDs, hex ids,
 * file paths, standalone numbers, and punctuation runs are stripped and the
 * result is lowercased. Two rows whose excerpts normalise to the same string
 * are assumed to share a cause and are grouped together. Rows with neither a
 * `failureReasonCode` nor a normalizable excerpt are never grouped.
 *
 * The grouping rule lives HERE, not in any individual caller. Both the CLI
 * and the UI read the already-grouped output from `/view/action-queue`
 * so they cannot diverge (HR-3).
 */

import type { ActionQueueRow } from './action-queue'
import { lookupFailureKind } from '../../lib/failure-kinds'

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
      /**
       * The key that defines this group. For `failureReasonCode`-based groups
       * this is the code itself (e.g. `code/typecheck-error`). For cause-key
       * groups (rows with no `failureReasonCode` but a normalizable
       * `errorExcerpt`) this is a synthetic `__cause__:<normKey>` string.
       */
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

/** Max chars of the normalized excerpt key kept in the synthetic group id. */
const NORM_KEY_MAX = 64

/**
 * Strip variable tokens from a raw error excerpt to produce a stable cause
 * key. UUIDs, long hex ids, file paths, standalone numbers (port numbers,
 * exit codes, line numbers), and punctuation/whitespace runs are removed and
 * the result is lowercased. Two excerpts that differ only in such variable
 * tokens normalise to the same key and are placed in the same bucket.
 */
function normaliseExcerptKey(excerpt: string): string {
  return excerpt
    // Strip UUIDs before the generic hex strip so the boundary anchors fire.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    // Strip hex runs of 8+ chars (short ids, SHAs, …).
    .replace(/\b[0-9a-f]{8,}\b/gi, '')
    // Strip file-system paths (absolute or relative starting with /).
    .replace(/\/[^\s,;)'"]+/g, '')
    // Strip standalone numbers (exit codes, ports, line numbers, timestamps).
    .replace(/\b\d+\b/g, '')
    .toLowerCase()
    // Collapse any remaining non-alpha characters to a single space.
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .slice(0, NORM_KEY_MAX)
}

/**
 * Group action-queue rows by `(kind, failureReasonCode)`, with a fallback to
 * `(kind, normalised errorExcerpt)` for rows that carry no `failureReasonCode`.
 *
 * - Rows with a `failureReasonCode` are bucketed by that code.
 * - Rows without a code but with a non-empty normalizable `errorExcerpt` are
 *   bucketed by the normalised excerpt key (cause-key fallback).
 * - Rows with neither are always emitted as plain items (ungrouped).
 * - A bucket of exactly one row becomes a plain item (no group wrapper).
 * - A bucket of two or more rows becomes one `group` row carrying the member
 *   list so callers can expand it or apply bulk actions.
 * - Insertion order follows the input order of the first member seen in each
 *   bucket, so the caller's sort (priority → recency) is respected.
 */
export function groupActionQueueRows(rows: ActionQueueRow[]): ActionQueueGroupedRow[] {
  // ── Pass 1: assign each row to a bucket ────────────────────────────────────
  //
  // bucketKey  →  [rows in this bucket]
  // metaBySig  →  { sig, label } — the presentation metadata for this bucket
  //
  const buckets = new Map<string, ActionQueueRow[]>()
  /** Presentation metadata keyed by bucket key. */
  const meta = new Map<string, { sig: string; label: string }>()
  const ungrouped: ActionQueueRow[] = []

  for (const row of rows) {
    const frc = row.failureReasonCode?.trim()
    if (frc) {
      // Primary path: failureReasonCode-based bucket.
      const key = `sig\0${row.kind}\0${frc}`
      const bucket = buckets.get(key)
      if (bucket) {
        bucket.push(row)
      } else {
        buckets.set(key, [row])
        meta.set(key, { sig: frc, label: causeLabel(frc) })
      }
    } else {
      // Fallback path: normalise errorExcerpt → cause key.
      const excerpt = row.humanDetail.errorExcerpt?.trim() ?? ''
      const normKey = excerpt ? normaliseExcerptKey(excerpt) : ''
      if (normKey) {
        const key = `exc\0${row.kind}\0${normKey}`
        const bucket = buckets.get(key)
        if (bucket) {
          bucket.push(row)
        } else {
          buckets.set(key, [row])
          // Use the first line of the raw excerpt (capped at 80 chars) as the
          // cause label — more readable than the normalised token string.
          const firstLine = excerpt.split('\n')[0]?.trim() ?? excerpt
          const label = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
          meta.set(key, { sig: `__cause__:${normKey}`, label })
        }
      } else {
        ungrouped.push(row)
      }
    }
  }

  // ── Pass 2: emit rows in original input order ──────────────────────────────

  const emitted = new Set<string>() // bucket keys already emitted
  const result: ActionQueueGroupedRow[] = []

  for (const row of rows) {
    const frc = row.failureReasonCode?.trim()
    let key: string
    if (frc) {
      key = `sig\0${row.kind}\0${frc}`
    } else {
      const excerpt = row.humanDetail.errorExcerpt?.trim() ?? ''
      const normKey = excerpt ? normaliseExcerptKey(excerpt) : ''
      if (!normKey) continue // ungrouped; handled below
      key = `exc\0${row.kind}\0${normKey}`
    }

    if (emitted.has(key)) continue
    emitted.add(key)

    const members = buckets.get(key)!
    const { sig, label } = meta.get(key)!

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
      causeLabel: label,
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
