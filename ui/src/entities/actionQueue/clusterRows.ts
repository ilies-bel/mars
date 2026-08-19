/**
 * Clustering logic for the "Needs you" triage view.
 *
 * Shared by TriagePage (rendering) so the list always reflects the same
 * rendered-row grouping. The rendered-row COUNT is intentionally NOT used as
 * the cross-surface "needs you" badge count (see `countNeedsYou` below) —
 * clustering collapses high-cardinality kinds for display, which makes the
 * rendered-row count diverge from the true number of distinct subjects
 * needing attention whenever a non-draft-proposal kind exceeds
 * CLUSTER_THRESHOLD.
 */

import { isTaskFailureActionQueueKind } from '@/shared/schemas'
import type { ActionQueueItem } from '@/shared/schemas'

// ── Canonical "needs you" count ────────────────────────────────────────────

/**
 * The single canonical "needs you" count: distinct open subjects excluding
 * draft-proposal rows (a backlog of shaped ideas, not an operational alert
 * needing immediate action). Every surface that renders this concept — the
 * triage page badge, the sidebar badge, the chat greeting, the situation
 * card — derives from this same definition (mirrored server-side by
 * `countNeedsYou` in orchestrator/src/core/lib/situation-report.ts) so the
 * four surfaces can never disagree.
 *
 * Several condition kinds (`failed`, `recovery-abandoned`, `gate-broken`, …)
 * derive independently per ADR-0057 with no reconciliation between them, so
 * one failed task can raise several open rows at once. A naive item count
 * would report those as several items; this function collapses them to one,
 * matching the entity-grouping `buildRenderedRows` performs — a task shown
 * on three rows is one subject needing attention, not three.
 */
export function countNeedsYou(items: readonly ActionQueueItem[]): number {
  const seenEntities = new Set<string>()
  let count = 0
  for (const item of items) {
    if (item.kind === 'draft-proposal') continue
    if (item.entityId && isGroupableConditionKind(item.kind)) {
      if (seenEntities.has(item.entityId)) continue
      seenEntities.add(item.entityId)
    }
    count++
  }
  return count
}

/**
 * Whether a kind is a per-TASK condition that can co-occur with other
 * conditions for the same task, and so must be collapsed onto one card.
 *
 * Almost all of these are already carried by the daemon's task-failure
 * classification (`isTaskFailureActionQueueKind`), but `recovery-abandoned`
 * is NOT in that list — it is a distinct condition the daemon raises from
 * `orchestrator/src/outbox/subscribers/recovery-abandoned.ts`, and
 * `taskFailureKinds` deliberately mirrors the daemon's own classification
 * byte-for-byte, so it must not be edited to paper over a UI grouping need.
 * The extra kinds are therefore listed here, local to the triage view.
 *
 * This gap is the whole bug: `recovery-abandoned` is precisely the kind that
 * was rendering a live Restart button next to a recovery-exhausted `failed`
 * row telling the operator that Restart would discard real work. Gating
 * grouping on `isTaskFailureActionQueueKind` alone silently excludes it and
 * leaves the contradiction on screen.
 */
const EXTRA_GROUPABLE_CONDITION_KINDS: ReadonlySet<string> = new Set(['recovery-abandoned'])

const isGroupableConditionKind = (kind: string): boolean =>
  isTaskFailureActionQueueKind(kind) || EXTRA_GROUPABLE_CONDITION_KINDS.has(kind)

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
  | { type: 'entityGroup'; primary: ActionQueueItem; badgeKinds: string[] }

/**
 * Precedence used to pick the ONE verb set an entity-group card exposes when
 * a single task has raised more than one condition row (see
 * `buildRenderedRows`). A recovery-exhausted row always wins regardless of
 * kind: Continue/Restart would error on it, so its carry-forward panel is the
 * only correct advice. Absent that, prefer the structured `failed` row, then
 * `recovery-abandoned`, then `gate-broken`; any other kind keeps its position
 * in the already-sorted (priority, recency) list.
 */
const ENTITY_GROUP_KIND_RANK: Record<string, number> = {
  failed: 0,
  'recovery-abandoned': 1,
  'gate-broken': 2,
}

/**
 * Collapses high-cardinality decision kinds into one cluster row per kind,
 * AND collapses several condition rows for the SAME task into one entity
 * group card.
 *
 * These are two different problems with the same symptom (row-count
 * inflation) but different causes:
 * - Kind clustering: many DIFFERENT subjects sharing a kind (900
 *   draft-proposals) — collapsed to a "view all" link, count preserved.
 * - Entity grouping: the SAME subject represented by several independently
 *   derived condition rows (ADR-0057 kinds never reconcile with each other,
 *   so a `failed` task can also carry `recovery-abandoned` and `gate-broken`
 *   rows) — collapsed to one card with one chosen verb set (see
 *   ENTITY_GROUP_KIND_RANK) and the other kinds surfaced as read-only badges,
 *   because two verb sets for one task can — and did — contradict each other
 *   (a recovery-exhausted `failed` row saying Continue/Restart won't help,
 *   next to a `recovery-abandoned` row offering a live Restart for the same
 *   task).
 *
 * Rules:
 * - Per-task condition rows (isGroupableConditionKind) sharing a non-empty
 *   entityId → one entity-group card, verb set chosen by
 *   ENTITY_GROUP_KIND_RANK / recoveryExhausted.
 * - Any other condition kind (stale-worktree, arc-failed) → always individual.
 * - draft-proposal → always one cluster row (the proposals backlog can reach 900+).
 * - Any other decision kind whose count exceeds CLUSTER_THRESHOLD → one cluster row.
 *
 * The cluster/group row is inserted at the position of the first
 * (highest-priority, most-recent) item of that kind/entity within the
 * already-sorted list.
 */
export function buildRenderedRows(sorted: ActionQueueItem[]): RenderedRow[] {
  const kindCounts = new Map<string, number>()
  for (const item of sorted) {
    kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1)
  }

  const entityBuckets = new Map<string, ActionQueueItem[]>()
  for (const item of sorted) {
    if (!item.entityId || !isGroupableConditionKind(item.kind)) continue
    const bucket = entityBuckets.get(item.entityId)
    if (bucket) bucket.push(item)
    else entityBuckets.set(item.entityId, [item])
  }

  const emittedClusters = new Set<string>()
  const emittedEntityGroups = new Set<string>()
  const result: RenderedRow[] = []

  for (const item of sorted) {
    const bucket = item.entityId ? entityBuckets.get(item.entityId) : undefined
    if (bucket && bucket.length > 1) {
      if (emittedEntityGroups.has(item.entityId)) continue
      emittedEntityGroups.add(item.entityId)
      const primary = bucket.reduce((best, cur) => {
        const rank = (x: ActionQueueItem) =>
          x.recoveryExhausted ? -1 : (ENTITY_GROUP_KIND_RANK[x.kind] ?? 100)
        return rank(cur) < rank(best) ? cur : best
      })
      const badgeKinds = [...new Set(bucket.filter((b) => b !== primary).map((b) => b.kind))]
      result.push({ type: 'entityGroup', primary, badgeKinds })
      continue
    }

    const count = kindCounts.get(item.kind) ?? 1
    const isCondition =
      isGroupableConditionKind(item.kind) || NEVER_CLUSTER_KINDS.has(item.kind)
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
