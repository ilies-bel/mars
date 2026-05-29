/**
 * Topology view — renders a DAG of blocker and provenance edges.
 *
 * Each in-scope task is a node coloured by its server-assigned cluster.
 * Each Proposal that sliced at least one in-scope task appears as a node with
 * provenance edges to its tasks.  Blocker edges go from the upstream task to
 * its dependent (blocker → dependent).
 *
 * Layout: topological layers left-to-right (roots on the left), nodes stacked
 * vertically within each layer.  Pure SVG — no external graph library.
 */

import { useMemo } from 'react'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Internal graph model
// ---------------------------------------------------------------------------

interface TaskNode {
  kind: 'task'
  id: string
  label: string
  cluster: ProgressTask['cluster']
}

interface ProposalNode {
  kind: 'proposal'
  id: string
  label: string
}

type DagNode = TaskNode | ProposalNode

interface DagEdge {
  from: string
  to: string
  kind: 'blocker' | 'provenance'
}

type PositionedNode = DagNode & { x: number; y: number }

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const NODE_W = 164
const NODE_H = 38
const LAYER_W = 200   // horizontal gap between layer columns
const LAYER_H = 58    // vertical gap between nodes within a layer
const PAD_X = 20
const PAD_Y = 24

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

const buildGraph = (
  tasks: ProgressTask[],
  proposals: ProgressProposalNode[],
): { nodes: DagNode[]; edges: DagEdge[] } => {
  const inScope = new Set<string>([
    ...tasks.map((t) => t.id),
    ...proposals.map((p) => p.id),
  ])

  const nodes: DagNode[] = [
    ...tasks.map(
      (t): TaskNode => ({
        kind: 'task',
        id: t.id,
        label: (t.prompt.split('\n')[0] ?? t.id).slice(0, 36),
        cluster: t.cluster,
      }),
    ),
    ...proposals.map(
      (p): ProposalNode => ({
        kind: 'proposal',
        id: p.id,
        label: p.title.slice(0, 36),
      }),
    ),
  ]

  const edges: DagEdge[] = []

  for (const t of tasks) {
    for (const bid of t.blockedBy ?? []) {
      if (inScope.has(bid)) {
        edges.push({ from: bid, to: t.id, kind: 'blocker' })
      }
    }
    if (t.parentProposalId && inScope.has(t.parentProposalId)) {
      edges.push({ from: t.parentProposalId, to: t.id, kind: 'provenance' })
    }
  }

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Topological layer assignment (longest-path from roots)
// ---------------------------------------------------------------------------

const assignLayers = (nodes: DagNode[], edges: DagEdge[]): Map<string, number> => {
  const predecessors = new Map<string, Set<string>>()
  for (const n of nodes) predecessors.set(n.id, new Set())
  for (const e of edges) predecessors.get(e.to)?.add(e.from)

  const layers = new Map<string, number>()
  const remaining = new Set(nodes.map((n) => n.id))

  // Iterative longest-path from roots; cap iterations to handle cycles.
  for (let iter = 0; iter < nodes.length + 1 && remaining.size > 0; iter++) {
    for (const id of remaining) {
      const preds = predecessors.get(id) ?? new Set<string>()
      const allResolved = [...preds].every((p) => layers.has(p))
      if (allResolved) {
        const maxPred = [...preds].reduce(
          (acc, p) => Math.max(acc, layers.get(p) ?? 0),
          -1,
        )
        layers.set(id, maxPred + 1)
        remaining.delete(id)
      }
    }
  }
  // Fallback: place any cycle participants at layer 0
  for (const id of remaining) layers.set(id, 0)

  return layers
}

// ---------------------------------------------------------------------------
// Position nodes in a grid
// ---------------------------------------------------------------------------

const layoutNodes = (nodes: DagNode[], edges: DagEdge[]): PositionedNode[] => {
  const layers = assignLayers(nodes, edges)

  // Group by layer, preserving insertion order within each layer
  const byLayer = new Map<number, string[]>()
  for (const n of nodes) {
    const l = layers.get(n.id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(n.id)
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const positioned: PositionedNode[] = []

  for (const [layer, ids] of byLayer) {
    for (let i = 0; i < ids.length; i++) {
      const node = nodeById.get(ids[i]!)!
      positioned.push({
        ...node,
        x: PAD_X + layer * LAYER_W,
        y: PAD_Y + i * LAYER_H,
      })
    }
  }

  return positioned
}

// ---------------------------------------------------------------------------
// Edge path: cubic Bézier from right-centre of from-node to left-centre of to-node
// ---------------------------------------------------------------------------

const edgePath = (
  from: PositionedNode,
  to: PositionedNode,
): string => {
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2
  const x2 = to.x
  const y2 = to.y + NODE_H / 2
  const cx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`
}

// ---------------------------------------------------------------------------
// Node styling by cluster / kind
// ---------------------------------------------------------------------------

type NodeStyle = {
  fill: string
  stroke: string
  text: string
}

const nodeStyle = (node: PositionedNode): NodeStyle => {
  if (node.kind === 'proposal') {
    return { fill: '#2e1065', stroke: '#7c3aed', text: '#c4b5fd' }
  }
  switch (node.cluster) {
    case 'In progress':
      return { fill: '#431407', stroke: '#ea580c', text: '#fdba74' }
    case 'Blocked':
      return { fill: '#18181b', stroke: '#71717a', text: '#a1a1aa' }
    case 'Failed':
      return { fill: '#450a0a', stroke: '#dc2626', text: '#fca5a5' }
    case 'Queued':
      return { fill: '#1c1917', stroke: '#78716c', text: '#d6d3d1' }
  }
}

// ---------------------------------------------------------------------------
// TopologyView component
// ---------------------------------------------------------------------------

export interface TopologyViewProps {
  tasks: ProgressTask[]
  proposals: ProgressProposalNode[]
  /**
   * Set of cluster names (e.g. "Blocked", "Failed") or "Proposal" whose nodes
   * should be rendered with a ghosted (low-opacity) style.  Drives the
   * per-cluster toggle controls on the Progress tab.
   */
  ghostedClusters?: Set<string>
  /**
   * When set, only the named proposal and the tasks it sliced stay
   * highlighted; every other node (including non-selected proposals) ghosts.
   * Combines with ghostedClusters — a node ghosts if either rule applies.
   */
  selectedProposalId?: string | null
}

export const TopologyView = ({
  tasks,
  proposals,
  ghostedClusters,
  selectedProposalId,
}: TopologyViewProps) => {
  const { nodes, edges } = useMemo(() => buildGraph(tasks, proposals), [tasks, proposals])

  const positioned = useMemo(() => layoutNodes(nodes, edges), [nodes, edges])

  if (nodes.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-bg">
        <p className="font-mono text-[13px] text-iron">No active tasks</p>
      </main>
    )
  }

  // When a proposal is selected, build the set of matching node IDs:
  // the proposal itself + all tasks sliced from it. Everything else ghosts.
  const matchingIds: Set<string> | null = selectedProposalId
    ? new Set([
        selectedProposalId,
        ...tasks
          .filter((t) => t.parentProposalId === selectedProposalId)
          .map((t) => t.id),
      ])
    : null

  const posById = new Map(positioned.map((n) => [n.id, n]))

  // Canvas size: fit all nodes with padding
  const maxX = Math.max(...positioned.map((n) => n.x + NODE_W)) + PAD_X
  const maxY = Math.max(...positioned.map((n) => n.y + NODE_H)) + PAD_Y

  return (
    <main className="flex min-h-0 flex-1 overflow-auto bg-bg p-4">
      <svg
        width={maxX}
        height={maxY}
        viewBox={`0 0 ${maxX} ${maxY}`}
        aria-label="Task dependency graph"
      >
        {/* Edges — rendered first so nodes appear on top */}
        {edges.map((e) => {
          const from = posById.get(e.from)
          const to = posById.get(e.to)
          if (!from || !to) return null
          return (
            <path
              key={`${e.from}::${e.to}::${e.kind}`}
              d={edgePath(from, to)}
              data-edge-kind={e.kind}
              fill="none"
              stroke={e.kind === 'provenance' ? '#7c3aed' : '#52525b'}
              strokeWidth={1.5}
              strokeDasharray={e.kind === 'provenance' ? '4 2' : undefined}
              markerEnd="url(#arrow)"
            />
          )
        })}

        {/* Arrow marker */}
        <defs>
          <marker
            id="arrow"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L0,6 L6,3 z" fill="#52525b" />
          </marker>
        </defs>

        {/* Nodes */}
        {positioned.map((node) => {
          const s = nodeStyle(node)
          const clusterGhosted =
            ghostedClusters != null &&
            (node.kind === 'proposal'
              ? ghostedClusters.has('Proposal')
              : ghostedClusters.has(node.cluster))
          const proposalGhosted = matchingIds !== null && !matchingIds.has(node.id)
          const ghosted = clusterGhosted || proposalGhosted

          const g = (
            <g
              key={node.id}
              data-node-kind={node.kind}
              {...(node.kind === 'task' ? { 'data-cluster': node.cluster } : {})}
              {...(ghosted ? { 'data-ghosted': 'true' } : {})}
              opacity={ghosted ? 0.2 : 1}
              transform={`translate(${node.x}, ${node.y})`}
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={4}
                fill={s.fill}
                stroke={s.stroke}
                strokeWidth={1.5}
              />
              <text
                x={8}
                y={NODE_H / 2 + 4}
                fontSize={11}
                fontFamily="monospace"
                fill={s.text}
              >
                {node.label}
              </text>
            </g>
          )

          // A task node is wrapped in a link that opens the Task drawer.
          // Proposal node click behaviour is handled in a later slice.
          if (node.kind === 'task') {
            return (
              <a
                key={node.id}
                href={`#/task/${encodeURIComponent(node.id)}`}
                style={{ cursor: 'pointer' }}
              >
                {g}
              </a>
            )
          }

          return g
        })}
      </svg>
    </main>
  )
}
