/**
 * Pure data → React Flow transforms for the Topology view.
 *
 * Everything here is side-effect-free and unit-testable without a DOM or a
 * React Flow instance. `TopologyView.tsx` owns the React Flow wiring and
 * consumes the structures this module emits.
 *
 * Layout is fully deterministic: dagre (LR) inside connected components,
 * shelf-packing across components. Same data in → same picture out, replacing
 * the old d3-force cloud whose layout differed on every mount.
 */

import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import { blockerKey, type ChainResult } from '@/shared/chainTrace'
import { taskTitle } from '@/shared/promptTitle'
import type { Cluster, ProgressProposalNode, ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Cluster palette
// ---------------------------------------------------------------------------

/** Per-cluster colour fields. DOM nodes consume the `var()` strings directly. */
export interface ClusterStyle {
  fill: string
  stroke: string
  text: string
  dot: string
}

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
  // Done tasks are arc metadata and never rendered as topology nodes;
  // these CSS vars are fallbacks kept for type completeness only.
  Done: {
    fill:   '--color-dag-queued-fill',
    stroke: '--color-dag-queued-stroke',
    text:   '--color-dag-queued-text',
  },
} as const satisfies Record<Cluster, { fill: string; stroke: string; text: string }>

/**
 * `var()` wrappers for direct use in DOM style props — CSS stays the single
 * source of truth and the browser resolves the tokens live.
 *
 * Declared as a literal so tsc verifies every Cluster key is present at
 * compile time (no `{} as Record<…>` cast).
 */
export const CLUSTER_CSS: Record<Cluster, ClusterStyle> = {
  'In progress': {
    fill:   `var(${CSS_VAR_NAMES['In progress'].fill})`,
    stroke: `var(${CSS_VAR_NAMES['In progress'].stroke})`,
    text:   `var(${CSS_VAR_NAMES['In progress'].text})`,
    dot:    `var(${CSS_VAR_NAMES['In progress'].stroke})`,
  },
  Blocked: {
    fill:   `var(${CSS_VAR_NAMES.Blocked.fill})`,
    stroke: `var(${CSS_VAR_NAMES.Blocked.stroke})`,
    text:   `var(${CSS_VAR_NAMES.Blocked.text})`,
    dot:    `var(${CSS_VAR_NAMES.Blocked.stroke})`,
  },
  Queued: {
    fill:   `var(${CSS_VAR_NAMES.Queued.fill})`,
    stroke: `var(${CSS_VAR_NAMES.Queued.stroke})`,
    text:   `var(${CSS_VAR_NAMES.Queued.text})`,
    dot:    `var(${CSS_VAR_NAMES.Queued.stroke})`,
  },
  Failed: {
    fill:   `var(${CSS_VAR_NAMES.Failed.fill})`,
    stroke: `var(${CSS_VAR_NAMES.Failed.stroke})`,
    text:   `var(${CSS_VAR_NAMES.Failed.text})`,
    dot:    `var(${CSS_VAR_NAMES.Failed.stroke})`,
  },
  Done: {
    fill:   `var(${CSS_VAR_NAMES.Done.fill})`,
    stroke: `var(${CSS_VAR_NAMES.Done.stroke})`,
    text:   `var(${CSS_VAR_NAMES.Done.text})`,
    dot:    `var(${CSS_VAR_NAMES.Done.stroke})`,
  },
}

/**
 * Resolve the palette to CONCRETE colour values via a CSS custom-property
 * resolver. Needed only where `var()` cannot be used (the MiniMap renders
 * SVG fills through a JS callback). In tests, pass a stub resolver.
 *
 * Declared as a literal so tsc verifies every Cluster key is present at
 * compile time (no `{} as Record<…>` cast).
 */
export function buildClusterStyleFromVars(
  getVar: (name: string) => string,
): Record<Cluster, ClusterStyle> {
  const resolve = (vars: { fill: string; stroke: string; text: string }): ClusterStyle => {
    const stroke = getVar(vars.stroke).trim()
    return { fill: getVar(vars.fill).trim(), stroke, text: getVar(vars.text).trim(), dot: stroke }
  }
  return {
    'In progress': resolve(CSS_VAR_NAMES['In progress']),
    Blocked:       resolve(CSS_VAR_NAMES.Blocked),
    Queued:        resolve(CSS_VAR_NAMES.Queued),
    Failed:        resolve(CSS_VAR_NAMES.Failed),
    Done:          resolve(CSS_VAR_NAMES.Done),
  }
}

/** Proposal-identity accents (match --color-dag-proposal-* in index.css). */
export const PROPOSAL_STROKE = 'var(--color-dag-proposal-stroke)'
export const PROPOSAL_TEXT = 'var(--color-dag-proposal-text)'

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

/**
 * Tie-break severity when two clusters share the plurality.
 * Failed > In progress > Blocked > Queued.
 */
const SEVERITY: Record<Cluster, number> = {
  Failed: 4,
  'In progress': 3,
  Blocked: 2,
  Queued: 1,
  Done: 0, // completed origins are lowest severity in rollup tally
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
  Done: 0,
})

/**
 * Tally each proposal's tasks by cluster. Tasks whose `parentProposalId` is
 * not among the supplied proposals are ignored.
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

// ---------------------------------------------------------------------------
// Node/edge shapes
// ---------------------------------------------------------------------------

/** Arc key for a task: the key that groups it with its arc siblings. */
export const taskArcKey = (t: ProgressTask): string =>
  t.parentProposalId ?? t.originId ?? t.id

/**
 * Shared arc label resolution: proposal-first, then origin-task title.
 *
 * The origin-task branch goes through `taskTitle`, so a server-provided
 * `intent` wins over the raw prompt — same rule every other task label uses.
 *
 * Returns `undefined` when neither arcKey resolves to a known proposal nor to
 * an origin task in the group — the caller supplies the fallback (e.g. the
 * topology falls back to the first task's title; the board uses "Abandoned arc").
 */
export const resolveArcLabel = (
  arcKey: string,
  tasks: ReadonlyArray<ProgressTask>,
  proposalMap: ReadonlyMap<string, { readonly title: string }>,
): string | undefined => {
  const proposal = proposalMap.get(arcKey)
  if (proposal) return proposal.title
  const originTask = tasks.find((t) => t.id === arcKey)
  if (originTask) return taskTitle(originTask) || undefined
  return undefined
}

const arcNodeId = (arcKey: string): string => `arc:${arcKey}`

/** Strip the `arc:` prefix back to the bare arc key. */
export const arcKeyFromNodeId = (id: string): string => id.replace(/^arc:/, '')

/** First non-empty line of a task's prompt, used as its node label. */
const taskLabel = (t: ProgressTask): string => taskTitle(t) || t.id

export type Emphasis = 'lit' | 'dim' | 'rest'

export interface TaskNodeData extends Record<string, unknown> {
  kind: 'task'
  label: string
  cluster: Cluster
  arcKey: string
  emphasis: Emphasis
}

export interface ArcCardNodeData extends Record<string, unknown> {
  kind: 'arcCard'
  label: string
  arcKey: string
  /** Whether the arc key is a real proposal id (purple identity) or an origin arc. */
  isProposal: boolean
  count: number
  dom: Cluster
  emphasis: Emphasis
}

export interface ArcGroupNodeData extends Record<string, unknown> {
  kind: 'arcGroup'
  label: string
  arcKey: string
  isProposal: boolean
  count: number
  dom: Cluster
  emphasis: Emphasis
}

export interface FanoutBundleNodeData extends Record<string, unknown> {
  kind: 'fanoutBundle'
  hubId: string
  direction: 'in' | 'out'
  /** stable key = `${hubId}|${direction}` — used as the expand-toggle id */
  bundleKey: string
  count: number
  /** ids of the collapsed leaf top-level nodes, for filtering/emphasis */
  memberIds: string[]
  emphasis: Emphasis
}

export type TopoNodeData = TaskNodeData | ArcCardNodeData | ArcGroupNodeData | FanoutBundleNodeData

export type EdgeKind = 'blocker' | 'recovery'

export interface TopoEdgeData extends Record<string, unknown> {
  kind: EdgeKind
  /**
   * The original chain-trace edge keys this rendered edge stands for. A lifted
   * edge (endpoint inside a collapsed arc) can represent several originals.
   */
  keys: string[]
  emphasis: Emphasis
}

export type TopoNode = Node<TopoNodeData>
export type TopoEdge = Edge<TopoEdgeData>

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Task-node card dimensions (px) — must match the TaskNode component CSS. */
export const TASK_W = 200
export const TASK_H = 48

/** Collapsed arc card dimensions (px) — must match the ArcCardNode CSS. */
export const CARD_W = 232
export const CARD_H = 64

/** Bundle pill dimensions (px). */
export const BUNDLE_W = 200
export const BUNDLE_H = 40

/**
 * A hub node with MORE than this many bundleable degree-1 leaf neighbours on
 * one side collapses them into a single `fanoutBundle` pill.
 */
export const FANOUT_BUNDLE_THRESHOLD = 8

/** Expanded arc group padding: sides / bottom, and the header strip on top. */
export const GROUP_PAD = 20
export const GROUP_HEADER_H = 44

/** Gaps between shelf-packed layout components. */
const COMPONENT_GAP_X = 96
const COMPONENT_GAP_Y = 96

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

interface Box {
  w: number
  h: number
}

interface Placed extends Box {
  x: number
  y: number
}

interface LayoutItem {
  id: string
  w: number
  h: number
}

interface LayoutEdge {
  source: string
  target: string
}

/** Dagre LR layout over one connected component. Returns top-left positions. */
const dagreLayout = (
  items: ReadonlyArray<LayoutItem>,
  edges: ReadonlyArray<LayoutEdge>,
  opts: { nodesep: number; ranksep: number },
): { positions: Map<string, Placed>; bounds: Box } => {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: opts.nodesep, ranksep: opts.ranksep, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const it of items) g.setNode(it.id, { width: it.w, height: it.h })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)

  const positions = new Map<string, Placed>()
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const it of items) {
    const n = g.node(it.id)
    const x = n.x - it.w / 2
    const y = n.y - it.h / 2
    positions.set(it.id, { x, y, w: it.w, h: it.h })
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + it.w)
    maxY = Math.max(maxY, y + it.h)
  }
  // Normalise to a (0,0) origin so the component packs cleanly.
  for (const [id, p] of positions) positions.set(id, { ...p, x: p.x - minX, y: p.y - minY })
  return { positions, bounds: { w: maxX - minX, h: maxY - minY } }
}

/**
 * Shelf-pack component bounding boxes into rows, aiming for a landscape
 * canvas (~16:9 worth of area). Deterministic: components arrive in stable
 * order (insertion order of the arc map).
 */
const shelfPack = (boxes: ReadonlyArray<Box>): Placed[] => {
  const totalArea = boxes.reduce((s, b) => s + (b.w + COMPONENT_GAP_X) * (b.h + COMPONENT_GAP_Y), 0)
  const targetWidth = Math.max(Math.sqrt(totalArea * (16 / 9)), ...boxes.map((b) => b.w))
  const placed: Placed[] = []
  let cursorX = 0
  let cursorY = 0
  let rowH = 0
  for (const b of boxes) {
    if (cursorX > 0 && cursorX + b.w > targetWidth) {
      cursorX = 0
      cursorY += rowH + COMPONENT_GAP_Y
      rowH = 0
    }
    placed.push({ x: cursorX, y: cursorY, w: b.w, h: b.h })
    cursorX += b.w + COMPONENT_GAP_X
    rowH = Math.max(rowH, b.h)
  }
  return placed
}

// ---------------------------------------------------------------------------
// buildTopology — the main transform
// ---------------------------------------------------------------------------

export interface TopologyGraph {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

interface RawEdge {
  key: string
  kind: EdgeKind
  source: string
  target: string
}

/**
 * Build the React Flow graph.
 *
 * **Arc-aware grouping** (parity with the old G6 view):
 *  - One collapsed CARD per multi-task arc (`parentProposalId ?? originId ?? id`).
 *    Proposal-backed arcs use the proposal title; origin arcs use the origin
 *    task's prompt. Single-task arcs render as bare task nodes. No task is
 *    silently dropped.
 *  - At most ONE arc is expanded (`openArcKey`): it becomes a group node with
 *    its member tasks as `parentId`/`extent:'parent'` children, laid out with
 *    an inner dagre LR pass.
 *  - Blocker edges keyed with `blockerKey(blocker, task)`; recovery edges from
 *    `fixForTaskId`. Edges whose endpoint hides inside a collapsed arc are
 *    LIFTED to that arc's card (originals recorded in `data.keys`); edges
 *    fully inside a collapsed arc are omitted.
 */
export const buildTopology = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
  openArcKey: string | null,
  expandedBundles: ReadonlySet<string> = new Set(),
): TopologyGraph => {
  const proposalMap = new Map(proposals.map((p) => [p.id, p]))

  // Group ALL tasks (including Done) by arc key — Done origins still supply
  // arc identity and labelling. Insertion order = stable layout order.
  const arcGroups = new Map<string, ProgressTask[]>()
  for (const t of tasks) {
    const key = taskArcKey(t)
    const group = arcGroups.get(key)
    if (group) group.push(t)
    else arcGroups.set(key, [t])
  }

  // Non-Done members per arc: these are the only tasks that render as nodes.
  // An arc whose every member is Done is fully completed and emits nothing.
  const activeMembersMap = new Map<string, ProgressTask[]>()
  for (const [key, group] of arcGroups) {
    activeMembersMap.set(key, group.filter((t) => t.cluster !== 'Done'))
  }

  const taskIds = new Set(tasks.map((t) => t.id))
  const doneIds = new Set(tasks.filter((t) => t.cluster === 'Done').map((t) => t.id))

  // Raw edges over TASK ids — exclude edges where either endpoint is Done,
  // so no edge dangles at a node that is not emitted.
  const rawEdges: RawEdge[] = []
  for (const t of tasks) {
    if (t.cluster === 'Done') continue // Done tasks emit no edges
    for (const b of t.blockedBy ?? []) {
      if (!taskIds.has(b) || doneIds.has(b)) continue
      rawEdges.push({ key: blockerKey(b, t.id), kind: 'blocker', source: b, target: t.id })
    }
    if (t.fixForTaskId != null && taskIds.has(t.fixForTaskId) && !doneIds.has(t.fixForTaskId)) {
      rawEdges.push({ key: `recovery:${t.id}`, kind: 'recovery', source: t.fixForTaskId, target: t.id })
    }
  }

  // Visible top-level element for a task: itself (bare or inside the open
  // group) or its arc's collapsed card. arcOf is keyed over ALL tasks
  // (including Done) so edges can locate their arc during lifting, but
  // isMulti counts only active members — Done members don't count toward
  // the "needs a card" threshold.
  const arcOf = new Map<string, string>()
  for (const [key, group] of arcGroups) for (const t of group) arcOf.set(t.id, key)
  const isMulti = (key: string): boolean => (activeMembersMap.get(key)?.length ?? 0) > 1
  const topElementOf = (id: string): string => {
    const key = arcOf.get(id)!
    if (!isMulti(key)) return id
    return arcNodeId(key) // card OR group — both use the arc node id at the top level
  }
  const visibleElementOf = (id: string): string => {
    const key = arcOf.get(id)!
    if (!isMulti(key) || key === openArcKey) return id
    return arcNodeId(key)
  }

  // --- Inner layout of the open arc (also determines the group's size) ------
  // Use activeMembers only — Done members are never rendered as child nodes.
  const openTasks = openArcKey != null && isMulti(openArcKey) ? activeMembersMap.get(openArcKey)! : null
  let innerPositions: Map<string, Placed> | null = null
  let groupSize: Box | null = null
  if (openTasks) {
    const memberIds = new Set(openTasks.map((t) => t.id))
    const innerEdges = rawEdges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target))
    const layout = dagreLayout(
      openTasks.map((t) => ({ id: t.id, w: TASK_W, h: TASK_H })),
      innerEdges,
      { nodesep: 16, ranksep: 56 },
    )
    innerPositions = layout.positions
    groupSize = {
      w: layout.bounds.w + GROUP_PAD * 2,
      h: layout.bounds.h + GROUP_PAD + GROUP_HEADER_H,
    }
  }

  // --- Top-level items -------------------------------------------------------
  const topItems: LayoutItem[] = []
  for (const [key] of arcGroups) {
    const activeMembers = activeMembersMap.get(key)!
    if (activeMembers.length === 0) continue // fully-completed arc: no nodes to render
    if (!isMulti(key)) {
      const t = activeMembers[0]!
      topItems.push({ id: t.id, w: TASK_W, h: TASK_H })
    } else if (key === openArcKey && groupSize) {
      topItems.push({ id: arcNodeId(key), w: groupSize.w, h: groupSize.h })
    } else {
      topItems.push({ id: arcNodeId(key), w: CARD_W, h: CARD_H })
    }
  }

  // Lifted top-level edges (deduped). Also track per-edge kinds/keys for
  // bundle computation (which needs to know what raw edges underlie each
  // lifted top-level edge).
  interface TopEdgeInfo { kinds: EdgeKind[]; rawKeys: string[] }
  const topEdgeInfo = new Map<string, TopEdgeInfo>()
  const topEdges: LayoutEdge[] = []
  for (const e of rawEdges) {
    const s = topElementOf(e.source)
    const t = topElementOf(e.target)
    if (s === t) continue
    const dedupe = `${s}->${t}`
    if (!topEdgeInfo.has(dedupe)) {
      topEdgeInfo.set(dedupe, { kinds: [], rawKeys: [] })
      topEdges.push({ source: s, target: t })
    }
    const info = topEdgeInfo.get(dedupe)!
    info.kinds.push(e.kind)
    info.rawKeys.push(e.key)
  }

  // --- Fan-out bundle computation -------------------------------------------
  // Identify degree-1 leaf nodes (nodes with exactly one top-level edge) and
  // group them per (hubId, direction). Groups larger than FANOUT_BUNDLE_THRESHOLD
  // that are not in `expandedBundles` are collapsed into a single pill node.

  const topDegree = new Map<string, number>()
  for (const it of topItems) topDegree.set(it.id, 0)
  for (const e of topEdges) {
    topDegree.set(e.source, (topDegree.get(e.source) ?? 0) + 1)
    topDegree.set(e.target, (topDegree.get(e.target) ?? 0) + 1)
  }

  interface BundleGroup {
    hubId: string
    direction: 'in' | 'out'
    leafItemIds: string[]
    rawKeys: string[]
    edgeKinds: EdgeKind[]
  }
  const bundleGroupMap = new Map<string, BundleGroup>()
  for (const it of topItems) {
    if ((topDegree.get(it.id) ?? 0) !== 1) continue
    const solo = topEdges.find((e) => e.source === it.id || e.target === it.id)
    if (!solo) continue
    const isSource = solo.source === it.id
    const hubId = isSource ? solo.target : solo.source
    // direction from hub's perspective: 'out' = H→N, 'in' = N→H
    const direction: 'in' | 'out' = isSource ? 'in' : 'out'
    const bundleKey = `${hubId}|${direction}`
    if (!bundleGroupMap.has(bundleKey)) {
      bundleGroupMap.set(bundleKey, { hubId, direction, leafItemIds: [], rawKeys: [], edgeKinds: [] })
    }
    const group = bundleGroupMap.get(bundleKey)!
    group.leafItemIds.push(it.id)
    const dedupeKey = isSource ? `${it.id}->${hubId}` : `${hubId}->${it.id}`
    const edgeInfo = topEdgeInfo.get(dedupeKey)
    if (edgeInfo) {
      for (const k of edgeInfo.rawKeys) group.rawKeys.push(k)
      for (const k of edgeInfo.kinds) group.edgeKinds.push(k)
    }
  }

  // Determine which groups to actually collapse.
  const activeBundles = new Map<string, BundleGroup>()
  // leafToBundle: topNodeId → bundleKey, for the edge-emission step below
  const leafToBundle = new Map<string, string>()
  for (const [bundleKey, group] of bundleGroupMap) {
    if (group.leafItemIds.length <= FANOUT_BUNDLE_THRESHOLD) continue
    if (expandedBundles.has(bundleKey)) continue
    activeBundles.set(bundleKey, group)
    for (const id of group.leafItemIds) leafToBundle.set(id, bundleKey)
  }

  // Build layout items/edges with bundled leaves replaced by bundle pills.
  const bundledLeafSet = new Set(leafToBundle.keys())
  const layoutTopItems: LayoutItem[] = topItems.filter((it) => !bundledLeafSet.has(it.id))
  const layoutTopEdges: LayoutEdge[] = topEdges.filter(
    (e) => !bundledLeafSet.has(e.source) && !bundledLeafSet.has(e.target),
  )
  for (const [bundleKey, group] of activeBundles) {
    layoutTopItems.push({ id: bundleKey, w: BUNDLE_W, h: BUNDLE_H })
    if (group.direction === 'out') {
      layoutTopEdges.push({ source: group.hubId, target: bundleKey })
    } else {
      layoutTopEdges.push({ source: bundleKey, target: group.hubId })
    }
  }

  // --- Connected components over layout items (post-bundle substitution) ----
  const adj = new Map<string, string[]>(layoutTopItems.map((it) => [it.id, []]))
  for (const e of layoutTopEdges) {
    adj.get(e.source)?.push(e.target)
    adj.get(e.target)?.push(e.source)
  }
  const componentOf = new Map<string, number>()
  let componentCount = 0
  for (const it of layoutTopItems) {
    if (componentOf.has(it.id)) continue
    const stack = [it.id]
    componentOf.set(it.id, componentCount)
    while (stack.length) {
      const cur = stack.pop()!
      for (const nx of adj.get(cur) ?? []) {
        if (!componentOf.has(nx)) {
          componentOf.set(nx, componentCount)
          stack.push(nx)
        }
      }
    }
    componentCount++
  }

  const componentItems: LayoutItem[][] = Array.from({ length: componentCount }, () => [])
  for (const it of layoutTopItems) componentItems[componentOf.get(it.id)!]!.push(it)
  const componentEdges: LayoutEdge[][] = Array.from({ length: componentCount }, () => [])
  for (const e of layoutTopEdges) componentEdges[componentOf.get(e.source)!]!.push(e)

  const componentLayouts = componentItems.map((items, i) =>
    dagreLayout(items, componentEdges[i]!, { nodesep: 36, ranksep: 110 }),
  )
  const packed = shelfPack(componentLayouts.map((l) => l.bounds))

  const topPosition = new Map<string, Placed>()
  componentLayouts.forEach((layout, i) => {
    const origin = packed[i]!
    for (const [id, p] of layout.positions) {
      topPosition.set(id, { ...p, x: p.x + origin.x, y: p.y + origin.y })
    }
  })

  // --- Emit React Flow nodes -------------------------------------------------
  const nodes: TopoNode[] = []
  for (const [key, group] of arcGroups) {
    const activeMembers = activeMembersMap.get(key)!
    if (activeMembers.length === 0) continue // fully-completed arc: emit nothing

    // Use full `group` (including Done origin) for label — a Done origin still
    // names its arc. This preserves the 8f2a5a12 fix.
    const label = resolveArcLabel(key, group, proposalMap) ?? (taskTitle(group[0]!) || key)

    // dom and counts tally only active members — Done members are not work in progress.
    const counts = emptyCounts()
    for (const t of activeMembers) counts[t.cluster]++
    const dom = dominant({ total: activeMembers.length, counts })

    if (!isMulti(key)) {
      const t = activeMembers[0]!
      // Skip: this single-task node was collapsed into a bundle pill.
      if (leafToBundle.has(t.id)) continue
      const pos = topPosition.get(t.id)!
      nodes.push({
        id: t.id,
        type: 'task',
        position: { x: pos.x, y: pos.y },
        width: TASK_W,
        height: TASK_H,
        data: { kind: 'task', label: taskLabel(t), cluster: t.cluster, arcKey: key, emphasis: 'rest' },
      })
      continue
    }

    const arcId = arcNodeId(key)
    // Skip: this arc card was collapsed into a bundle pill.
    if (leafToBundle.has(arcId)) continue
    const pos = topPosition.get(arcId)!
    if (key === openArcKey && innerPositions && groupSize) {
      nodes.push({
        id: arcId,
        type: 'arcGroup',
        position: { x: pos.x, y: pos.y },
        width: groupSize.w,
        height: groupSize.h,
        data: { kind: 'arcGroup', label, arcKey: key, isProposal: proposalMap.has(key), count: activeMembers.length, dom, emphasis: 'rest' },
      })
      for (const t of activeMembers) {
        const p = innerPositions.get(t.id)!
        nodes.push({
          id: t.id,
          type: 'task',
          parentId: arcId,
          extent: 'parent',
          position: { x: p.x + GROUP_PAD, y: p.y + GROUP_HEADER_H },
          width: TASK_W,
          height: TASK_H,
          data: { kind: 'task', label: taskLabel(t), cluster: t.cluster, arcKey: key, emphasis: 'rest' },
        })
      }
    } else {
      nodes.push({
        id: arcId,
        type: 'arcCard',
        position: { x: pos.x, y: pos.y },
        width: CARD_W,
        height: CARD_H,
        data: { kind: 'arcCard', label, arcKey: key, isProposal: proposalMap.has(key), count: activeMembers.length, dom, emphasis: 'rest' },
      })
    }
  }

  // --- Emit bundle pill nodes ------------------------------------------------
  for (const [bundleKey, group] of activeBundles) {
    const pos = topPosition.get(bundleKey)!
    nodes.push({
      id: bundleKey,
      type: 'fanoutBundle',
      position: { x: pos.x, y: pos.y },
      width: BUNDLE_W,
      height: BUNDLE_H,
      data: {
        kind: 'fanoutBundle',
        hubId: group.hubId,
        direction: group.direction,
        bundleKey,
        count: group.leafItemIds.length,
        memberIds: group.leafItemIds,
        emphasis: 'rest',
      },
    })
  }

  // --- Emit React Flow edges (visible endpoints, lifted + deduped) ----------
  // `visibleElementOf` maps task IDs to their top-level element (task node or
  // arc card). The `leafToBundle` lookup then redirects bundled leaves to their
  // bundle pill ID. Edges whose lifted endpoints hit a bundle node are skipped
  // here and emitted separately below (so we control kind + key aggregation).
  const edgeByVisible = new Map<string, TopoEdge>()
  for (const e of rawEdges) {
    const s0 = visibleElementOf(e.source)
    const s = leafToBundle.get(s0) ?? s0
    const t0 = visibleElementOf(e.target)
    const t = leafToBundle.get(t0) ?? t0
    if (s === t) continue // fully inside one collapsed arc (or same bundle)
    // Skip raw edges that map to a bundle node endpoint — emitted separately.
    if (activeBundles.has(s) || activeBundles.has(t)) continue
    const id = `${e.kind}|${s}->${t}`
    const existing = edgeByVisible.get(id)
    if (existing) {
      existing.data!.keys.push(e.key)
      continue
    }
    edgeByVisible.set(id, {
      id,
      source: s,
      target: t,
      type: 'default',
      data: { kind: e.kind, keys: [e.key], emphasis: 'rest' },
    })
  }

  // Emit one aggregated edge per active bundle (hub↔bundle direction).
  for (const [bundleKey, group] of activeBundles) {
    // Use 'recovery' only when ALL underlying edges are recovery; else 'blocker'.
    const kind: EdgeKind = group.edgeKinds.every((k) => k === 'recovery') ? 'recovery' : 'blocker'
    const [src, tgt] =
      group.direction === 'out' ? [group.hubId, bundleKey] : [bundleKey, group.hubId]
    const id = `${kind}|${src}->${tgt}`
    edgeByVisible.set(id, {
      id,
      source: src,
      target: tgt,
      type: 'default',
      data: { kind, keys: [...group.rawKeys], emphasis: 'rest' },
    })
  }

  return { nodes, edges: [...edgeByVisible.values()] }
}

// ---------------------------------------------------------------------------
// Emphasis (dim / lit) resolution
// ---------------------------------------------------------------------------

/** Inputs that dim/brighten elements: the persistent filters + the hover set. */
export interface EmphasisInputs {
  /** Toolbar search; null = no search. Only these ids stay full-opacity. */
  searchMatchIds: Set<string> | null | undefined
  /** Active hover-trace lit set, or null when nothing is hovered. */
  lit: ChainResult | null
}

/**
 * Resolve the per-element emphasis in ONE place. Single source of truth for
 * how the dim sources combine (parity with the old computeStateMap):
 *
 *   - An element is FILTERED if it fails the search filter.
 *   - When a hover trace is active, an element is 'lit' only if it's in the
 *     lit set AND not filtered; everything else is 'dim'.
 *   - With no hover, an element is 'dim' if filtered, else 'rest'.
 *
 * An edge survives the filters only if BOTH its endpoints do; a lifted edge is
 * lit when ANY of its original keys is lit.
 */
export const computeEmphasisMap = (
  nodes: ReadonlyArray<TopoNode>,
  edges: ReadonlyArray<TopoEdge>,
  inputs: EmphasisInputs,
): Map<string, Emphasis> => {
  const { searchMatchIds: search, lit } = inputs
  const map = new Map<string, Emphasis>()

  const filteredIds = new Map<string, boolean>()
  const nodeFiltered = (n: TopoNode): boolean => {
    if (search == null) return false
    if (n.data.kind === 'task') return !search.has(n.id)
    if (n.data.kind === 'fanoutBundle') {
      // A bundle is filtered only when ALL its member leaves are filtered.
      return n.data.memberIds.every((id) => !search.has(arcKeyFromNodeId(id)))
    }
    return !search.has(n.data.arcKey)
  }
  const resolve = (litMember: boolean, filtered: boolean): Emphasis =>
    lit ? (litMember && !filtered ? 'lit' : 'dim') : filtered ? 'dim' : 'rest'

  for (const n of nodes) {
    const filtered = nodeFiltered(n)
    filteredIds.set(n.id, filtered)
    const litMember =
      n.data.kind === 'task'
        ? (lit?.nodes.has(n.id) ?? false)
        : n.data.kind === 'fanoutBundle'
          ? n.data.memberIds.some((id) =>
              id.startsWith('arc:')
                ? (lit?.proposals.has(arcKeyFromNodeId(id)) ?? false)
                : (lit?.nodes.has(id) ?? false),
            )
          : (lit?.proposals.has(n.data.arcKey) ?? false)
    map.set(n.id, resolve(litMember, filtered))
  }
  for (const e of edges) {
    const filtered = (filteredIds.get(e.source) ?? false) || (filteredIds.get(e.target) ?? false)
    const litMember = e.data?.keys.some((k) => lit?.edges.has(k)) ?? false
    map.set(e.id, resolve(litMember, filtered))
  }
  return map
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * A cheap signature of the input data: when this string changes between
 * renders, the graph must be rebuilt. Includes `cluster` so status flips
 * refresh node colours (the layout itself is deterministic, so rebuilds are
 * position-stable).
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
 * EXCLUDES non-Done `cluster` changes. Used as the fit-view gate so a
 * routine status flip (Queued→Blocked etc.) never yanks the camera.
 *
 * Done IS included because buildTopology excludes Done tasks from the
 * rendered graph — a task completing removes its node and the remaining
 * content must be re-centred.
 */
export const structuralSignature = (
  tasks: ReadonlyArray<ProgressTask>,
  proposals: ReadonlyArray<ProgressProposalNode>,
): string => {
  const taskSig = tasks
    .map(
      (t) =>
        `${t.id}|${t.parentProposalId ?? ''}|${t.originId ?? ''}|${t.fixForTaskId ?? ''}|${t.kind ?? ''}|${(t.blockedBy ?? []).join(',')}|${t.cluster === 'Done' ? 'd' : ''}`,
    )
    .join(';')
  const propSig = proposals.map((p) => `${p.id}|${p.title}`).join(';')
  return `${tasks.length}/${proposals.length}#${taskSig}#${propSig}`
}
