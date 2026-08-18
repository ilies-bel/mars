/**
 * Clustering logic for the "Needs you" triage view.
 *
 * Shared by TriagePage (rendering) so the list always reflects the same
 * rendered-row grouping. The rendered-row COUNT is intentionally NOT used as
 * the "needs you" badge count (see `countNeedsYou` below) — clustering
 * collapses high-cardinality kinds for display, which makes the rendered-row
 * count diverge from the true number of open, actionable items whenever a
 * non-draft-proposal kind exceeds CLUSTER_THRESHOLD.
 */

import { isTaskFailureActionQueueKind } from '@/shared/schemas'
import type { ActionQueueItem } from '@/shared/schemas'

// ── Canonical "needs you" count ────────────────────────────────────────────

/**
 * The single canonical "needs you" count: open action-queue items excluding
 * draft-proposal rows (a backlog of shaped ideas, not an operational alert
 * needing immediate action). Every surface that renders this concept — the
 * triage page badge, the sidebar badge, the chat greeting, the situation
 * card — derives from this same definition (mirrored server-side by
 * `countNeedsYou` in orchestrator/src/core/lib/situation-report.ts) so the
 * four surfaces can never disagree.
 */
export function countNeedsYou(items: readonly { kind: string }[]): number {
  return items.filter((item) => item.kind !== 'draft-proposal').length
}

// ── Sort ──────────────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<ActionQueueItem['priority'], number> = {
  high: 0,
  normal: 1,
  low: 2,
}

export function sortItems(items: ActionQueueItem[]): ActionQueueItem[] {
  return [...items].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1
    const pb = PRIORITY_ORDER[b.priority] ?? 1
    if (pa !== pb) return pa - pb
    return b.at.localeCompare(a.at)
  })
}

// ── Clustering ────────────────────────────────────────────────────────────────

/**
 * Threshold above which a decision kind collapses into a single cluster row.
 * draft-proposal is always clustered regardless of count (see buildRenderedRows).
 */
const CLUSTER_THRESHOLD = 5

/**
 * Kinds that represent per-entity conditions or per-arc failures requiring
 * individual attention. Never collapsed into a summary cluster row even when
 * their count is high — each row is a distinct, separately-actionable alert.
 */
const NEVER_CLUSTER_KINDS: ReadonlySet<string> = new Set([
  'stale-worktree',
  'arc-failed',
])

export type RenderedRow =
  | { type: 'item'; item: ActionQueueItem }
  | { type: 'cluster'; kind: string; count: number; latestAt: string }

/**
 * Collapses high-cardinality decision kinds into one cluster row per kind.
 *
 * Rules:
 * - Condition kinds (task failures, stale-worktree, arc-failed) → always individual.
 * - draft-proposal → always one cluster row (the proposals backlog can reach 900+).
 * - Any other decision kind whose count exceeds CLUSTER_THRESHOLD → one cluster row.
 *
 * The cluster row is inserted at the position of the first (highest-priority,
 * most-recent) item of that kind within the already-sorted list.
 */
export function buildRenderedRows(sorted: ActionQueueItem[]): RenderedRow[] {
  const kindCounts = new Map<string, number>()
  for (const item of sorted) {
    kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1)
  }

  const emittedClusters = new Set<string>()
  const result: RenderedRow[] = []

  for (const item of sorted) {
    const count = kindCounts.get(item.kind) ?? 1
    const isCondition =
      isTaskFailureActionQueueKind(item.kind) || NEVER_CLUSTER_KINDS.has(item.kind)
    const shouldCluster =
      !isCondition && (item.kind === 'draft-proposal' || count > CLUSTER_THRESHOLD)

    if (shouldCluster) {
      if (!emittedClusters.has(item.kind)) {
        emittedClusters.add(item.kind)
        result.push({ type: 'cluster', kind: item.kind, count, latestAt: item.at })
      }
      // Drop individual rows for this kind — they're represented by the cluster.
    } else {
      result.push({ type: 'item', item })
    }
  }

  return result
}
