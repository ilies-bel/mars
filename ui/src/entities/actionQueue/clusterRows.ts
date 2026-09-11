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
import type { ActionQueueItem, ActionQueueGroupRow, AlertVerb } from '@/shared/schemas'

// ── Canonical "needs you" count ────────────────────────────────────────────

/**
 * The single canonical "needs you" count: distinct open subjects excluding
 * draft-proposal rows (a backlog of shaped ideas, not an operational alert
 * needing immediate action) and excluding NOTICES.
 *
 * A notice is informational by construction — `action-queue-kinds.ts` classes
 * `stale-worktree`, `reflect-recommended`, `phantom-task` and friends that way
 * precisely because Mars handles them itself, and their own copy says so:
 * "this is informational, no action needed from you". Counting them made the
 * badge tooltip read "37 items need attention" over a list two of whose rows
 * stated that they needed nothing. A workload number that includes its own
 * opt-outs is not a workload number. Server groups contribute their MEMBERS, matching
 * the server's counterpart — grouping is a display collapse, not fewer
 * decisions. Every surface that renders this concept — the
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
export function countNeedsYou(
  items: readonly ActionQueueItem[],
  serverGroups?: readonly ActionQueueGroupRow[],
): number {
  // A server group's MEMBERS are the subjects, not the group.
  //
  // This counted the group as one, while the server's counterpart counts each
  // member — so the two definitions the doc comment above calls mirrors
  // disagreed by (members − 1) per group. With three groups holding 22 tasks
  // that is a gap of 19, which is how the badge could read 36 while the page
  // rendered rows standing for 53. A group is a display collapse; it does not
  // reduce the number of tasks awaiting a decision, and the group header says
  // "17 tasks" precisely because it is seventeen.
  const serverGroupMemberIds = new Set<string>()
  const seenEntities = new Set<string>()
  let count = 0
  for (const sg of (serverGroups ?? [])) {
    for (const m of sg.members) serverGroupMemberIds.add(m.id)
    if (sg.kind === 'draft-proposal') continue
    for (const m of sg.members) {
      if (m.class === 'notice') continue
      if (m.entityId && isGroupableConditionKind(m.kind)) {
        if (seenEntities.has(m.entityId)) continue
        seenEntities.add(m.entityId)
      }
      count++
    }
  }

  for (const item of items) {
    if (serverGroupMemberIds.has(item.id)) continue // counted via server group
    if (item.kind === 'draft-proposal') continue
    if (item.class === 'notice') continue
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
 * A plain alias over the daemon's task-failure classification
 * (`isTaskFailureActionQueueKind`). This used to need a local
 * `EXTRA_GROUPABLE_CONDITION_KINDS` carve-out for `recovery-abandoned`: the
 * daemon's own complement (`NON_TASK_FAILURE_KINDS` in
 * `orchestrator/src/core/daemon/view/action-queue.ts`) already classified it
 * as a task failure, but the UI's `taskFailureKinds` mirror
 * (ui/src/shared/schemas.ts) had simply drifted and omitted it — silently
 * excluding it from grouping and leaving a live Restart button standing next
 * to a recovery-exhausted `failed` row warning that Restart would discard
 * real work. That entry is restored now, so no carve-out is needed.
 *
 * `taskFailureKinds` (ui/src/shared/schemas.ts) is now checked against the
 * daemon's own complement by a drift-gate test
 * (ui/src/shared/taskFailureKinds.driftGate.test.ts). If a per-task condition
 * fails to group here, fix the mirror; do not reintroduce a local carve-out.
 */
const isGroupableConditionKind = (kind: string): boolean => isTaskFailureActionQueueKind(kind)

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
   * Cause group: multiple DIFFERENT tasks sharing the same `(kind, failureReasonCode)`.
   * Mirrors the CLI's `groupActionQueueRows` algorithm (HR-3 shared grouping model) —
   * same key, same singleton pass-through, same bulk-action surface.
   * Singletons always pass through as plain `item` rows.
   *
   * When produced from a server-sent group row, `causeLabel` carries the server's
   * pre-computed human-readable label and takes precedence over the client fallback.
   */
  | {
      type: 'causeGroup'
      /** Synthetic stable id: `causeGroup:<kind>:<signature>`. */
      id: string
      kind: string
      /** The shared `failureReasonCode` that defines this group. */
      signature: string
      /**
       * Human-readable cause label from the server (HR-3). When present,
       * `TriageCauseGroupRow` prefers this over the client-computed label.
       * Absent for client-side-computed cause groups.
       */
      causeLabel?: string
      count: number
      /**
       * Extra condition kinds folded onto a member row, keyed by member id —
       * conditions raised independently for the same task (ADR-0057) that
       * would otherwise draw a second row for it elsewhere on the page.
       */
      memberBadges?: Record<string, string[]>
      /** Highest priority among members. */
      priority: 'high' | 'normal' | 'low'
      /** All member rows — expose for expand display and bulk actions. */
      members: ActionQueueItem[]
      /**
       * Kind's declared bulk-resolve verb from the server (carried through
       * from `ActionQueueGroupRow.bulkResolveVerb`). When present, the group
       * card renders this as its primary action. When absent, only Snooze is
       * offered.
       */
      bulkResolveVerb?: AlertVerb
    }

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

/** Highest priority value among a set of items. */
function highestPriority(items: ActionQueueItem[]): 'high' | 'normal' | 'low' {
  if (items.some((r) => r.priority === 'high')) return 'high'
  if (items.some((r) => r.priority === 'normal')) return 'normal'
  return 'low'
}

/**
 * Collapses high-cardinality decision kinds into one cluster row per kind,
 * collapses several condition rows for the SAME task into one entity-group
 * card, AND collapses several DIFFERENT tasks sharing the same failure cause
 * into one cause-group card.
 *
 * Three distinct compression axes — same symptom (row inflation), different
 * causes:
 *
 * 1. **Kind clustering** — many DIFFERENT subjects sharing a high-cardinality
 *    decision kind (900 draft-proposals) → collapsed to a "view all" link.
 *
 * 2. **Entity grouping** — the SAME task represented by several independently
 *    derived condition rows (ADR-0057 kinds never reconcile) → collapsed to
 *    one card with one chosen verb set, others as badges.
 *
 * 3. **Cause grouping** — many DIFFERENT tasks sharing the same
 *    `(kind, failureReasonCode)` (19 PRDs that all timed out during slicing)
 *    → collapsed to one collapsible row with a bulk action. Mirrors the CLI's
 *    `groupActionQueueRows` algorithm (HR-3 shared model: one algorithm,
 *    three call sites).
 *
 * Rules:
 * - Per-task condition rows sharing a non-empty entityId → entity-group card.
 * - Items NOT in an entity group, sharing a non-empty failureReasonCode and
 *   the same kind → cause-group card (singletons pass through as items).
 * - Any other condition kind (stale-worktree, arc-failed) → always individual.
 * - draft-proposal → always one cluster row.
 * - Any other decision kind whose count exceeds CLUSTER_THRESHOLD → cluster row.
 *
 * Each group row is inserted at the position of its first (highest-priority,
 * most-recent) member within the already-sorted list.
 */
/**
 * How many queue items one rendered row stands for.
 *
 * The header states "showing N of M" and both ends must be countable from the
 * page, so both are summed over the rows the page actually draws. Deriving
 * them from the raw feed instead is what produced "53 hidden" beside "All 36
 * items are still there": the flat list still contained every member of every
 * server group, and the group counts were added on top, so each grouped task
 * was counted twice.
 */
export const renderedRowWeight = (row: RenderedRow): number => {
  switch (row.type) {
    case 'cluster':
    case 'causeGroup':
      return row.count
    // An entityGroup is ONE task wearing several condition badges. It is one
    // decision and one row, so it counts once — the badges are not work.
    case 'entityGroup':
    case 'item':
      return 1
  }
}

/** Total queue items standing behind a list of rendered rows. */
export const countRenderedItems = (rows: readonly RenderedRow[]): number =>
  rows.reduce((n, row) => n + renderedRowWeight(row), 0)

export function buildRenderedRows(
  sorted: ActionQueueItem[],
  serverGroups?: readonly ActionQueueGroupRow[],
): RenderedRow[] {
  // Prepend server-pre-grouped rows as causeGroup RenderedRows, and exclude
  // their members from the flat sort so they are not double-rendered.
  const serverGroupMemberIds = new Set<string>()
  // entityId → the group member row that already stands for that task.
  const memberIdByEntity = new Map<string, string>()
  const serverGroupRows: RenderedRow[] = []
  for (const sg of (serverGroups ?? [])) {
    for (const m of sg.members) {
      serverGroupMemberIds.add(m.id)
      if (m.entityId) memberIdByEntity.set(m.entityId, m.id)
    }
    serverGroupRows.push({
      type: 'causeGroup',
      id: `causeGroup:${sg.kind}:${sg.signature}`,
      kind: sg.kind,
      signature: sg.signature,
      causeLabel: sg.causeLabel,
      count: sg.count,
      priority: sg.priority,
      members: sg.members,
      bulkResolveVerb: sg.bulkResolveVerb,
      memberBadges: {},
    })
  }

  // A task whose entity ALREADY appears inside a server group does not get a
  // second row of its own — it gets a badge on the row that already stands
  // for it, exactly as co-occurring conditions do within `entityBuckets`.
  //
  // Without this, one task rendered twice in two places under two different
  // names: a loose `env-incident` row headlined with its arc's goal, and a
  // group member headlined with the rescue-operator's summary. Restarting
  // from the first, an operator believed they were restarting the other.
  //
  // It is also why the queue could not be added up. `countNeedsYou` folds
  // these onto one subject — correctly — while the page drew both, so the
  // rows summed two higher than every count on the screen.
  const foldedIntoGroup = new Set<string>()
  for (const item of sorted) {
    if (serverGroupMemberIds.has(item.id)) continue
    if (!item.entityId) continue
    const memberId = memberIdByEntity.get(item.entityId)
    if (memberId === undefined) continue
    foldedIntoGroup.add(item.id)
    for (const row of serverGroupRows) {
      if (row.type !== 'causeGroup' || row.memberBadges === undefined) continue
      if (!row.members.some((m) => m.id === memberId)) continue
      const existing = row.memberBadges[memberId] ?? []
      if (!existing.includes(item.kind)) row.memberBadges[memberId] = [...existing, item.kind]
    }
  }

  const remainingSorted =
    serverGroupMemberIds.size > 0 || foldedIntoGroup.size > 0
      ? sorted.filter((i) => !serverGroupMemberIds.has(i.id) && !foldedIntoGroup.has(i.id))
      : sorted
  const kindCounts = new Map<string, number>()
  for (const item of remainingSorted) {
    kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1)
  }

  const entityBuckets = new Map<string, ActionQueueItem[]>()
  for (const item of remainingSorted) {
    if (!item.entityId || !isGroupableConditionKind(item.kind)) continue
    const bucket = entityBuckets.get(item.entityId)
    if (bucket) bucket.push(item)
    else entityBuckets.set(item.entityId, [item])
  }

  // Cause buckets: group items by (kind, failureReasonCode).
  // Items already destined for a multi-item entity group are excluded — they
  // are collapsed by entity-grouping and must not also appear in a cause group.
  const causeBuckets = new Map<string, ActionQueueItem[]>()
  for (const item of remainingSorted) {
    const entityBucket = item.entityId ? entityBuckets.get(item.entityId) : undefined
    if (entityBucket && entityBucket.length > 1) continue
    const sig = item.failureReasonCode?.trim()
    if (!sig) continue
    const key = `${item.kind}\0${sig}`
    const bucket = causeBuckets.get(key)
    if (bucket) bucket.push(item)
    else causeBuckets.set(key, [item])
  }

  const emittedClusters = new Set<string>()
  const emittedEntityGroups = new Set<string>()
  const emittedCauses = new Set<string>()
  const result: RenderedRow[] = []

  for (const item of remainingSorted) {
    // ── 1. Entity-group: several conditions for the SAME task ────────────────
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

    // ── 2. Cause-group: different tasks sharing the same failure cause ────────
    const sig = item.failureReasonCode?.trim()
    const causeKey = sig ? `${item.kind}\0${sig}` : null
    if (causeKey) {
      if (emittedCauses.has(causeKey)) continue // already emitted as group
      const causeMembers = causeBuckets.get(causeKey)!
      if (causeMembers.length > 1) {
        emittedCauses.add(causeKey)
        result.push({
          type: 'causeGroup',
          id: `causeGroup:${item.kind}:${sig}`,
          kind: item.kind,
          // sig is guaranteed non-null here: causeKey is only truthy when sig is a non-empty string
          signature: sig!,
          count: causeMembers.length,
          priority: highestPriority(causeMembers),
          members: causeMembers,
        })
        continue
      }
      // Singleton cause: fall through to item/cluster handling.
    }

    // ── 3. Kind-cluster or individual item ───────────────────────────────────
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

  // Server-grouped rows are prepended: they represent high-signal groups the
  // server already computed and they should appear first in the list.
  return [...serverGroupRows, ...result]
}
