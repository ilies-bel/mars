/**
 * ArcGraph — compact G6 DAG for the action-queue card's blocker/blocking/recovery arc.
 *
 * Replaces the three flat DagList text sections with a small top-to-bottom graph:
 *   blockers (upstream) → central task → blocking (downstream)
 *                                       ↓ (recovers dashed)
 *                                    descendants
 *
 * Layout: antv-dagre TB.  Color tokens match the main TopologyView canvas so
 * the two visualisations stay in sync.
 *
 * Pure model function `buildArcData` is exported for unit testing without G6.
 * The component itself follows the same pattern as TopologyView: G6 is only
 * constructed when a real DOM container is available, so renderToStaticMarkup
 * only exercises the null-guard (empty arc) and the outer wrapper div.
 */

import { useEffect, useRef } from 'react'
import { Graph, type EdgeData, type IPointerEvent, type NodeData } from '@antv/g6'
import type { Cluster, DagContext } from '@/shared/schemas'
import {
  ACTIVE_ACCENT,
  CANVAS_SURFACE,
  CLUSTER_STYLE,
  EDGE_BLOCK,
} from './topologyGraphModel'

// ---------------------------------------------------------------------------
// Status → Cluster mapping (dag nodes carry a raw status string)
// ---------------------------------------------------------------------------

const STATUS_TO_CLUSTER: Record<string, Cluster> = {
  running: 'In progress',
  blocked: 'Blocked',
  failed: 'Failed',
}

const clusterOf = (status: string): Cluster =>
  STATUS_TO_CLUSTER[status] ?? 'Queued'

const nodeStyle = (status: string) => CLUSTER_STYLE[clusterOf(status)]

// ---------------------------------------------------------------------------
// Pure model transform — testable without G6 or a DOM
// ---------------------------------------------------------------------------

export interface ArcGraphData {
  nodes: NodeData[]
  edges: EdgeData[]
}

/**
 * Build the G6 graph data for a small arc DAG.
 *
 * Rules:
 *  - One node per id in `{entityId} ∪ blockers ∪ blocking ∪ descendants`
 *  - Edges come verbatim from `dag.edges` (deduped + sorted by the server)
 *  - The central node (`entityId`) gets an accent-ring emphasis
 */
export const buildArcData = (
  dag: DagContext,
  entityId: string,
  entityStatus: string,
): ArcGraphData => {
  // Collect all nodes, deduplicating by id.  The central node is first so
  // a duplicate lookup skips periphery entries that mention the same id.
  const seenIds = new Set<string>()

  const rawNodes = [
    { id: entityId, status: entityStatus, isCenter: true },
    ...dag.blockers.map((n) => ({ id: n.id, status: n.status, isCenter: false })),
    ...dag.blocking.map((n) => ({ id: n.id, status: n.status, isCenter: false })),
    ...dag.descendants.map((n) => ({ id: n.id, status: n.status, isCenter: false })),
  ].filter((n) => {
    if (seenIds.has(n.id)) return false
    seenIds.add(n.id)
    return true
  })

  const nodes: NodeData[] = rawNodes.map((n) => ({
    id: n.id,
    data: { status: n.status, isCenter: n.isCenter },
  }))

  const edges: EdgeData[] = dag.edges.map((e) => ({
    id: `${e.from}:${e.to}:${e.kind}`,
    source: e.from,
    target: e.to,
    data: { kind: e.kind },
  }))

  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface ArcGraphProps {
  dag: DagContext
  entityId: string
  /** Task status string (e.g. 'failed', 'running') used to colour the central node. */
  entityStatus: string
}

// ---------------------------------------------------------------------------
// Public component — guards the empty case; renders null when no arc nodes
// ---------------------------------------------------------------------------

/**
 * Renders the arc DAG graph when there are peripheral nodes (blockers,
 * blocking tasks, or recovery descendants).  Returns null when the dag
 * contains only the central entity so no empty canvas box is ever shown.
 */
export const ArcGraph = ({ dag, entityId, entityStatus }: ArcGraphProps) => {
  const hasNodes =
    dag.blockers.length > 0 ||
    dag.blocking.length > 0 ||
    dag.descendants.length > 0

  if (!hasNodes) return null

  return <ArcGraphCanvas dag={dag} entityId={entityId} entityStatus={entityStatus} />
}

// ---------------------------------------------------------------------------
// Inner canvas component — mounts G6 on a real DOM node
// ---------------------------------------------------------------------------

/**
 * Only rendered when the arc is non-empty.  G6 is constructed inside a
 * useEffect so renderToStaticMarkup / SSR never touches the canvas API.
 *
 * A11y: the canvas is `aria-hidden`; a visually-hidden `<ul>` lists the same
 * nodes for screen readers so the component doesn't trap assistive focus.
 */
const ArcGraphCanvas = ({ dag, entityId, entityStatus }: ArcGraphProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<Graph | null>(null)

  // Stable signature: rebuild when the logical arc changes (new item selected
  // or server pushes updated dag state).
  const sig = [
    entityId,
    entityStatus,
    dag.edges.map((e) => `${e.from}:${e.to}:${e.kind}`).join(','),
  ].join('|')

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    const { nodes, edges } = buildArcData(dag, entityId, entityStatus)

    const graph = new Graph({
      container,
      autoResize: true,
      padding: [24, 32, 24, 32],
      // Disable animation — the card is a read-only detail view, not a
      // live-updating visualisation.  Instant render keeps the card snappy.
      animation: false,
      background: CANVAS_SURFACE,
      data: { nodes, edges },
      node: {
        type: 'rect',
        style: {
          size: [148, 32],
          radius: 6,
          fill: (d: NodeData) => nodeStyle(String(d.data?.status ?? '')).fill,
          stroke: (d: NodeData) =>
            d.data?.isCenter
              ? ACTIVE_ACCENT
              : nodeStyle(String(d.data?.status ?? '')).stroke,
          lineWidth: (d: NodeData) => (d.data?.isCenter ? 2.5 : 1.25),
          labelText: (d: NodeData) => String(d.id ?? ''),
          labelFill: (d: NodeData) => nodeStyle(String(d.data?.status ?? '')).text,
          labelFontSize: 10,
          labelFontFamily: 'JetBrains Mono, monospace',
          labelPlacement: 'center',
          labelMaxWidth: 138,
          labelWordWrap: true,
        },
      },
      edge: {
        type: 'cubic-vertical',
        style: {
          stroke: (d: EdgeData) =>
            d.data?.kind === 'recovers' ? ACTIVE_ACCENT : EDGE_BLOCK,
          lineWidth: 1.25,
          endArrow: true,
          endArrowSize: 5,
          opacity: 0.75,
        },
      },
      layout: {
        type: 'antv-dagre',
        rankdir: 'TB',
        nodesep: 24,
        ranksep: 48,
        ranker: 'network-simplex',
      },
      behaviors: ['drag-canvas', 'zoom-canvas'],
    })

    graphRef.current = graph

    void graph.render().then(() => void graph.fitView())

    // Single-click a node → open its task drawer via hash navigation
    graph.on('node:click', (ev: IPointerEvent) => {
      const id = String((ev.target as { id?: string }).id ?? '')
      if (id) window.location.hash = `#/task/${encodeURIComponent(id)}`
    })

    return () => {
      try {
        graph.destroy()
      } catch {
        /* ignore G6 teardown errors */
      }
      graphRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])

  // A11y: visually-hidden text list mirrors the graph for screen readers.
  // The canvas is aria-hidden so AT users aren't presented with a blank canvas.
  const a11yNodes = [
    ...dag.blockers.map((n) => ({ ...n, rel: 'blocks this task' as const })),
    ...dag.blocking.map((n) => ({ ...n, rel: 'blocked by this task' as const })),
    ...dag.descendants.map((n) => ({ ...n, rel: 'recovery descendant' as const })),
  ]

  return (
    <div>
      {/* Bounded height so the graph never pushes card content off-screen */}
      <div
        ref={containerRef}
        className="h-[220px] w-full rounded"
        aria-hidden="true"
      />
      <ul className="sr-only">
        {a11yNodes.map((n) => (
          <li key={n.id}>
            {n.id} ({n.status}) — {n.rel}
          </li>
        ))}
      </ul>
    </div>
  )
}
