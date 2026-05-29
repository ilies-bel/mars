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
 *
 * A step timeline section shows every Step span for the task's originId,
 * fetched from `/api/step-spans`. Pass `stepSpans` directly to skip the fetch
 * (used in tests and static rendering).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { focusSubgraph } from '@/shared/focusSubgraph'
import { dagClusterStyle, DAG_EDGE_BLOCKER, DAG_EDGE_PROVENANCE } from '@/shared/dagColors'

/** A single step execution span — one step_started event paired with its step_ended (if any). */
export interface StepSpan {
  stepName: string
  phase: string | null
  workflowInstanceId: string
  workerName: string | null
  /** 'running' when no step_ended event has been recorded yet. */
  outcome: 'running' | 'completed' | 'failed' | 'killed'
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  taskId: string | null
  originId: string | null
}

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
  /**
   * Pre-loaded step spans. When provided the step timeline renders immediately
   * without fetching `/api/step-spans`. Omit in production; pass in tests or
   * static rendering to control the timeline content directly.
   */
  stepSpans?: StepSpan[]
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

// Delegates to the shared dagClusterStyle so both canvases always match.
// The 'idea' kind is TaskDetailDrawer's alias for proposal nodes.
const miniNodeStyle = dagClusterStyle

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

/** Format a durationMs value for display (e.g. "500ms" or "12.3s"). */
const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`

/** Outcome → short human label for the timeline row. */
const outcomeLabel = (outcome: StepSpan['outcome']): string => {
  switch (outcome) {
    case 'running':
      return 'running…'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'killed'
  }
}

export const TaskDetailDrawer = ({
  taskId,
  onClose,
  fetchImpl,
  tasks,
  proposals,
  stepSpans,
}: TaskDetailDrawerProps) => {
  const drawerRef = useRef<HTMLElement>(null)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)

  /**
   * Step spans fetched from the API. Null until the task detail fetch succeeds
   * and the spans request completes. Ignored when the `stepSpans` prop is set.
   */
  const [fetchedSpans, setFetchedSpans] = useState<StepSpan[] | null>(null)

  /**
   * Initiates the exit animation (180 ms) then calls the onClose prop.
   * All close triggers (button, scrim, Escape) funnel through here so the
   * transition always plays before the parent unmounts the drawer.
   */
  const handleClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose(), 180)
  }, [onClose])

  // On open: save the previously focused element and move focus into the drawer.
  // On close (cleanup): restore focus to where it was.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    drawerRef.current?.focus()
    return () => {
      prev?.focus?.()
    }
  }, [])

  // Escape-to-close + Tab focus trap.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
        return
      }
      if (e.key === 'Tab') {
        const container = drawerRef.current
        if (!container) return
        const focusable = [
          ...container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
        if (focusable.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        if (e.shiftKey) {
          if (document.activeElement === first || document.activeElement === container) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClose])

  useEffect(() => {
    // When stepSpans prop is provided, skip the task+spans fetch entirely —
    // the caller has pre-loaded spans (used in tests and static rendering).
    if (stepSpans !== undefined) return

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
        const data = (await res.json()) as {
          task: { status: string; originId?: string | null }
        }
        setState({ kind: 'ready', taskStatus: data.task.status })

        // Fetch step spans. Use originId from the task response (falls back to
        // taskId when the column is absent from older DBs).
        const originId = data.task.originId ?? taskId
        f(`/api/step-spans?originId=${encodeURIComponent(originId)}`)
          .then(async (spansRes) => {
            if (cancelled || !spansRes.ok) return
            const spansData = (await spansRes.json()) as { spans: StepSpan[] }
            if (!cancelled) setFetchedSpans(spansData.spans)
          })
          .catch(() => {
            // Step spans are optional display data — a failed fetch silently
            // leaves the timeline section absent rather than erroring the drawer.
          })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'request failed'
        setState({ kind: 'error', message })
      })
    return () => {
      cancelled = true
    }
  }, [taskId, fetchImpl, stepSpans])

  // Compute the focus subgraph from props. This is independent of the detail
  // fetch so it renders immediately — the operator sees relationship context
  // while the status row is still loading.
  const subgraph = useMemo(
    () =>
      tasks != null && proposals != null
        ? buildSubgraphLayout(tasks, proposals, taskId)
        : null,
    [tasks, proposals, taskId],
  )

  // Precompute a lookup for edge rendering.
  const posById = useMemo(
    () =>
      subgraph
        ? new Map(subgraph.positioned.map((n) => [n.id, n]))
        : new Map<string, PositionedMiniNode>(),
    [subgraph],
  )

  const svgWidth = subgraph
    ? subgraph.positioned.reduce((acc, n) => Math.max(acc, n.x + MINI_NODE_W), 0) + MINI_PAD_X
    : 0
  const svgHeight = subgraph
    ? subgraph.positioned.reduce((acc, n) => Math.max(acc, n.y + MINI_NODE_H), 0) + MINI_PAD_Y
    : 0

  // The resolved spans to render: prefer the prop (for testing / static
  // rendering), otherwise use the spans fetched from the API.
  const resolvedSpans = stepSpans !== undefined ? stepSpans : fetchedSpans

  return (
    <>
      {/* Scrim — sits at z-40 (below the drawer's z-50) so clicks outside dismiss the panel */}
      <div
        data-testid="task-detail-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 bg-fg/40"
        onClick={handleClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Task detail"
        data-testid="task-detail-drawer"
        data-state={state.kind}
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        className="drawer-panel fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-iron/40 bg-bg shadow-2xl outline-none"
      >
      <header className="flex items-center justify-between border-b border-iron/40 px-4 py-3">
        <h2 className="font-mono text-sm uppercase tracking-wide text-iron">
          Task {taskId}
        </h2>
        <button
          type="button"
          onClick={handleClose}
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
                    style={{ stroke: e.kind === 'provenance' ? DAG_EDGE_PROVENANCE : DAG_EDGE_BLOCKER }}
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
                      style={{ fill: s.fill, stroke: s.stroke }}
                      strokeWidth={1.5}
                    />
                    <text
                      x={6}
                      y={MINI_NODE_H / 2 + 4}
                      fontSize={10}
                      fontFamily="monospace"
                      style={{ fill: s.text }}
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

      {/* Step timeline — renders when spans data is available (prop or fetched) */}
      {resolvedSpans !== null ? (
        <section
          data-testid="task-step-timeline"
          className="border-b border-iron/20 px-4 py-3"
        >
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            Steps
          </h3>
          {resolvedSpans.length === 0 ? (
            <p className="font-mono text-xs text-iron">No steps recorded yet</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {resolvedSpans.map((s, i) => (
                <li
                  key={`${s.workflowInstanceId}-${s.stepName}-${i}`}
                  data-testid="step-timeline-row"
                  data-outcome={s.outcome}
                  className={`flex items-center gap-2 rounded px-2 py-1 font-mono text-xs ${
                    s.outcome === 'running'
                      ? 'bg-amber-500/10 text-amber-400'
                      : s.outcome === 'failed'
                        ? 'text-red-400'
                        : s.outcome === 'killed'
                          ? 'text-orange-400'
                          : 'text-fg'
                  }`}
                >
                  <span className="w-16 shrink-0 font-semibold">{s.stepName}</span>
                  {s.workerName != null ? (
                    <span className="shrink-0 text-muted">{s.workerName}</span>
                  ) : null}
                  <span className="shrink-0 text-muted">{outcomeLabel(s.outcome)}</span>
                  {s.durationMs != null ? (
                    <span className="ml-auto shrink-0 text-muted">
                      {formatDuration(s.durationMs)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
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
    </>
  )
}
