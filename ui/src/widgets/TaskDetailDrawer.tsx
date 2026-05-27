/**
 * Task detail drawer — right-side panel opened from any task node on the
 * Progress tab (DAG or column view).
 *
 * Two independent data sources:
 *   1. The `tasks`/`proposals` props (supplied immediately by the parent) drive
 *      the focus-subgraph section, visible before the detail fetch completes.
 *   2. A fetch to `/api/tasks/:id` drives the status row below the subgraph.
 *
 * The subgraph reuses `focusSubgraph` — the same helper used by the main DAG
 * canvas — and uses identical cluster colours so nodes carry the same visual
 * semantics in both contexts.
 */

import { useEffect, useState } from 'react'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { focusSubgraph } from '@/shared/focusSubgraph'

interface TaskDetailDrawerProps {
  /** Task id pulled from `#/task/<id>`. */
  taskId: string
  /** Clears the `#/task/<id>` hash so the drawer closes. */
  onClose: () => void
  /**
   * Override the fetcher in tests. Production callers omit it; the drawer
   * hits `/api/tasks/:id` via the runtime `fetch`.
   */
  fetchImpl?: typeof fetch
  /**
   * All in-scope tasks from the Progress tab — used to render the focus
   * subgraph. When omitted the subgraph section is not shown.
   */
  tasks?: ProgressTask[]
  /**
   * All in-scope proposal nodes — used for provenance edges in the subgraph.
   * Pass an empty array when there are no proposals.
   */
  proposals?: ProgressProposalNode[]
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; taskStatus: string }

// ── Mini-subgraph SVG constants ───────────────────────────────────────────────
// Slightly smaller than TopologyView's main-canvas constants; the drawer
// wraps in overflow-x-auto so wide chains remain navigable.

const MINI_NODE_W = 130
const MINI_NODE_H = 28
const MINI_LAYER_W = 160
const MINI_LAYER_H = 44
const MINI_PAD_X = 12
const MINI_PAD_Y = 12

// Identical hex values to TopologyView.nodeStyle so nodes carry the same
// cluster semantics on the drawer canvas as on the main canvas.
const miniNodeStyle = (
  kind: string,
  cluster: string | undefined,
): { fill: string; stroke: string; text: string } => {
  if (kind === 'idea') {
    // Proposal / provenance node — purple, matching TopologyView's proposal style.
    return { fill: '#2e1065', stroke: '#7c3aed', text: '#c4b5fd' }
  }
  switch (cluster) {
    case 'In progress':
      return { fill: '#431407', stroke: '#ea580c', text: '#fdba74' }
    case 'Blocked':
      return { fill: '#18181b', stroke: '#71717a', text: '#a1a1aa' }
    case 'Failed':
      return { fill: '#450a0a', stroke: '#dc2626', text: '#fca5a5' }
    default: // Queued
      return { fill: '#1c1917', stroke: '#78716c', text: '#d6d3d1' }
  }
}

interface PositionedMiniNode {
  id: string
  kind: string
  cluster: string | undefined
  label: string
  x: number
  y: number
}

interface SubgraphLayout {
  positioned: PositionedMiniNode[]
  edges: Array<{ from: string; to: string; kind: string }>
}

/**
 * Builds the focus subgraph for the drawer mini-canvas.
 *
 * Proposal nodes are mapped to `kind='idea'` so `focusSubgraph` correctly
 * treats provenance edges as fixed terminal hops.  Extra fields (`cluster`,
 * `label`) pass through the `GraphNode` index signature and are read back
 * after the subgraph slice is computed.
 *
 * The topological layer algorithm is the same as `TopologyView.assignLayers`.
 */
const buildSubgraphLayout = (
  tasks: ProgressTask[],
  proposals: ProgressProposalNode[],
  taskId: string,
): SubgraphLayout | null => {
  // Guard: the focused task must be in the dataset.
  if (!tasks.some((t) => t.id === taskId)) return null

  const inScope = new Set([...tasks.map((t) => t.id), ...proposals.map((p) => p.id)])

  const graphNodes = [
    ...tasks.map((t) => ({
      id: t.id,
      kind: 'task' as const,
      cluster: t.cluster as string,
      label: (t.prompt.split('\n')[0] ?? t.id).slice(0, 30),
    })),
    ...proposals.map((p) => ({
      id: p.id,
      kind: 'idea' as const,
      cluster: undefined as string | undefined,
      label: p.title.slice(0, 30),
    })),
  ]

  const graphEdges: Array<{ from: string; to: string; kind: 'blocker' | 'provenance' }> = []
  for (const t of tasks) {
    for (const bid of t.blockedBy ?? []) {
      if (inScope.has(bid)) graphEdges.push({ from: bid, to: t.id, kind: 'blocker' })
    }
    if (t.parentProposalId && inScope.has(t.parentProposalId)) {
      graphEdges.push({ from: t.parentProposalId, to: t.id, kind: 'provenance' })
    }
  }

  // focusSubgraph returns the task + its full upstream chain + one downstream
  // hop + the originating Proposal (as 'idea' provenance).
  const subgraph = focusSubgraph({ nodes: graphNodes, edges: graphEdges }, taskId)

  // Topological layer assignment — identical algorithm to TopologyView.
  const predecessors = new Map<string, Set<string>>()
  for (const n of subgraph.nodes) predecessors.set(n.id, new Set())
  for (const e of subgraph.edges) predecessors.get(e.to)?.add(e.from)

  const layers = new Map<string, number>()
  const remaining = new Set(subgraph.nodes.map((n) => n.id))
  for (let iter = 0; iter < subgraph.nodes.length + 1 && remaining.size > 0; iter++) {
    for (const id of remaining) {
      const preds = predecessors.get(id) ?? new Set<string>()
      if ([...preds].every((p) => layers.has(p))) {
        const maxPred = [...preds].reduce((acc, p) => Math.max(acc, layers.get(p) ?? 0), -1)
        layers.set(id, maxPred + 1)
        remaining.delete(id)
      }
    }
  }
  for (const id of remaining) layers.set(id, 0)

  const byLayer = new Map<number, string[]>()
  for (const n of subgraph.nodes) {
    const l = layers.get(n.id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(n.id)
  }

  const nodeById = new Map(subgraph.nodes.map((n) => [n.id, n]))
  const positioned: PositionedMiniNode[] = []
  for (const [layer, ids] of byLayer) {
    for (let i = 0; i < ids.length; i++) {
      const n = nodeById.get(ids[i]!)!
      positioned.push({
        id: n.id,
        kind: n.kind as string,
        cluster: n.cluster as string | undefined,
        label: (n.label as string | undefined) ?? n.id.slice(0, 20),
        x: MINI_PAD_X + layer * MINI_LAYER_W,
        y: MINI_PAD_Y + i * MINI_LAYER_H,
      })
    }
  }

  return { positioned, edges: subgraph.edges }
}

export const TaskDetailDrawer = ({
  taskId,
  onClose,
  fetchImpl,
  tasks,
  proposals,
}: TaskDetailDrawerProps) => {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    const f = fetchImpl ?? fetch
    f(`/api/tasks/${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          setState({ kind: 'not-found' })
          return
        }
        if (!res.ok) {
          setState({ kind: 'error', message: `HTTP ${res.status}` })
          return
        }
        const data = (await res.json()) as { task: { status: string } }
        setState({ kind: 'ready', taskStatus: data.task.status })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'request failed'
        setState({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [taskId, fetchImpl])

  // Compute the focus subgraph from props. This is independent of the detail
  // fetch so it renders immediately — the operator sees relationship context
  // while the status row is still loading.
  const subgraph =
    tasks != null && proposals != null
      ? buildSubgraphLayout(tasks, proposals, taskId)
      : null

  // Precompute a lookup for edge rendering.
  const posById = subgraph
    ? new Map(subgraph.positioned.map((n) => [n.id, n]))
    : new Map<string, PositionedMiniNode>()

  const svgWidth = subgraph
    ? subgraph.positioned.reduce((acc, n) => Math.max(acc, n.x + MINI_NODE_W), 0) + MINI_PAD_X
    : 0
  const svgHeight = subgraph
    ? subgraph.positioned.reduce((acc, n) => Math.max(acc, n.y + MINI_NODE_H), 0) + MINI_PAD_Y
    : 0

  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="Task detail"
      data-testid="task-detail-drawer"
      data-state={state.kind}
      className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-iron/40 bg-bg shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-iron/40 px-4 py-3">
        <h2 className="font-mono text-sm uppercase tracking-wide text-iron">
          Task {taskId}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close task detail"
          data-testid="task-detail-close"
          className="rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
        >
          Close
        </button>
      </header>

      {subgraph != null ? (
        <section
          data-testid="task-detail-subgraph"
          className="border-b border-iron/20 px-4 py-3"
        >
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            Context
          </h3>
          <div className="overflow-x-auto">
            <svg
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              aria-label="Task dependency context"
            >
              {/* Edges — rendered first so nodes appear on top */}
              {subgraph.edges.map((e) => {
                const from = posById.get(e.from)
                const to = posById.get(e.to)
                if (!from || !to) return null
                const x1 = from.x + MINI_NODE_W
                const y1 = from.y + MINI_NODE_H / 2
                const x2 = to.x
                const y2 = to.y + MINI_NODE_H / 2
                const cx = (x1 + x2) / 2
                return (
                  <path
                    key={`${e.from}::${e.to}::${e.kind}`}
                    d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                    data-edge-kind={e.kind}
                    fill="none"
                    stroke={e.kind === 'provenance' ? '#7c3aed' : '#52525b'}
                    strokeWidth={1.5}
                    strokeDasharray={e.kind === 'provenance' ? '4 2' : undefined}
                  />
                )
              })}

              {/* Nodes */}
              {subgraph.positioned.map((node) => {
                const s = miniNodeStyle(node.kind, node.cluster)
                // Translate 'idea' back to 'proposal' for data-node-kind so the
                // attribute matches TopologyView's convention on the main canvas.
                const displayKind = node.kind === 'idea' ? 'proposal' : node.kind
                return (
                  <g
                    key={node.id}
                    data-node-id={node.id}
                    data-node-kind={displayKind}
                    {...(node.kind === 'task' ? { 'data-cluster': node.cluster } : {})}
                    transform={`translate(${node.x}, ${node.y})`}
                  >
                    <rect
                      width={MINI_NODE_W}
                      height={MINI_NODE_H}
                      rx={3}
                      fill={s.fill}
                      stroke={s.stroke}
                      strokeWidth={1.5}
                    />
                    <text
                      x={6}
                      y={MINI_NODE_H / 2 + 4}
                      fontSize={10}
                      fontFamily="monospace"
                      fill={s.text}
                    >
                      {node.label}
                    </text>
                  </g>
                )
              })}
            </svg>
          </div>
        </section>
      ) : null}

      {state.kind === 'not-found' ? (
        <div
          data-testid="task-detail-not-found"
          className="flex flex-1 items-center justify-center p-6"
        >
          <p className="max-w-[40ch] text-center font-mono text-sm text-iron">
            Task not found. It may have been purged.
          </p>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <div
          data-testid="task-detail-body"
          className="flex-1 overflow-y-auto p-4"
        >
          <dl className="flex flex-col gap-3">
            <div>
              <dt className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
                Status
              </dt>
              <dd
                data-testid="task-detail-status"
                className="mt-1 font-mono text-sm text-fg"
              >
                {state.taskStatus}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </aside>
  )
}
