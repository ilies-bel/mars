/**
 * The one place the triage search box and kind filter are applied.
 *
 * They used to be applied to the flat item list only, while `serverGroups` —
 * the pre-grouped cause rows the daemon sends — went straight through to
 * `buildRenderedRows` untouched. Both controls therefore excluded a third of
 * the queue without saying so. Typing pure gibberish left the three cluster
 * rows sitting at the top of an otherwise empty page, looking exactly like
 * matches; setting the kind filter to `proposal` left the three failure
 * clusters in place. Measured: 3 groups survived `zzzzqqq`, and the header
 * still read 38.
 *
 * That is worse than returning nothing. A search that returns confident-looking
 * rows unrelated to the query teaches the reader that the rows are the answer.
 *
 * So filtering happens here, over both shapes at once, and returns the counts
 * the header needs to say what it did.
 */
import { causeGroupPhrase } from '@/shared/causePhrase'
import type { ActionQueueItem, ActionQueueGroupRow } from '@/shared/schemas'

/**
 * Does one row match the query?
 *
 * Only fields a reader can actually see on the row: its name, the plain
 * summary, the goal it was pursuing, and the entity it concerns — the last
 * because an id is the one thing an operator pastes in verbatim.
 */
export const itemMatchesQuery = (item: ActionQueueItem, q: string): boolean =>
  (item.title?.toLowerCase().includes(q) ?? false) ||
  (item.humanSummary?.toLowerCase().includes(q) ?? false) ||
  (item.operatorGoal?.toLowerCase().includes(q) ?? false) ||
  // entityTitle is the entity's real human name (e.g. the PRD title on
  // slice-failed rows) — preferred over the truncated entityId slug. It
  // arrived on main while this file was being written; the inline predicate
  // it was added to no longer exists, so it lands here instead.
  (item.entityTitle?.toLowerCase().includes(q) ?? false) ||
  (item.entityId?.toLowerCase().includes(q) ?? false)

export interface FilteredQueue {
  items: ActionQueueItem[]
  groups: readonly ActionQueueGroupRow[] | undefined
  /** True when either control is narrowing the list. */
  active: boolean
  /**
   * Counting lives in `clusterRows.countRenderedItems`, over the rows the page
   * actually draws — not here.
   *
   * This module used to compute its own totals as `items.length + Σ
   * group.count`, but `buildRenderedRows` excludes every server-group member
   * from that flat list before rendering. So each grouped task was counted
   * twice and the header claimed "53 hidden" beside an empty state saying all
   * 36 were still there. A second definition of the same number is the defect,
   * not the arithmetic.
   */
}

export function filterQueue(
  sorted: readonly ActionQueueItem[],
  serverGroups: readonly ActionQueueGroupRow[] | undefined,
  opts: { kind: string; query: string },
): FilteredQueue {
  const kind = opts.kind
  const q = opts.query.trim().toLowerCase()
  const active = kind !== '' || q !== ''

  if (!active) {
    return {
      items: [...sorted],
      groups: serverGroups,
      active: false,
    }
  }

  let items = [...sorted]
  if (kind) items = items.filter((i) => i.kind === kind)
  if (q) items = items.filter((i) => itemMatchesQuery(i, q))

  const groups = (serverGroups ?? []).flatMap((g) => {
    if (kind && g.kind !== kind) return []
    if (!q) return [g]
    // The cause sentence is the text the row actually shows, so it is what a
    // reader is searching against — match it before looking inside.
    if (causeGroupPhrase(g.signature, g.causeLabel).toLowerCase().includes(q)) return [g]
    // Otherwise the group survives on its matching members only, and its count
    // narrows with it. A group that kept saying "17 tasks" while showing two
    // matches would be a second way of lying about what was found.
    const members = g.members.filter((m) => itemMatchesQuery(m, q))
    if (members.length === 0) return []
    return [{ ...g, members, count: members.length }]
  })

  return {
    items,
    groups,
    active: true,
  }
}
