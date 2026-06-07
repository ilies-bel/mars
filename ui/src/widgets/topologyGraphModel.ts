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

const comboId = (arcKey: string): string => `combo:${arcKey}`

/** Strip the `combo:` prefix back to the bare arc key (proposal id, origin id, or task id). */
export const arcKeyFromComboId = (id: string): string => id.replace(/^combo:/, '')

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
 * **Arc-aware grouping** (findings #11/#13/#14/#15/#16):
 *
 *  - One COLLAPSED combo per ARC. An arc is determined by an arc key:
 *      `parentProposalId ?? originId ?? id`
 *    Proposal-backed arcs use the proposal title; non-proposal arcs use the
 *    origin task's prompt. Standalone tasks get a solo combo. No task is
 *    silently dropped.
 *  - One task node per task, always assigned to its arc combo.
 *  - Blocker edges keyed with `blockerKey(blocker, task)` so the highlight map
 *    matches.
 *  - Recovery edges (`kind:'recovery'`) from `fixForTaskId` → fix task,
 *    emitted whenever both endpoints are in scope. Mirrors the server-side
 *    `nestRecoveriesUnderParents` logic in `origin-tree.ts`.
 */
export const buildG6Data = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
): G6GraphData => {
  const proposalMap = new Map(proposals.map((p) => [p.id, p]))

  /** Arc key for a task: the key that groups it with its arc siblings. */
  const taskArcKey = (t: ProgressTask): string =>
    t.parentProposalId ?? t.originId ?? t.id

  // Group tasks by arc key
  const arcGroups = new Map<string, ProgressTask[]>()
  for (const t of tasks) {
    const key = taskArcKey(t)
    const group = arcGroups.get(key)
    if (group) group.push(t)
    else arcGroups.set(key, [t])
  }

  // Build one combo per arc
  const combos: ComboData[] = []
  for (const [arcKey, arcTasks] of arcGroups) {
    const proposal = proposalMap.get(arcKey)
    // Label: proposal title if available, otherwise the origin task's first prompt line.
    const rootTask = arcTasks.find((t) => t.id === arcKey)
    const firstTask = rootTask ?? arcTasks[0]
    const label = proposal
      ? proposal.title
      : (firstTask!.prompt.split('\n')[0]?.trim() || arcKey)

    // Compute arc cluster rollup inline
    const counts = emptyCounts()
    let total = 0
    for (const t of arcTasks) {
      counts[t.cluster]++
      total++
    }

    combos.push({
      id: comboId(arcKey),
      data: {
        label,
        arcKey,
        proposalId: proposal?.id ?? null,
        count: total,
        dom: dominant({ total, counts }),
      },
      style: { collapsed: true },
    })
  }

  const taskIds = new Set(tasks.map((t) => t.id))

  const nodes: NodeData[] = tasks.map((t) => ({
    id: t.id,
    combo: comboId(taskArcKey(t)),
    data: { label: taskLabel(t), cluster: t.cluster, proposalId: t.parentProposalId ?? null },
  }))

  const edges: EdgeData[] = []
  for (const t of tasks) {
    // Blocker edges — both endpoints must be in scope (otherwise edge dangles)
    for (const b of t.blockedBy ?? []) {
      if (!taskIds.has(b)) continue
      edges.push({ id: blockerKey(b, t.id), source: b, target: t.id, data: { kind: 'blocker' } })
    }
    // Recovery edges — mirrors nestRecoveriesUnderParents from origin-tree.ts
    if (t.fixForTaskId != null && taskIds.has(t.fixForTaskId)) {
      edges.push({
        id: `recovery:${t.id}`,
        source: t.fixForTaskId,
        target: t.id,
        data: { kind: 'recovery' },
      })
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

  const taskFilterDim = (id: string, cluster: unknown): boolean => {
    if (search != null && !search.has(id)) return true
    if (gc != null && gc.has(String(cluster))) return true
    return false
  }
  const comboFilterDim = (arcKey: string): boolean => {
    if (search != null && !search.has(arcKey)) return true
    if (gc != null && gc.has('Arc')) return true
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
    const key = String(c.data?.arcKey ?? arcKeyFromComboId(id))
    map[id] = resolve(lit?.proposals.has(key) ?? false, comboFilterDim(key))
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
    .map(
      (t) =>
        `${t.id}|${t.cluster}|${t.parentProposalId ?? ''}|${t.originId ?? ''}|${t.fixForTaskId ?? ''}|${t.kind ?? ''}|${(t.blockedBy ?? []).join(',')}`,
    )
    .join(';')
  const propSig = proposals.map((p) => `${p.id}|${p.title}`).join(';')
  return `${tasks.length}/${proposals.length}#${taskSig}#${propSig}`
}

/**
 * Period and minimum stroke-opacity for the 'In progress' node pulse.
 * Period matches the board view's CSS animation (1.6 s).
 */
export const PULSE_PERIOD_MS = 1600
export const PULSE_MIN_OPACITY = 0.4

/**
 * Compute the strokeOpacity for an 'In progress' node pulse at a given elapsed
 * time. Returns a value in [PULSE_MIN_OPACITY, 1.0] using a cosine-based
 * ease-in-out cycle that starts fully opaque, dips to PULSE_MIN_OPACITY at the
 * midpoint, then returns to 1.0 — mirroring the board view's CSS animation:
 * `@keyframes mars-pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }`.
 *
 * Pure and side-effect-free; testable without a canvas.
 */
export const pulseOpacity = (elapsedMs: number): number => {
  const t = (elapsedMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS
  // cos(2πt): 1 at t=0, −1 at t=0.5, 1 at t=1.  Map [1,−1] → [0,1] then
  // scale into [PULSE_MIN_OPACITY, 1.0].
  const k = (Math.cos(2 * Math.PI * t) + 1) / 2
  return PULSE_MIN_OPACITY + k * (1 - PULSE_MIN_OPACITY)
}
