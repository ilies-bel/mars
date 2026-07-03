/**
 * Pure data → G6 transforms for the Topology Cloud view.
 *
 * Everything here is side-effect-free and can be unit-tested without
 * instantiating G6 or a canvas. At module-load time the `CLUSTER_STYLE`
 * constant reads CSS custom properties from the document root (if a DOM is
 * present) so that `index.css` remains the single source of truth for colours.
 * `TopologyView.tsx` owns all the imperative G6 / DOM wiring and consumes the
 * structures this module emits.
 *
 * Ported from the prototype's rollup / `dominant()` / g6-data logic
 * (/tmp/mars-graph-proto/app.js), with the prototype's invented `Done` cluster
 * dropped — the real schema's cluster enum is only
 * `'Queued' | 'In progress' | 'Blocked' | 'Failed'`.
 */

import type { ComboData, EdgeData, NodeData } from '@antv/g6'
import { blockerKey, type ChainResult } from '@/shared/chainTrace'
import { titleFromPrompt } from '@/shared/promptTitle'
import type { Cluster, ProgressProposalNode, ProgressTask } from '@/shared/schemas'

/**
 * Per-cluster colour fields consumed by the G6 Canvas renderer.
 *
 *  - `fill` / `stroke` / `text`: the task-node rect.
 *  - `dot`: the legend swatch + stroke accent (derived from `stroke`).
 *  - `combo`: the dark, status-tinted fill of a collapsed proposal card
 *    (G6-specific; no CSS custom property counterpart).
 */
export interface ClusterStyle {
  fill: string
  stroke: string
  text: string
  dot: string
  combo: string
}

/**
 * CSS custom-property names that carry the cluster palette in `index.css`.
 * These strings are the only coupling point between CSS and TypeScript; the
 * resolver (`buildClusterStyleFromVars`) reads the resolved values at runtime
 * so that CSS is the single source of truth for colours.
 */
const CSS_VAR_NAMES = {
  'In progress': {
    fill:   '--color-dag-in-progress-fill',
    stroke: '--color-dag-in-progress-stroke',
    text:   '--color-dag-in-progress-text',
  },
  Blocked: {
    fill:   '--color-dag-blocked-fill',
    stroke: '--color-dag-blocked-stroke',
    text:   '--color-dag-blocked-text',
  },
  Queued: {
    fill:   '--color-dag-queued-fill',
    stroke: '--color-dag-queued-stroke',
    text:   '--color-dag-queued-text',
  },
  Failed: {
    fill:   '--color-dag-failed-fill',
    stroke: '--color-dag-failed-stroke',
    text:   '--color-dag-failed-text',
  },
} as const satisfies Record<Cluster, { fill: string; stroke: string; text: string }>

/**
 * G6-canvas-specific combo fill — a darker status tint for collapsed proposal
 * cards. No corresponding CSS custom property exists; G6 canvas elements
 * cannot consume CSS vars, so these stay in TypeScript.
 */
const COMBO_FILL: Record<Cluster, string> = {
  'In progress': '#2c1d14',
  Blocked:       '#2a2114',
  Queued:        '#23232b',
  Failed:        '#2c1414',
}

/**
 * Build the per-cluster style map from a CSS custom-property resolver.
 *
 * In a browser, pass the `getComputedStyle(document.documentElement).getPropertyValue`
 * function so that the CSS token values flow directly into the G6 canvas with
 * no manual TS duplication. In tests (no real DOM), pass a stub that returns
 * known values so the function is testable without JSDOM.
 *
 * @param getVar - returns the value of a CSS custom property by name
 */
export function buildClusterStyleFromVars(
  getVar: (name: string) => string,
): Record<Cluster, ClusterStyle> {
  const result = {} as Record<Cluster, ClusterStyle>
  for (const cluster of ['In progress', 'Blocked', 'Queued', 'Failed'] as const) {
    const vars = CSS_VAR_NAMES[cluster]
    const stroke = getVar(vars.stroke).trim()
    result[cluster] = {
      fill:  getVar(vars.fill).trim(),
      stroke,
      text:  getVar(vars.text).trim(),
      dot:   stroke,          // legend swatch reuses the stroke accent
      combo: COMBO_FILL[cluster],
    }
  }
  return result
}

/**
 * Per-status hex palette for the G6 Canvas renderer (which cannot read CSS
 * custom properties). Built at module-load time from the document root's CSS
 * custom properties so that `index.css` is the single source of truth for
 * colours — the G6 canvas and the SVG legend never drift.
 *
 * In Node / test environments there is no real DOM, so CLUSTER_STYLE contains
 * empty strings. Call `buildClusterStyleFromVars` directly in tests and pass a
 * stub resolver so the logic is exercised without JSDOM.
 */
export const CLUSTER_STYLE: Record<Cluster, ClusterStyle> =
  typeof document !== 'undefined'
    ? buildClusterStyleFromVars(name =>
        getComputedStyle(document.documentElement).getPropertyValue(name),
      )
    : buildClusterStyleFromVars(() => '')

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
const taskLabel = (t: ProgressTask): string => titleFromPrompt(t.prompt) || t.id

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

  // Build one combo per arc — single-task arcs are bare nodes with no wrapper.
  const combos: ComboData[] = []
  for (const [arcKey, arcTasks] of arcGroups) {
    if (arcTasks.length === 1) continue // single-task arc → bare top-level node, no combo
    const proposal = proposalMap.get(arcKey)
    // Label: proposal title if available, otherwise the origin task's first prompt line.
    const rootTask = arcTasks.find((t) => t.id === arcKey)
    const firstTask = rootTask ?? arcTasks[0]
    const label = proposal
      ? proposal.title
      : (titleFromPrompt(firstTask!.prompt) || arcKey)

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

  const nodes: NodeData[] = tasks.map((t) => {
    const arcKey = taskArcKey(t)
    const isMultiTaskArc = arcGroups.get(arcKey)!.length > 1
    return {
      id: t.id,
      combo: isMultiTaskArc ? comboId(arcKey) : undefined,
      data: { label: taskLabel(t), cluster: t.cluster, proposalId: t.parentProposalId ?? null },
    }
  })

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
  /** Active hover-trace lit set, or null when nothing is hovered. */
  lit: ChainResult | null
}

/**
 * Resolve the per-element G6 state map in ONE place (applied via a single
 * batched `setElementState`). This is the single source of truth for how the
 * three dim sources combine:
 *
 *   - An element is FILTERED-dim if it fails the search filter (persists on top
 *     of everything else).
 *   - When a hover trace is active (`lit`), an element is 'active' only if it's
 *     in the lit set AND not filtered; everything else is 'dim'.
 *   - With no hover, an element is 'dim' if filtered, else at-rest (`[]`).
 *
 * An edge survives the filters only if BOTH its endpoints do.
 */
export const computeStateMap = (snapshot: ElementSnapshot, inputs: HighlightInputs): Record<string, string[]> => {
  const { searchMatchIds: search, lit } = inputs
  const map: Record<string, string[]> = {}

  const nodeById = new Map<string, NodeData>(snapshot.nodes.map((n) => [String(n.id), n]))

  const taskFilterDim = (id: string): boolean => {
    if (search != null && !search.has(id)) return true
    return false
  }
  const comboFilterDim = (arcKey: string): boolean => {
    if (search != null && !search.has(arcKey)) return true
    return false
  }
  const resolve = (litMember: boolean, filtered: boolean): string[] =>
    lit ? (litMember && !filtered ? ['active'] : ['dim']) : filtered ? ['dim'] : []

  for (const n of snapshot.nodes) {
    const id = String(n.id)
    map[id] = resolve(lit?.nodes.has(id) ?? false, taskFilterDim(id))
  }
  for (const e of snapshot.edges) {
    const id = String(e.id)
    const s = nodeById.get(String(e.source))
    const t = nodeById.get(String(e.target))
    const filtered =
      (s ? taskFilterDim(String(s.id)) : false) ||
      (t ? taskFilterDim(String(t.id)) : false)
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
 *
 * NOTE: includes `cluster` so that callers that need to detect ANY data change
 * (e.g. tests) can use this.  The graph mount effect uses `structuralSignature`
 * instead, which intentionally excludes cluster so that status/colour-only
 * flips do not trigger a full graph rebuild.
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
 * Structural-only signature: captures topology changes (task/proposal adds,
 * removes, re-parenting, blocker edges, arc grouping) but intentionally
 * EXCLUDES `cluster` (which is a visual / status-derived property).
 *
 * Use this as the rebuild gate in the mount effect.  Cluster changes are
 * handled by the incremental `computeVisualUpdates` path so the camera,
 * open combo, and node positions survive a status flip.
 */
export const structuralSignature = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
): string => {
  const taskSig = tasks
    .map(
      (t) =>
        `${t.id}|${t.parentProposalId ?? ''}|${t.originId ?? ''}|${t.fixForTaskId ?? ''}|${t.kind ?? ''}|${(t.blockedBy ?? []).join(',')}`,
    )
    .join(';')
  const propSig = proposals.map((p) => `${p.id}|${p.title}`).join(';')
  return `${tasks.length}/${proposals.length}#${taskSig}#${propSig}`
}

/** Node and combo data updates needed when cluster values change in-place. */
export interface VisualDiff {
  /** Nodes whose cluster data changed. Pass to graph.updateNodeData(). */
  nodeUpdates: Array<{ id: string; data: { cluster: Cluster } }>
  /** Combos whose dominant cluster changed. Pass to graph.updateComboData(). */
  comboUpdates: Array<{ id: string; data: { dom: Cluster } }>
}

/**
 * Compute the minimal node/combo data updates required when task clusters
 * change without any structural change (same nodes, same edges, same combos).
 *
 * Pure and side-effect-free.  Caller applies the diff:
 *   graph.updateNodeData(diff.nodeUpdates)
 *   graph.updateComboData(diff.comboUpdates)
 *   graph.draw()
 */
export const computeVisualUpdates = (
  newTasks: ReadonlyArray<ProgressTask>,
  liveNodes: ReadonlyArray<NodeData>,
  liveCombos: ReadonlyArray<ComboData>,
): VisualDiff => {
  const taskMap = new Map(newTasks.map((t) => [t.id, t]))

  const nodeUpdates: Array<{ id: string; data: { cluster: Cluster } }> = []
  for (const node of liveNodes) {
    const id = String(node.id)
    const task = taskMap.get(id)
    if (!task) continue
    if ((node.data?.cluster as Cluster | undefined) !== task.cluster) {
      nodeUpdates.push({ id, data: { cluster: task.cluster } })
    }
  }

  const comboUpdates: Array<{ id: string; data: { dom: Cluster } }> = []
  for (const combo of liveCombos) {
    const cId = String(combo.id)
    const counts = emptyCounts()
    let total = 0
    for (const node of liveNodes) {
      if (node.combo !== cId) continue
      const task = taskMap.get(String(node.id))
      // Prefer the task's latest cluster; fall back to what G6 stores.
      const cluster: Cluster = task?.cluster ?? ((node.data?.cluster as Cluster | undefined) ?? 'Queued')
      counts[cluster]++
      total++
    }
    const newDom = dominant({ total, counts })
    if (newDom !== (combo.data?.dom as Cluster | undefined)) {
      comboUpdates.push({ id: cId, data: { dom: newDom } })
    }
  }

  return { nodeUpdates, comboUpdates }
}

// ---------------------------------------------------------------------------
// Layout geometry — sizes derived from the G6 config in TopologyView.tsx.
// Keep these in sync with the `node.style.size` and `combo.style.collapsedSize`
// values in the Graph constructor. They are the single source of truth for
// spacing so the layout and collision algorithms don't carry magic numbers.
// ---------------------------------------------------------------------------

/** Task-node rect dimensions — must match `node.style.size` in TopologyView.tsx. */
export const NODE_W = 148
export const NODE_H = 32

/** Collapsed combo card dimensions — must match `combo.style.collapsedSize`. */
export const COMBO_COLLAPSED_W = 168
export const COMBO_COLLAPSED_H = 46

/** Column pitch (x-spacing) for the inner LR dagre layout, derived from node width. */
export const LAYOUT_COL = NODE_W + 52 // 200: node width + 52 px gap

/** Row pitch (y-spacing) for the inner LR dagre layout, derived from node height. */
export const LAYOUT_ROW = NODE_H + 24 // 56: node height + 24 px gap

/**
 * Half-width exclusion radius for closed combo cards used by the collision
 * resolver.  Derived from the combo collapsed width plus a 40 px margin so
 * neighbouring cards don't crowd each other.
 */
export const CARD_HALF_W = Math.round(COMBO_COLLAPSED_W / 2) + 40 // 124

/**
 * Half-height exclusion radius for closed combo cards.
 * Derived from combo collapsed height plus a 41 px margin.
 */
export const CARD_HALF_H = Math.round(COMBO_COLLAPSED_H / 2) + 41 // 64

/** Maximum passes for the card-card collision resolution loop. */
export const MAX_COLLISION_PASSES = 40

// ---------------------------------------------------------------------------
// Inner-graph layout
// ---------------------------------------------------------------------------

/**
 * Deterministic LR layered layout over a small subgraph.
 *
 * Uses longest-path ranking + alternating barycentre sweeps to minimise edge
 * crossings.  Returns id → {x, y} centred on (0, 0).  Spacing is derived from
 * NODE_W / NODE_H so it stays in sync with the G6 node config.
 *
 * Pure and side-effect-free; testable without a canvas.
 */
export const layeredPositions = (
  nodeIds: string[],
  innerEdges: ReadonlyArray<EdgeData>,
): Map<string, { x: number; y: number }> => {
  const idset = new Set(nodeIds)
  const succ = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
  const pred = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
  const indeg = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  for (const e of innerEdges) {
    const s = String(e.source)
    const t = String(e.target)
    if (!idset.has(s) || !idset.has(t)) continue
    succ.get(s)!.push(t)
    pred.get(t)!.push(s)
    indeg.set(t, indeg.get(t)! + 1)
  }
  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]))
  const queue = nodeIds.filter((id) => indeg.get(id) === 0)
  const seen = new Set<string>(queue)
  while (queue.length) {
    const cur = queue.shift() as string
    for (const nx of succ.get(cur)!) {
      if (rank.get(nx)! < rank.get(cur)! + 1) rank.set(nx, rank.get(cur)! + 1)
      if (!seen.has(nx)) {
        seen.add(nx)
        queue.push(nx)
      }
    }
  }
  const byRank = new Map<number, string[]>()
  for (const id of nodeIds) {
    const r = rank.get(id)!
    if (!byRank.has(r)) byRank.set(r, [])
    byRank.get(r)!.push(id)
  }
  const rankKeys = [...byRank.keys()].sort((a, b) => a - b)
  const order = new Map<string, number>()
  for (const r of rankKeys) byRank.get(r)!.forEach((id, i) => order.set(id, i))
  const bary = (id: string, neighbours: Map<string, string[]>): number => {
    const ns = neighbours.get(id)!
    if (!ns.length) return order.get(id)!
    return ns.reduce((s, n) => s + order.get(n)!, 0) / ns.length
  }
  for (let sweep = 0; sweep < 6; sweep++) {
    const forward = sweep % 2 === 0
    const seq = forward ? rankKeys.slice(1) : rankKeys.slice(0, -1).reverse()
    for (const r of seq) {
      const ids = byRank.get(r)!
      const ref = forward ? pred : succ
      ids.sort((a, b) => bary(a, ref) - bary(b, ref))
      ids.forEach((id, i) => order.set(id, i))
    }
  }
  const out = new Map<string, { x: number; y: number }>()
  rankKeys.forEach((r, ci) => {
    const ids = byRank.get(r)!
    const y0 = -((ids.length - 1) * LAYOUT_ROW) / 2
    ids.forEach((id, i) => out.set(id, { x: ci * LAYOUT_COL, y: y0 + i * LAYOUT_ROW }))
  })
  const offX = -((rankKeys.length - 1) * LAYOUT_COL) / 2
  for (const [id, p] of out) out.set(id, { x: p.x + offX, y: p.y })
  return out
}

// ---------------------------------------------------------------------------
// Card collision resolution
// ---------------------------------------------------------------------------

/** Position of a collapsed combo card used by resolveCardCollisions. */
export interface CollisionCard {
  id: string
  x: number
  y: number
}

/** Bounding box of the expanded combo (centre + dimensions). */
export interface CollisionBox {
  w: number
  h: number
  cx: number
  cy: number
}

/**
 * Resolve card-card and card-box collisions using axis-aligned AABB separation.
 *
 * Cards start at their `x`/`y` positions and are pushed outward from the open
 * combo box and from each other.  The algorithm:
 *   1. Initial box clearance — push every card outside the open combo's zone.
 *   2. Iterative pair separation (up to maxPasses) — separate overlapping cards.
 *      Box clearance re-runs at the end of every pass so pair pushes don't slide
 *      cards back into the box (this is what makes the convergence check correct).
 *
 * Modifies `cards` in place.
 *
 * @param cardHalfW  Half-width collision radius (default: CARD_HALF_W).
 * @param cardHalfH  Half-height collision radius (default: CARD_HALF_H).
 * @param maxPasses  Iteration cap (default: MAX_COLLISION_PASSES).
 * @returns `true` when the layout settled before hitting the cap.
 */
export const resolveCardCollisions = (
  cards: CollisionCard[],
  box: CollisionBox,
  cardHalfW = CARD_HALF_W,
  cardHalfH = CARD_HALF_H,
  maxPasses = MAX_COLLISION_PASSES,
): boolean => {
  /** Minimum gap between a card edge and the open combo box edge (px). */
  const BOX_GAP = 16
  /** Minimum gap between two adjacent card edges (px). */
  const CARD_GAP = 12

  const halfW = box.w / 2 + cardHalfW + BOX_GAP
  const halfH = box.h / 2 + cardHalfH + BOX_GAP
  const CW = cardHalfW * 2 + CARD_GAP
  const CH = cardHalfH * 2 + CARD_GAP

  const clearBox = (m: CollisionCard): boolean => {
    const dx = m.x - box.cx
    const dy = m.y - box.cy
    const penX = halfW - Math.abs(dx)
    const penY = halfH - Math.abs(dy)
    if (penX > 0 && penY > 0) {
      if (penX <= penY) m.x = box.cx + (dx >= 0 ? halfW : -halfW)
      else m.y = box.cy + (dy >= 0 ? halfH : -halfH)
      return true
    }
    return false
  }

  // Initial box clearance before pair iteration starts.
  for (const m of cards) clearBox(m)

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i]!
        const b = cards[j]!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const penX = CW - Math.abs(dx)
        const penY = CH - Math.abs(dy)
        if (penX > 0 && penY > 0) {
          if (penX <= penY) {
            const s = ((dx === 0 ? 1 : Math.sign(dx)) * penX) / 2
            a.x -= s
            b.x += s
          } else {
            const s = ((dy === 0 ? 1 : Math.sign(dy)) * penY) / 2
            a.y -= s
            b.y += s
          }
          moved = true
        }
      }
    }
    // Box clearance after each pair pass — pair pushes can slide cards back into
    // the box.  Tracking whether clearBox moved anything is what makes the
    // convergence check correct (the original `moved` only tracked pair moves).
    for (const m of cards) {
      if (clearBox(m)) moved = true
    }
    if (!moved) return true // converged before cap
  }
  return false // hit cap without full convergence
}

// ---------------------------------------------------------------------------
// Pulse animation
// ---------------------------------------------------------------------------

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
