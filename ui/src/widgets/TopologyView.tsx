/**
 * Topology view — proposal→tasks fan-out DAG.
 *
 * Layout: proposals in the left column, their tasks fanned out to the right,
 * grouped by originating proposal.  Orphan tasks (no proposal) appear below.
 *
 * Edge styles:
 *   Provenance (proposal → task): dashed purple, no arrowhead (direction is
 *   obvious from the left-to-right fan-out layout).
 *   Blocker (task → task): solid gray with arrowhead showing direction.
 *
 * A legend below the graph explains every node colour and edge style.
 */

import { useMemo } from 'react'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { dagClusterStyle, DAG_EDGE_BLOCKER, DAG_EDGE_PROVENANCE } from '@/shared/dagColors'

// ---------------------------------------------------------------------------
// Internal graph model
// ---------------------------------------------------------------------------

interface TaskNode {
  kind: 'task'
  id: string
  label: string      // truncated display label
  fullLabel: string  // full text for <title> tooltip
  cluster: ProgressTask['cluster']
}

interface ProposalNode {
  kind: 'proposal'
  id: string
  label: string
  fullLabel: string
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

const NODE_W = 220
const NODE_H = 44
const PROPOSAL_COL_X = 24
// Tasks sit 100px to the right of the proposal column end
const TASK_COL_X = PROPOSAL_COL_X + NODE_W + 100
const ITEM_GAP = 8    // vertical gap between tasks within a group
const GROUP_GAP = 32  // vertical gap between proposal groups
const PAD_Y = 24
// Max label length — keeps text within the 220 px node at 11 px monospace (~6.6 px/char)
const MAX_LABEL = 30

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

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
    ...tasks.map((t): TaskNode => {
      const full = t.prompt.split('\n')[0] ?? t.id
      return {
        kind: 'task',
        id: t.id,
        label: truncate(full, MAX_LABEL),
        fullLabel: full,
        cluster: t.cluster,
      }
    }),
    ...proposals.map((p): ProposalNode => ({
      kind: 'proposal',
      id: p.id,
      label: truncate(p.title, MAX_LABEL),
      fullLabel: p.title,
    })),
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
// Fan-out layout — proposals left, their tasks right, grouped vertically
// ---------------------------------------------------------------------------

const layoutNodes = (nodes: DagNode[], edges: DagEdge[]): PositionedNode[] => {
  const tasks = nodes.filter((n): n is TaskNode => n.kind === 'task')
  const proposals = nodes.filter((n): n is ProposalNode => n.kind === 'proposal')

  // Build proposal → child task IDs from provenance edges
  const proposalToTaskIds = new Map<string, string[]>()
  const tasksWithParent = new Set<string>()

  for (const e of edges) {
    if (e.kind === 'provenance') {
      const list = proposalToTaskIds.get(e.from) ?? []
      list.push(e.to)
      proposalToTaskIds.set(e.from, list)
      tasksWithParent.add(e.to)
    }
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const positioned: PositionedNode[] = []
  let cursorY = PAD_Y

  // Place each proposal + its tasks as a vertically grouped block
  for (const prop of proposals) {
    const childIds = proposalToTaskIds.get(prop.id) ?? []
    const childTasks = childIds
      .map((id) => taskById.get(id))
      .filter((t): t is TaskNode => t != null)

    const itemCount = Math.max(1, childTasks.length)
    const groupH = itemCount * NODE_H + (itemCount - 1) * ITEM_GAP

    // Proposal node: vertically centred within its group
    positioned.push({
      ...prop,
      x: PROPOSAL_COL_X,
      y: cursorY + Math.round((groupH - NODE_H) / 2),
    })

    // Task nodes: stacked downward from the top of the group
    for (let i = 0; i < childTasks.length; i++) {
      positioned.push({
        ...childTasks[i]!,
        x: TASK_COL_X,
        y: cursorY + i * (NODE_H + ITEM_GAP),
      })
    }

    cursorY += groupH + GROUP_GAP
  }

  // Orphan tasks (no parent proposal in scope) — right column, below all groups
  for (const t of tasks.filter((t) => !tasksWithParent.has(t.id))) {
    positioned.push({ ...t, x: TASK_COL_X, y: cursorY })
    cursorY += NODE_H + ITEM_GAP
  }

  return positioned
}

// ---------------------------------------------------------------------------
// Edge path
// ---------------------------------------------------------------------------

const edgePath = (from: PositionedNode, to: PositionedNode): string => {
  const x0 = from.x + NODE_W
  const y0 = from.y + NODE_H / 2
  const x1 = to.x
  const y1 = to.y + NODE_H / 2

  // Same-column edges (blocker between two tasks): arc outward to the right
  // so the curve clears the node boxes.
  if (Math.abs(from.x - to.x) < 10) {
    const offset = Math.round(NODE_W * 0.65)
    return `M ${x0} ${y0} C ${x0 + offset} ${y0}, ${x0 + offset} ${y1}, ${x1} ${y1}`
  }

  // Cross-column edges (proposal → task): standard horizontal S-curve
  const cx = Math.round((x0 + x1) / 2)
  return `M ${x0} ${y0} C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`
}

// ---------------------------------------------------------------------------
// Node styling
// ---------------------------------------------------------------------------

const nodeStyle = (node: PositionedNode) =>
  dagClusterStyle(node.kind, node.kind === 'task' ? node.cluster : undefined)

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TopologyViewProps {
  tasks: ProgressTask[]
  proposals: ProgressProposalNode[]
  /**
   * Cluster names (e.g. "Blocked", "Failed") or "Proposal" whose nodes should
   * be rendered with a ghosted (low-opacity) style.
   */
  ghostedClusters?: Set<string>
  /**
   * When set, only the named proposal and the tasks it sliced stay highlighted;
   * every other node ghosts.
   */
  selectedProposalId?: string | null
}

// ---------------------------------------------------------------------------
// Legend items
// ---------------------------------------------------------------------------

const LEGEND_NODE_ITEMS = [
  { label: 'Proposal', kind: 'proposal' as const, cluster: undefined },
  { label: 'Queued', kind: 'task' as const, cluster: 'Queued' as const },
  { label: 'In progress', kind: 'task' as const, cluster: 'In progress' as const },
  { label: 'Blocked', kind: 'task' as const, cluster: 'Blocked' as const },
  { label: 'Failed', kind: 'task' as const, cluster: 'Failed' as const },
] as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

  // When a proposal is selected, compute the set of highlighted node IDs.
  const matchingIds: Set<string> | null = selectedProposalId
    ? new Set([
        selectedProposalId,
        ...tasks
          .filter((t) => t.parentProposalId === selectedProposalId)
          .map((t) => t.id),
      ])
    : null

  const posById = new Map(positioned.map((n) => [n.id, n]))

  const contentMaxX = Math.max(...positioned.map((n) => n.x + NODE_W))
  const contentMaxY = Math.max(...positioned.map((n) => n.y + NODE_H))

  // Legend geometry
  const LEGEND_Y = contentMaxY + 40
  const LEGEND_SWATCH_W = 16
  const LEGEND_SWATCH_H = 12
  const LEGEND_COL_W = 110
  const LEGEND_EDGE_ROW_Y = 28
  const svgW = Math.max(contentMaxX + PROPOSAL_COL_X, 700)
  const svgH = LEGEND_Y + LEGEND_EDGE_ROW_Y + 20

  return (
    <main className="flex min-h-0 flex-1 overflow-auto bg-bg p-4">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        aria-label="Task dependency graph"
      >
        <defs>
          {/* Arrowhead for blocker edges — direction shows which task is blocked */}
          <marker
            id="arrow-blocker"
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path d="M0,0 L0,7 L7,3.5 z" style={{ fill: DAG_EDGE_BLOCKER }} />
          </marker>
        </defs>

        {/* Edges — drawn first so nodes sit on top */}
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
              style={{ stroke: e.kind === 'provenance' ? DAG_EDGE_PROVENANCE : DAG_EDGE_BLOCKER }}
              strokeWidth={1.5}
              strokeDasharray={e.kind === 'provenance' ? '4 3' : undefined}
              {...(e.kind === 'blocker' ? { markerEnd: 'url(#arrow-blocker)' } : {})}
            />
          )
        })}

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

          const inner = (
            <g
              data-node-kind={node.kind}
              {...(node.kind === 'task' ? { 'data-cluster': node.cluster } : {})}
              {...(ghosted ? { 'data-ghosted': 'true' } : {})}
              opacity={ghosted ? 0.2 : 1}
              transform={`translate(${node.x}, ${node.y})`}
            >
              <title>{node.fullLabel}</title>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={5}
                style={{ fill: s.fill, stroke: s.stroke }}
                strokeWidth={1.5}
              />
              <text
                x={8}
                y={NODE_H / 2 + 4}
                fontSize={11}
                fontFamily="monospace"
                style={{ fill: s.text }}
              >
                {node.label}
              </text>
            </g>
          )

          if (node.kind === 'task') {
            return (
              <a
                key={node.id}
                href={`#/task/${encodeURIComponent(node.id)}`}
                style={{ cursor: 'pointer' }}
              >
                {inner}
              </a>
            )
          }

          return (
            <a
              key={node.id}
              href={`#/proposal-node/${encodeURIComponent(node.id)}`}
              style={{ cursor: 'pointer' }}
            >
              {inner}
            </a>
          )
        })}

        {/* Legend — explains every node colour and edge style */}
        <g data-legend="true" transform={`translate(${PROPOSAL_COL_X}, ${LEGEND_Y})`}>
          {/* Label */}
          <text
            x={0}
            y={0}
            fontSize={10}
            fontFamily="monospace"
            style={{ fill: 'var(--color-iron, #71717a)' }}
          >
            Nodes:
          </text>

          {/* Node swatches */}
          {LEGEND_NODE_ITEMS.map(({ label, kind, cluster }, i) => {
            const st = dagClusterStyle(kind, cluster)
            return (
              <g key={label} transform={`translate(${50 + i * LEGEND_COL_W}, -4)`}>
                <rect
                  width={LEGEND_SWATCH_W}
                  height={LEGEND_SWATCH_H}
                  rx={2}
                  style={{ fill: st.fill, stroke: st.stroke }}
                  strokeWidth={1}
                />
                <text
                  x={LEGEND_SWATCH_W + 4}
                  y={LEGEND_SWATCH_H - 1}
                  fontSize={10}
                  fontFamily="monospace"
                  style={{ fill: 'var(--color-iron, #a1a1aa)' }}
                >
                  {label}
                </text>
              </g>
            )
          })}

          {/* Edge legend row */}
          <text
            x={0}
            y={LEGEND_EDGE_ROW_Y}
            fontSize={10}
            fontFamily="monospace"
            style={{ fill: 'var(--color-iron, #71717a)' }}
          >
            Edges:
          </text>

          {/* Blocker edge sample (solid + arrowhead) */}
          <g transform={`translate(50, ${LEGEND_EDGE_ROW_Y - 8})`}>
            <line
              x1={0}
              y1={4}
              x2={30}
              y2={4}
              stroke={DAG_EDGE_BLOCKER}
              strokeWidth={1.5}
              markerEnd="url(#arrow-blocker)"
            />
            <text
              x={36}
              y={8}
              fontSize={10}
              fontFamily="monospace"
              style={{ fill: 'var(--color-iron, #a1a1aa)' }}
            >
              Blocks (A blocks B)
            </text>
          </g>

          {/* Provenance edge sample (dashed, no arrowhead) */}
          <g transform={`translate(230, ${LEGEND_EDGE_ROW_Y - 8})`}>
            <line
              x1={0}
              y1={4}
              x2={30}
              y2={4}
              stroke={DAG_EDGE_PROVENANCE}
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text
              x={36}
              y={8}
              fontSize={10}
              fontFamily="monospace"
              style={{ fill: 'var(--color-iron, #a1a1aa)' }}
            >
              Originates from proposal
            </text>
          </g>
        </g>
      </svg>
    </main>
  )
}
