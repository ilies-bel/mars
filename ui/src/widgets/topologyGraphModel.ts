/**
 * Pure data → G6 transforms for the Topology Cloud view.
 *
 * Everything here is side-effect-free and DOM-free so it can be unit-tested
 * without instantiating G6 or a canvas. `TopologyView.tsx` owns all the
 * imperative G6 / DOM wiring and consumes the structures this module emits.
 *
 * Ported from the prototype's rollup / `dominant()` / g6-data logic
 * (/tmp/mars-graph-proto/app.js), with the prototype's invented `Done` cluster
 * dropped — the real schema's cluster enum is only
 * `'Queued' | 'In progress' | 'Blocked' | 'Failed'`.
 */

import type { ComboData, EdgeData, NodeData } from '@antv/g6'
import { blockerKey, type ChainResult } from '@/shared/chainTrace'
import type { Cluster, ProgressProposalNode, ProgressTask } from '@/shared/schemas'

/**
 * Per-status hex palette for the G6 Canvas renderer (which cannot read CSS
 * custom properties). These MUST mirror the `--color-dag-*` tokens in
 * `index.css` so the canvas and the SVG TaskDetailDrawer don't drift.
 *
 *  - `fill` / `stroke` / `text`: the task-node rect.
 *  - `dot`: the legend swatch + stroke accent.
 *  - `combo`: the dark, status-tinted fill of a collapsed proposal card.
 */
export interface ClusterStyle {
  fill: string
  stroke: string
  text: string
  dot: string
  combo: string
}

export const CLUSTER_STYLE: Record<Cluster, ClusterStyle> = {
  'In progress': { fill: '#431407', stroke: '#ea580c', text: '#fdba74', dot: '#ea580c', combo: '#2c1d14' },
  // Blocked: warm amber/ochre — separated from Queued's cool grey.
  Blocked: { fill: '#3f2a14', stroke: '#d9a441', text: '#fde9c8', dot: '#d9a441', combo: '#2a2114' },
  // Queued: cool grey — clearly cooler than Blocked.
  Queued: { fill: '#2a2a30', stroke: '#9ca3af', text: '#e5e7eb', dot: '#9ca3af', combo: '#23232b' },
  Failed: { fill: '#450a0a', stroke: '#dc2626', text: '#fca5a5', dot: '#dc2626', combo: '#2c1414' },
}

/** Proposal-identity palette (purple) + edge colour for the Canvas. */
export const PROPOSAL_STROKE = '#7c3aed'
export const PROPOSAL_TEXT = '#c4b5fd'
export const EDGE_BLOCK = '#6b7280'
/** Bright purple lineage accent used for hover-lit / active elements. */
export const ACTIVE_ACCENT = '#c4b5fd'
/** Dark canvas surface — mirrors `--color-surface-dark`. */
export const CANVAS_SURFACE = '#251812'

/**
 * Tie-break severity when two clusters share the plurality.
 * Failed > In progress > Blocked > Queued.
 */
const SEVERITY: Record<Cluster, number> = {
  Failed: 4,
  'In progress': 3,
  Blocked: 2,
  Queued: 1,
}

/** Per-proposal cluster tally. */
export interface Rollup {
  total: number
  counts: Record<Cluster, number>
}

const emptyCounts = (): Record<Cluster, number> => ({
  Queued: 0,
  'In progress': 0,
  Blocked: 0,
  Failed: 0,
})

/**
 * Tally each proposal's tasks by cluster. Tasks whose `parentProposalId` is
 * not among the supplied proposals are ignored (they aren't part of any combo).
 */
export const rollupByProposal = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
): Map<string, Rollup> => {
  const rollup = new Map<string, Rollup>()
  for (const p of proposals) rollup.set(p.id, { total: 0, counts: emptyCounts() })
  for (const t of tasks) {
    if (t.parentProposalId == null) continue
    const r = rollup.get(t.parentProposalId)
    if (r) {
      r.total++
      r.counts[t.cluster]++
    }
  }
  return rollup
}

/**
 * Dominant status = the PLURALITY cluster (largest share), NOT "any failure",
 * so 1 failed task in 14 doesn't paint the whole card red. Ties break by
 * severity. An empty rollup falls back to 'Queued'.
 */
export const dominant = (r: Rollup): Cluster => {
  // No tasks → no plurality; rest at the neutral 'Queued' tint rather than
  // letting the severity tiebreak pick the most-severe (Failed) on all-zeros.
  if (r.total === 0) return 'Queued'
  let best: Cluster = 'Queued'
  let bestCount = -1
  for (const c of ['Failed', 'In progress', 'Blocked', 'Queued'] as Cluster[]) {
    const n = r.counts[c]
    if (n > bestCount || (n === bestCount && SEVERITY[c] > SEVERITY[best])) {
      best = c
      bestCount = n
    }
  }
  return best
}

const comboId = (proposalId: string): string => `combo:${proposalId}`

/** Strip the `combo:` prefix back to the bare proposal id. */
export const proposalIdFromComboId = (id: string): string => id.replace(/^combo:/, '')

/**
 * Stable id for the synthetic combo that collects ad hoc tasks — those with no
 * parentProposalId or a parentProposalId that does not match any known proposal.
 * Distinct from real proposal combos (which are `combo:<proposalId>`).
 */
export const ADHOC_COMBO_ID = 'combo:__adhoc__'

/**
 * Synthetic proposal id used as the combo's `proposalId` data field and as the
 * key for `lit.proposals` / `comboFilterDim` lookups on the ad hoc combo.
 */
const ADHOC_PROPOSAL_ID = proposalIdFromComboId(ADHOC_COMBO_ID) // '__adhoc__'

/** First non-empty line of a task's prompt, used as its node label. */
const taskLabel = (t: ProgressTask): string => {
  const first = t.prompt.split('\n')[0]?.trim()
  return first && first.length > 0 ? first : t.id
}

export interface G6GraphData {
  nodes: NodeData[]
  edges: EdgeData[]
  combos: ComboData[]
}

/**
 * Build the G6 GraphData for the cloud overview.
 *
 *  - One COLLAPSED combo per proposal, carrying its plurality `dom` status and
 *    task `count` in `data`.
 *  - One synthetic COLLAPSED combo (`ADHOC_COMBO_ID`) for ad hoc tasks — those
 *    whose `parentProposalId` is null or does not match any known proposal. The
 *    combo is omitted when no ad hoc tasks exist, so proposal-only datasets are
 *    visually unchanged.
 *  - One task node per task, assigned to its proposal combo or to the ad hoc
 *    combo. Every task is now in scope; no tasks are dropped.
 *  - One blocker edge per `blockedBy` entry whose endpoints are both in scope
 *    (i.e. in the task list), keyed with `blockerKey(blocker, task)` so the
 *    highlight map (which uses the same key) matches. Cross-boundary edges
 *    between ad hoc tasks and proposal tasks are included freely.
 */
export const buildG6Data = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
): G6GraphData => {
  const rollup = rollupByProposal(tasks, proposals)
  const proposalIds = new Set(proposals.map((p) => p.id))

  const isAdHoc = (t: ProgressTask): boolean =>
    t.parentProposalId == null || !proposalIds.has(t.parentProposalId)

  const combos: ComboData[] = proposals.map((p) => {
    const r = rollup.get(p.id) ?? { total: 0, counts: emptyCounts() }
    return {
      id: comboId(p.id),
      data: { label: p.title, proposalId: p.id, count: r.total, dom: dominant(r) },
      style: { collapsed: true },
    }
  })

  // Emit the synthetic Ad hoc combo only when at least one ad hoc task exists,
  // so proposal-only datasets are not affected.
  const adHocTasks = tasks.filter(isAdHoc)
  if (adHocTasks.length > 0) {
    const adHocCounts = emptyCounts()
    for (const t of adHocTasks) adHocCounts[t.cluster]++
    const adHocRollup: Rollup = { total: adHocTasks.length, counts: adHocCounts }
    combos.push({
      id: ADHOC_COMBO_ID,
      data: { label: 'Ad hoc', proposalId: ADHOC_PROPOSAL_ID, count: adHocTasks.length, dom: dominant(adHocRollup) },
      style: { collapsed: true },
    })
  }

  // Every task is now in scope — proposal tasks go to their proposal combo;
  // ad hoc tasks go to the synthetic ADHOC combo.
  const taskIds = new Set(tasks.map((t) => t.id))

  const nodes: NodeData[] = tasks.map((t) => ({
    id: t.id,
    combo: isAdHoc(t) ? ADHOC_COMBO_ID : comboId(t.parentProposalId as string),
    data: {
      label: taskLabel(t),
      cluster: t.cluster,
      // Ad hoc tasks carry the synthetic proposal id so computeStateMap can
      // derive ADHOC combo lighting from node membership.
      proposalId: isAdHoc(t) ? ADHOC_PROPOSAL_ID : t.parentProposalId,
    },
  }))

  const edges: EdgeData[] = []
  for (const t of tasks) {
    for (const b of t.blockedBy ?? []) {
      // both endpoints must be in scope (otherwise the edge dangles)
      if (!taskIds.has(b) || !taskIds.has(t.id)) continue
      edges.push({ id: blockerKey(b, t.id), source: b, target: t.id, data: { kind: 'blocker' } })
    }
  }

  return { nodes, edges, combos }
}

/**
 * The live G6 element arrays the highlight resolver reads. Decoupled from the
 * Graph instance so this stays pure and testable.
 */
export interface ElementSnapshot {
  nodes: ReadonlyArray<NodeData>
  edges: ReadonlyArray<EdgeData>
  combos: ReadonlyArray<ComboData>
}

/** Inputs that dim/brighten elements: the persistent filters + the hover set. */
export interface HighlightInputs {
  /** Toolbar search; null = no search. Only these ids stay full-opacity. */
  searchMatchIds: Set<string> | null | undefined
  /** Cluster names + 'Proposal' whose nodes dim. */
  ghostedClusters: Set<string> | null | undefined
  /** Active hover-trace lit set, or null when nothing is hovered. */
  lit: ChainResult | null
}

/**
 * Resolve the per-element G6 state map in ONE place (applied via a single
 * batched `setElementState`). This is the single source of truth for how the
 * three dim sources combine:
 *
 *   - An element is FILTERED-dim if it fails the search filter OR the cluster
 *     filter (these persist on top of everything else).
 *   - When a hover trace is active (`lit`), an element is 'active' only if it's
 *     in the lit set AND not filtered; everything else is 'dim'.
 *   - With no hover, an element is 'dim' if filtered, else at-rest (`[]`).
 *
 * An edge survives the filters only if BOTH its endpoints do.
 */
export const computeStateMap = (snapshot: ElementSnapshot, inputs: HighlightInputs): Record<string, string[]> => {
  const { searchMatchIds: search, ghostedClusters: gc, lit } = inputs
  const map: Record<string, string[]> = {}

  const nodeById = new Map<string, NodeData>(snapshot.nodes.map((n) => [String(n.id), n]))

  // Derive lit proposal ids from chainTrace's proposals set PLUS each lit
  // node's `data.proposalId`. The second source is needed for the synthetic ad
  // hoc combo: chainTrace never adds `'__adhoc__'` to proposals (ad hoc tasks
  // have a null parentProposalId, so attachProvenance skips them), but the ad
  // hoc combo should still light when one of its tasks is hover-lit.
  const litProposalIds = new Set<string>(lit?.proposals ?? [])
  if (lit) {
    for (const n of snapshot.nodes) {
      if (lit.nodes.has(String(n.id)) && n.data?.proposalId) {
        litProposalIds.add(String(n.data.proposalId))
      }
    }
  }

  const taskFilterDim = (id: string, cluster: unknown): boolean => {
    if (search != null && !search.has(id)) return true
    if (gc != null && gc.has(String(cluster))) return true
    return false
  }
  const comboFilterDim = (proposalId: string): boolean => {
    if (search != null && !search.has(proposalId)) return true
    if (gc != null && gc.has('Proposal')) return true
    return false
  }
  const resolve = (litMember: boolean, filtered: boolean): string[] =>
    lit ? (litMember && !filtered ? ['active'] : ['dim']) : filtered ? ['dim'] : []

  for (const n of snapshot.nodes) {
    const id = String(n.id)
    map[id] = resolve(lit?.nodes.has(id) ?? false, taskFilterDim(id, n.data?.cluster))
  }
  for (const e of snapshot.edges) {
    const id = String(e.id)
    const s = nodeById.get(String(e.source))
    const t = nodeById.get(String(e.target))
    const filtered =
      (s ? taskFilterDim(String(s.id), s.data?.cluster) : false) ||
      (t ? taskFilterDim(String(t.id), t.data?.cluster) : false)
    map[id] = resolve(lit?.edges.has(id) ?? false, filtered)
  }
  for (const c of snapshot.combos) {
    const id = String(c.id)
    const pid = String(c.data?.proposalId ?? proposalIdFromComboId(id))
    map[id] = resolve(litProposalIds.has(pid), comboFilterDim(pid))
  }
  return map
}

/**
 * A cheap signature of the input data: when this string changes between
 * renders, the graph data must be rebuilt (and any drill-in state reset).
 * Counts + a hash of (id, cluster, blockedBy, parentProposalId) per task and
 * (id, title) per proposal catches every meaningful structural change without
 * a deep diff.
 */
export const dataSignature = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
): string => {
  const taskSig = tasks
    .map((t) => `${t.id}|${t.cluster}|${t.parentProposalId ?? ''}|${(t.blockedBy ?? []).join(',')}`)
    .join(';')
  const propSig = proposals.map((p) => `${p.id}|${p.title}`).join(';')
  return `${tasks.length}/${proposals.length}#${taskSig}#${propSig}`
}

/**
 * Structural signature — changes only when the graph topology changes: nodes
 * added/removed, edge wiring changes, or proposals change.  Does NOT include
 * cluster, so a failed/blocked status transition does NOT trigger a full graph
 * rebuild (which would cause a blank-canvas flash).  TopologyView's mount
 * effect keys on this; the cluster-patch effect keys on clusterSignature.
 */
export const structuralSignature = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
): string => {
  const taskSig = tasks
    .map((t) => `${t.id}|${t.parentProposalId ?? ''}|${(t.blockedBy ?? []).join(',')}`)
    .join(';')
  const propSig = proposals.map((p) => `${p.id}|${p.title}`).join(';')
  return `${tasks.length}/${proposals.length}#${taskSig}#${propSig}`
}

/**
 * Cluster-only signature — changes when any task's cluster assignment changes
 * (e.g., 'In progress' → 'Failed', 'Queued' → 'Blocked').  TopologyView uses
 * this to detect when nodes need a colour patch (updateNodeData + draw) without
 * a full rebuild.
 */
export const clusterSignature = (tasks: ReadonlyArray<ProgressTask>): string =>
  tasks.map((t) => `${t.id}:${t.cluster}`).join(';')
