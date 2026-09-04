/**
 * Clustering and entity-grouping logic for the `mars action-queue watch` TUI.
 *
 * Ported from ui/src/entities/actionQueue/clusterRows.ts — same algorithm,
 * no React dependency, operates on the TUI's ActionQueueRow projection type.
 *
 * Two distinct row-count inflation problems are solved here:
 *
 *  - **Kind clustering**: many DIFFERENT subjects sharing a kind (900
 *    draft-proposals) → collapsed to a "N× kind" summary row.
 *  - **Entity grouping**: the SAME task subject represented by several
 *    independently-derived condition rows (ADR-0057 kinds never reconcile
 *    with each other, so a `failed` task can also carry `recovery-abandoned`
 *    and `gate-broken` rows) → collapsed to one row with one chosen verb set
 *    and the other kinds surfaced as read-only badges.
 */

import type { ActionQueueRow } from '../core/daemon/view/action-queue'

// ── isGroupableConditionKind ──────────────────────────────────────────────────

/**
 * Non-groupable kinds: operator-facing rows that are NOT per-task conditions
 * and therefore must never be folded into a task entity group.
 *
 * Mirrors NON_TASK_FAILURE_KINDS in orchestrator/src/core/daemon/view/action-queue.ts
 * (not exported from that module). If the daemon adds a new non-task kind,
 * add it here too so the TUI keeps grouping correct.
 */
const NON_GROUPABLE_KINDS: ReadonlySet<string> = new Set([
  'stale-worktree',
  'draft-proposal',
  'awaiting-validation',
  'awaiting-validation-preview-gone',
  'awaiting-human',
  'reflect-recommended',
  'workflow-draft-pending',
  'scorer-suggested',
  'tool-promotion',
  'hitl-slice-needs-operator',
  'daemon-outage',
  'health-check-alert',
])

/**
 * Whether a kind is a per-task condition that can co-occur with other
 * conditions for the same task, and so must be collapsed onto one card.
 *
 * Returns true for all task-failure kinds (failed, recovery-abandoned,
 * gate-broken, daemon-killed, …) and false for standalone operator-decision
 * or non-task-condition kinds.
 */
export const isGroupableConditionKind = (kind: string): boolean =>
  !NON_GROUPABLE_KINDS.has(kind)

// ── Canonical "needs you" count ───────────────────────────────────────────────

/**
 * The single canonical "needs you" count for the TUI header: distinct open
 * subjects excluding draft-proposal rows (a backlog of shaped ideas, not an
 * operational alert needing immediate action).
 *
 * Several condition kinds (failed, recovery-abandoned, gate-broken, …) derive
 * independently per ADR-0057, so one failed task can raise several open rows.
 * A naive item count would report those as several items; this function
 * collapses them to one, matching the entity-grouping buildRenderedTuiRows
 * performs — a task shown on three rows is one subject needing attention,
 * not three.
 */
export function countNeedsYou(items: readonly ActionQueueRow[]): number {
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

// ── Sort ──────────────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 }

export function sortItems(items: ActionQueueRow[]): ActionQueueRow[] {
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
 * draft-proposal is always clustered regardless of count.
 */
const CLUSTER_THRESHOLD = 5

/**
 * Kinds that represent per-entity conditions requiring individual attention.
 * Never collapsed into a summary cluster row even when their count is high.
 */
const NEVER_CLUSTER_KINDS: ReadonlySet<string> = new Set([
  'stale-worktree',
  'arc-failed',
])

export type RenderedTuiRow =
  | { type: 'item'; item: ActionQueueRow }
  | { type: 'cluster'; kind: string; count: number; latestAt: string }
  | { type: 'entityGroup'; primary: ActionQueueRow; badgeKinds: string[] }

/**
 * Precedence used to pick the ONE verb set an entity-group row exposes when a
 * single task has raised more than one condition row. A recovery-exhausted row
 * always wins (rank -1): Continue/Restart would error on it, so its
 * carry-forward panel is the only correct advice. Absent that, prefer the
 * structured `failed` row, then `recovery-abandoned`, then `gate-broken`.
 */
const ENTITY_GROUP_KIND_RANK: Record<string, number> = {
  failed: 0,
  'recovery-abandoned': 1,
  'gate-broken': 2,
}

/**
 * Transform a sorted flat list of ActionQueueRow items into RenderedTuiRows,
 * applying two distinct collapse strategies:
 *
 * 1. **Entity grouping** — per-task condition rows sharing a non-empty entityId
 *    collapse to one `entityGroup` row. The primary item is chosen by
 *    ENTITY_GROUP_KIND_RANK (recoveryExhausted wins over all else); the
 *    remaining kinds appear as badge strings.
 *
 * 2. **Kind clustering** — decision kinds whose count exceeds CLUSTER_THRESHOLD
 *    collapse to one `cluster` row. `draft-proposal` is always clustered
 *    (the proposals backlog can reach 900+). Groupable condition kinds and
 *    NEVER_CLUSTER_KINDS are always rendered individually.
 *
 * The input must be pre-sorted (use `sortItems`). The collapse/cluster row is
 * inserted at the position of the first (highest-priority, most-recent) item
 * of that kind/entity in the sorted list.
 */
export function buildRenderedTuiRows(sorted: ActionQueueRow[]): RenderedTuiRow[] {
  // Count occurrences per kind for threshold clustering.
  const kindCounts = new Map<string, number>()
  for (const item of sorted) {
    kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1)
  }

  // Build buckets of all items per entityId, but only for groupable kinds.
  const entityBuckets = new Map<string, ActionQueueRow[]>()
  for (const item of sorted) {
    if (!item.entityId || !isGroupableConditionKind(item.kind)) continue
    const bucket = entityBuckets.get(item.entityId)
    if (bucket) bucket.push(item)
    else entityBuckets.set(item.entityId, [item])
  }

  const emittedClusters = new Set<string>()
  const emittedEntityGroups = new Set<string>()
  const result: RenderedTuiRow[] = []

  for (const item of sorted) {
    // ── Entity grouping ───────────────────────────────────────────────────
    const bucket = item.entityId ? entityBuckets.get(item.entityId) : undefined
    if (bucket && bucket.length > 1) {
      if (emittedEntityGroups.has(item.entityId)) continue
      emittedEntityGroups.add(item.entityId)
      // Pick the primary by rank; recoveryExhausted always wins.
      const primary = bucket.reduce((best, cur) => {
        const rank = (x: ActionQueueRow): number =>
          x.recoveryExhausted ? -1 : (ENTITY_GROUP_KIND_RANK[x.kind] ?? 100)
        return rank(cur) < rank(best) ? cur : best
      })
      const badgeKinds = [
        ...new Set(bucket.filter((b) => b !== primary).map((b) => b.kind)),
      ]
      result.push({ type: 'entityGroup', primary, badgeKinds })
      continue
    }

    // ── Kind clustering ───────────────────────────────────────────────────
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
      // Drop individual rows for this kind — represented by the cluster.
    } else {
      result.push({ type: 'item', item })
    }
  }

  return result
}
