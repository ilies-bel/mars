/**
 * Focus subgraph computation for the ui/ Graph view.
 *
 * Given the full Actionable graph (nodes + directed blocker/provenance edges)
 * and a focused node id, return the slice the operator cares about:
 *
 *   - the focused task,
 *   - its full upstream blocker chain back to the roots,
 *   - one downstream hop (immediate dependents),
 *   - the originating Idea attached as a fixed provenance hop.
 *
 * When no node is focused (null/undefined/empty) or the focus id is absent
 * from the graph, the input graph is returned unchanged — the caller decides
 * what "no focus" means at the UI level.
 *
 * Edges:
 *   - kind 'blocker' goes blocker -> dependent (so `e.to === current` is the
 *     upstream direction from `current`'s perspective).
 *   - kind 'provenance' goes idea -> task. We never walk further upstream
 *     through an Idea hop; the Idea is a fixed terminal provenance node.
 *
 * The function is pure and side-effect-free.
 */

export type NodeKind = 'task' | 'idea'
export type EdgeKind = 'blocker' | 'provenance'

export interface GraphNode {
  id: string
  kind: NodeKind
  [key: string]: unknown
}

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const edgeKey = (e: GraphEdge): string => `${e.from}::${e.to}::${e.kind}`

export const focusSubgraph = (graph: Graph, focusId: string | null | undefined): Graph => {
  if (!focusId) return graph
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
  if (!nodesById.has(focusId)) return graph

  const keepNodes = new Set<string>([focusId])
  const keepEdges = new Map<string, GraphEdge>()

  const include = (e: GraphEdge): void => {
    keepEdges.set(edgeKey(e), e)
  }

  // Upstream: BFS along blocker edges back to the roots.
  const queue: string[] = [focusId]
  const seen = new Set<string>([focusId])
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const e of graph.edges) {
      if (e.kind !== 'blocker') continue
      if (e.to !== cur) continue
      if (!nodesById.has(e.from)) continue
      include(e)
      keepNodes.add(e.from)
      if (!seen.has(e.from)) {
        seen.add(e.from)
        queue.push(e.from)
      }
    }
  }

  // Downstream: exactly one hop along blocker edges.
  for (const e of graph.edges) {
    if (e.kind !== 'blocker') continue
    if (e.from !== focusId) continue
    if (!nodesById.has(e.to)) continue
    include(e)
    keepNodes.add(e.to)
  }

  // Provenance: the originating Idea (idea -> focus). Fixed hop, not traversed
  // further upstream.
  for (const e of graph.edges) {
    if (e.kind !== 'provenance') continue
    if (e.to !== focusId) continue
    if (!nodesById.has(e.from)) continue
    include(e)
    keepNodes.add(e.from)
  }

  return {
    nodes: graph.nodes.filter((n) => keepNodes.has(n.id)),
    edges: [...keepEdges.values()],
  }
}
