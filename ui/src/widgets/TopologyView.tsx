/**
 * Topology view — React Flow (@xyflow/react) + deterministic dagre layout.
 *
 * STRUCTURE
 * ---------
 *  - Pure model (`topologyFlowModel.ts`) builds nodes/edges + positions; this
 *    file owns React Flow wiring, interaction state, and the overlay chrome.
 *  - One collapsed arc CARD per multi-task arc; single-task arcs are bare task
 *    nodes. Deterministic layout: dagre LR per connected component,
 *    shelf-packed components (same data → same picture, unlike the old
 *    d3-force cloud).
 *  - Single-open drill-in: at most ONE arc expanded (a group node with
 *    parentId/extent:'parent' children). Double-click toggles; Escape or
 *    pane-double-click collapses.
 *  - Hover-to-trace: hover a card → proposal chain; hover a task → full
 *    lineage (`chainTrace.ts`). Everything not lit dims. ~100 ms hover-intent
 *    debounce; reduced-motion → instant.
 *  - Dim sources combine in the pure `computeEmphasisMap`: search
 *    (`searchMatchIds`) + hover-trace. A node stays bright only if it passes
 *    the search filter AND (no hover active OR it's hover-lit).
 *
 * NAVIGATION / CLICK MODEL (kept from the G6 view)
 * ------------------------------------------------
 *  - single-click a card      → drill in (and call onSelectProposal);
 *    double-click the open group → drill out.
 *  - double-click the pane    → collapse the open arc.
 *  - single-click a TASK node → open the task drawer (`#/task/<id>`).
 *  - Escape                   → collapse.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { chainForProposal, chainForTask, type ChainResult } from '@/shared/chainTrace'
import {
  encodeProgressStateAsTaskParams,
  readProgressStateFromUrl,
} from '@/shared/progressUrlState'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { taskHash } from '@/shared/routing'
import {
  buildClusterStyleFromVars,
  buildTopology,
  BUNDLE_H,
  BUNDLE_W,
  CLUSTER_CSS,
  computeEmphasisMap,
  dataSignature,
  GROUP_HEADER_H,
  PROPOSAL_STROKE,
  PROPOSAL_TEXT,
  structuralSignature,
  type ArcCardNodeData,
  type ArcGroupNodeData,
  type Emphasis,
  type FanoutBundleNodeData,
  type TaskNodeData,
  type TopoEdge,
  type TopoNode,
} from './topologyFlowModel'
import type { Cluster } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Props (contract kept stable for ProgressPage)
// ---------------------------------------------------------------------------

export interface TopologyViewProps {
  tasks: ProgressTask[]
  proposals: ProgressProposalNode[]
  /** Toolbar proposal dropdown. Non-null → drill into that proposal. */
  selectedProposalId?: string | null
  /** Toolbar search; null = no search. Only these ids stay full-opacity. */
  searchMatchIds?: Set<string> | null
  /** Raw query string, displayed in the zero-state pill. */
  searchQuery?: string
  /** Reports drill-in changes back up: arc key on open, null on collapse. */
  onSelectProposal?: (id: string | null) => void
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const LEGEND_ITEMS: ReadonlyArray<{ label: string; color: string }> = [
  { label: 'proposal', color: PROPOSAL_STROKE },
  { label: 'in progress', color: CLUSTER_CSS['In progress'].dot },
  { label: 'blocked', color: CLUSTER_CSS.Blocked.dot },
  { label: 'queued', color: CLUSTER_CSS.Queued.dot },
  { label: 'failed', color: CLUSTER_CSS.Failed.dot },
]

// ---------------------------------------------------------------------------
// Custom nodes
// ---------------------------------------------------------------------------

const emphasisClass = (e: Emphasis): string =>
  e === 'dim' ? 'topo-dim' : e === 'lit' ? 'topo-lit' : ''

/** Invisible LR handles — edges attach left/right to match the dagre rankdir. */
const FlowHandles = () => (
  <>
    <Handle type="target" position={Position.Left} className="pointer-events-none opacity-0" />
    <Handle type="source" position={Position.Right} className="pointer-events-none opacity-0" />
  </>
)

const TaskNode = memo(({ data }: NodeProps<Node<TaskNodeData>>) => {
  const style = CLUSTER_CSS[data.cluster]
  return (
    <div
      className={`topo-node relative flex h-12 w-[200px] items-center rounded-md border px-2.5 ${emphasisClass(data.emphasis)} ${
        data.cluster === 'In progress' ? 'topo-pulse' : ''
      }`}
      style={{ background: style.fill, borderColor: style.stroke }}
      aria-label={`${data.label} · ${data.cluster.toLowerCase()}`}
    >
      <FlowHandles />
      <span
        className="line-clamp-2 font-sans text-[10.5px] leading-tight"
        style={{ color: style.text }}
      >
        {data.label}
      </span>
    </div>
  )
})
TaskNode.displayName = 'TaskNode'

const ArcCardNode = memo(({ data }: NodeProps<Node<ArcCardNodeData>>) => {
  const style = CLUSTER_CSS[data.dom]
  return (
    <div
      className={`topo-node topo-card relative flex h-16 w-[232px] cursor-pointer flex-col justify-center gap-0.5 rounded-lg border-[1.5px] px-3 shadow-[0_2px_12px_rgba(0,0,0,0.4)] ${emphasisClass(data.emphasis)}`}
      style={{ background: style.fill, borderColor: data.isProposal ? PROPOSAL_STROKE : style.stroke }}
      aria-label={`${data.label} · ${data.count} tasks · click to open`}
    >
      <FlowHandles />
      <span
        className="line-clamp-2 font-sans text-[11px] font-semibold leading-tight"
        style={{ color: data.isProposal ? PROPOSAL_TEXT : style.text }}
      >
        {data.label}
      </span>
      <span className="font-mono text-[9.5px]" style={{ color: style.text, opacity: 0.7 }}>
        {data.count} task{data.count === 1 ? '' : 's'} · {data.dom.toLowerCase()}
      </span>
    </div>
  )
})
ArcCardNode.displayName = 'ArcCardNode'

const ArcGroupNode = memo(({ data, width, height }: NodeProps<Node<ArcGroupNodeData>>) => {
  const style = CLUSTER_CSS[data.dom]
  return (
    <div
      className={`topo-node relative rounded-xl border-[1.5px] ${emphasisClass(data.emphasis)}`}
      style={{
        width,
        height,
        background: 'color-mix(in srgb, ' + `var(--color-dag-${data.dom === 'In progress' ? 'in-progress' : data.dom.toLowerCase()}-fill)` + ' 35%, transparent)',
        borderColor: data.isProposal ? PROPOSAL_STROKE : style.stroke,
      }}
      aria-label={`${data.label} · expanded · Esc to collapse`}
    >
      <FlowHandles />
      <div
        className="flex items-center gap-2 truncate px-3 font-sans text-[11px] font-semibold"
        style={{ color: data.isProposal ? PROPOSAL_TEXT : style.text, height: GROUP_HEADER_H }}
      >
        <span className="truncate">{data.label}</span>
        <span className="shrink-0 font-mono text-[9.5px] font-normal opacity-60">
          {data.count} task{data.count === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  )
})
ArcGroupNode.displayName = 'ArcGroupNode'

const FanoutBundleNode = memo(({ data }: NodeProps<Node<FanoutBundleNodeData>>) => (
  <div
    className={`topo-node relative flex cursor-pointer items-center justify-between rounded-full border border-dashed px-3 ${emphasisClass(data.emphasis)}`}
    style={{
      width: BUNDLE_W,
      height: BUNDLE_H,
      background: 'var(--color-surface-dark)',
      borderColor: 'var(--color-dag-queued-stroke)',
    }}
    aria-label={`${data.count} linked tasks · click to expand`}
  >
    <FlowHandles />
    <span className="font-mono text-[10.5px] text-muted-dark">
      {data.count} linked tasks
    </span>
    <span className="text-[10px] text-muted-dark opacity-60">▸</span>
  </div>
))
FanoutBundleNode.displayName = 'FanoutBundleNode'

const NODE_TYPES: NodeTypes = {
  task: TaskNode,
  arcCard: ArcCardNode,
  arcGroup: ArcGroupNode,
  fanoutBundle: FanoutBundleNode,
}

// ---------------------------------------------------------------------------
// Edge styling
// ---------------------------------------------------------------------------

const EDGE_REST = 'var(--color-dag-edge-blocker)'
const EDGE_LIT = 'var(--color-dag-proposal-text)'

const edgeStyle = (kind: 'blocker' | 'recovery', emphasis: Emphasis): CSSProperties => ({
  stroke: emphasis === 'lit' ? EDGE_LIT : EDGE_REST,
  strokeWidth: emphasis === 'lit' ? 2.25 : 1.25,
  strokeDasharray: kind === 'recovery' ? '4 3' : undefined,
  opacity: emphasis === 'dim' ? 0.06 : emphasis === 'lit' ? 1 : 0.55,
  transition: 'opacity 160ms ease-out, stroke 160ms ease-out',
})

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TopologyViewInner = ({
  tasks,
  proposals,
  selectedProposalId,
  searchMatchIds,
  searchQuery,
  onSelectProposal,
}: TopologyViewProps) => {
  const { fitView } = useReactFlow()

  const [openArcKey, setOpenArcKey] = useState<string | null>(null)
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(new Set())
  const [lit, setLit] = useState<ChainResult | null>(null)
  const [hintText, setHintText] = useState<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onSelectProposalRef = useRef(onSelectProposal)
  onSelectProposalRef.current = onSelectProposal
  // Tracks the externally-driven selectedProposalId so we only react to
  // changes and don't echo our own onSelectProposal callbacks into a drill-in.
  const lastSelectedRef = useRef<string | null | undefined>(undefined)

  // Set of proposal ids — used to gate onSelectProposal calls in toggleArc so
  // that clicking an origin arc card (whose key is a task id, not a proposal id)
  // never pollutes the proposal filter and blanks the board.
  const proposalIds = useMemo(() => new Set(proposals.map((p) => p.id)), [proposals])
  const proposalIdsRef = useRef(proposalIds)
  proposalIdsRef.current = proposalIds

  // Filter to the selected proposal when one is active.
  // Trade-off: tasks with a null parentProposalId disappear while a proposal is
  // selected — this matches BoardView's semantics exactly (same control, same meaning).
  // Recovery/fix tasks that inherit the parent proposal via parentProposalId stay visible.
  const visibleTasks = useMemo(
    () =>
      selectedProposalId == null
        ? tasks
        : tasks.filter((t) => t.parentProposalId === selectedProposalId),
    [tasks, selectedProposalId],
  )
  const visibleProposals = useMemo(
    () =>
      selectedProposalId == null
        ? proposals
        : proposals.filter((p) => p.id === selectedProposalId),
    [proposals, selectedProposalId],
  )

  const empty = visibleTasks.length === 0

  const dataSig = useMemo(() => dataSignature(visibleTasks, visibleProposals), [visibleTasks, visibleProposals])
  const structSig = useMemo(() => structuralSignature(visibleTasks, visibleProposals), [visibleTasks, visibleProposals])

  // Deterministic rebuild: cluster flips rebuild colours but keep positions,
  // so the camera never jumps except on true structural change (fitView gate).
  const { nodes: baseNodes, edges: baseEdges } = useMemo(
    () => buildTopology(visibleTasks, visibleProposals, openArcKey, expandedBundles),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataSig covers visibleTasks/visibleProposals
    [dataSig, openArcKey, expandedBundles],
  )

  // Drop drill-in state if the open arc disappeared from the data.
  useEffect(() => {
    if (openArcKey && !baseNodes.some((n) => n.data.arcKey === openArcKey && n.data.kind !== 'task')) {
      setOpenArcKey(null)
    }
  }, [baseNodes, openArcKey])

  const emphasized = useMemo(() => {
    const map = computeEmphasisMap(baseNodes, baseEdges, { searchMatchIds, lit })
    const nodes: TopoNode[] = baseNodes.map((n) => ({
      ...n,
      data: { ...n.data, emphasis: map.get(n.id) ?? 'rest' } as TopoNode['data'],
    }))
    const edges: TopoEdge[] = baseEdges.map((e) => {
      const emphasis = map.get(e.id) ?? 'rest'
      return {
        ...e,
        data: { ...e.data!, emphasis },
        style: edgeStyle(e.data!.kind, emphasis),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: emphasis === 'lit' ? 'var(--color-dag-proposal-text)' : 'var(--color-dag-edge-blocker)',
        },
        zIndex: emphasis === 'lit' ? 1 : 0,
      }
    })
    return { nodes, edges }
  }, [baseNodes, baseEdges, searchMatchIds, lit])

  // Fit the viewport on structural changes, drill-in toggles, and bundle toggles.
  const fitKey = `${structSig}|${openArcKey ?? ''}|${[...expandedBundles].sort().join(',')}`
  const lastFitKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (empty || lastFitKeyRef.current === fitKey) return
    lastFitKeyRef.current = fitKey
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // rAF: let React Flow measure the fresh nodes before fitting.
    const raf = requestAnimationFrame(() => {
      void fitView({ padding: 0.1, duration: reduced ? 0 : 240, maxZoom: 1.2 })
    })
    return () => cancelAnimationFrame(raf)
  }, [empty, fitKey, fitView])

  // ---- hover-to-trace -------------------------------------------------------
  const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const schedule = useCallback((fn: () => void): void => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = setTimeout(fn, reduced() ? 0 : 100)
  }, [])
  const clearHover = useCallback((): void => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    setLit(null)
    setHintText(null)
  }, [])
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
  }, [])

  const tasksRef = useRef(visibleTasks)
  tasksRef.current = visibleTasks

  const onNodeMouseEnter = useCallback(
    (_: ReactMouseEvent, node: TopoNode) => {
      if (node.data.kind === 'task') {
        schedule(() => setLit(chainForTask({ tasks: tasksRef.current }, node.id)))
        return
      }
      if (node.data.kind === 'arcCard') {
        setHintText('click to open')
        const arcKey = node.data.arcKey
        schedule(() => {
          const chain = chainForProposal({ tasks: tasksRef.current }, arcKey)
          if (chain.nodes.size > 0) {
            setLit(chain)
            return
          }
          // Origin arc (no proposal): light the member tasks' full lineages.
          const union: ChainResult = { nodes: new Set(), edges: new Set(), proposals: new Set([arcKey]) }
          for (const t of tasksRef.current) {
            if ((t.parentProposalId ?? t.originId ?? t.id) !== arcKey) continue
            const c = chainForTask({ tasks: tasksRef.current }, t.id)
            for (const n of c.nodes) union.nodes.add(n)
            for (const e of c.edges) union.edges.add(e)
            for (const p of c.proposals) union.proposals.add(p)
          }
          setLit(union)
        })
      }
    },
    [schedule],
  )

  // ---- drill-in --------------------------------------------------------------
  const openArcKeyRef = useRef(openArcKey)
  openArcKeyRef.current = openArcKey
  const toggleArc = useCallback(
    (arcKey: string) => {
      const next = openArcKeyRef.current === arcKey ? null : arcKey
      setOpenArcKey(next)
      // Only propagate to the proposal filter when the arc key really is a
      // proposal id. Origin arcs are keyed by a task id — propagating that id
      // would set selectedProposalId to a task id, which matches no
      // parentProposalId and empties the board. Collapsing (next === null)
      // always propagates so the proposal dropdown resets correctly.
      if (next === null || proposalIdsRef.current.has(next)) {
        onSelectProposalRef.current?.(next)
      }
      clearHover()
    },
    [clearHover],
  )
  const collapse = useCallback(() => {
    if (openArcKeyRef.current !== null) {
      setOpenArcKey(null)
      onSelectProposalRef.current?.(null)
    }
    clearHover()
  }, [clearHover])

  const onNodeClick = useCallback(
    (_: ReactMouseEvent, node: TopoNode) => {
      if (node.data.kind === 'task') {
        const progressState = readProgressStateFromUrl()
        const progressParams = encodeProgressStateAsTaskParams(progressState)
        window.location.hash = taskHash(node.id, 'progress') + progressParams
      } else if (node.data.kind === 'arcCard') {
        toggleArc(node.data.arcKey)
      } else if (node.data.kind === 'fanoutBundle') {
        const key = node.data.bundleKey
        setExpandedBundles((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }
    },
    [toggleArc],
  )

  // Single-click opens a card; double-click still toggles an open group shut.
  const onNodeDoubleClick = useCallback(
    (_: ReactMouseEvent, node: TopoNode) => {
      if (node.data.kind === 'arcGroup') toggleArc(node.data.arcKey)
    },
    [toggleArc],
  )

  // Pane double-click collapses (React Flow has no onPaneDoubleClick; detect
  // pane targets on the wrapper).
  const onWrapperDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      const target = e.target as HTMLElement
      // Nodes live inside the pane — only genuine empty-canvas double-clicks collapse.
      if (target.closest('.react-flow__node')) return
      if (target.closest('.react-flow__pane')) collapse()
    },
    [collapse],
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') collapse()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [collapse])

  // Drive drill-in from the external selectedProposalId control.
  useEffect(() => {
    if (lastSelectedRef.current === selectedProposalId) return
    lastSelectedRef.current = selectedProposalId
    const target = selectedProposalId ?? null
    setOpenArcKey((open) => (open === target ? open : target))
  }, [selectedProposalId])

  // MiniMap renders SVG through JS callbacks — resolve CSS vars to concrete
  // colours at call time (SVG fill cannot consume `var()` from here).
  const minimapNodeColor = useCallback((node: Node): string => {
    const styles = buildClusterStyleFromVars((name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name),
    )
    const data = node.data as TopoNode['data']
    const cluster: Cluster =
      data.kind === 'task'
        ? data.cluster
        : data.kind === 'fanoutBundle'
          ? 'Queued'
          : data.dom
    return styles[cluster]?.stroke || 'var(--color-dag-queued-stroke)'
  }, [])

  const openArcLabel = useMemo(() => {
    if (!openArcKey) return null
    const group = baseNodes.find((n) => n.data.kind === 'arcGroup' && n.data.arcKey === openArcKey)
    return group ? String(group.data.label) : null
  }, [baseNodes, openArcKey])

  if (empty) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background">
        <p className="font-mono text-[13px] text-primary">No active tasks</p>
      </main>
    )
  }

  return (
    <main className="relative flex min-h-0 flex-1 overflow-hidden bg-background" onDoubleClick={onWrapperDoubleClick}>
      <div
        role="img"
        className="dag-canvas absolute inset-0 h-full w-full"
        style={{ background: 'var(--color-surface-dark)' }}
        aria-label={`Task topology graph, ${visibleTasks.length} task${visibleTasks.length === 1 ? '' : 's'}. Use the Board tab for a screen-reader and keyboard accessible view.`}
      >
        <ReactFlow
          nodes={emphasized.nodes}
          edges={emphasized.edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.1, maxZoom: 1.2 }}
          minZoom={0.05}
          maxZoom={2}
          onlyRenderVisibleElements
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={clearHover}
          onPaneClick={clearHover}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--color-border-dark)" />
          <Controls showInteractive={false} position="bottom-left" className="topo-controls" />
          <MiniMap
            pannable
            zoomable
            nodeColor={minimapNodeColor}
            nodeStrokeWidth={3}
            position="bottom-right"
            className="topo-minimap"
            style={{ width: 180, height: 120 }}
          />
        </ReactFlow>
      </div>
      {/* Zero-state search pill — shown when the active search matches nothing. */}
      {searchMatchIds != null && searchMatchIds.size === 0 && (
        <div
          data-testid="search-zero-state"
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
        >
          <span className="rounded bg-foreground/90 px-3 py-1.5 font-mono text-[11px] text-muted-dark ring-1 ring-border-dark/60">
            {`0 tasks match '${(searchQuery ?? '').trim()}'`}
          </span>
        </div>
      )}
      {/* Breadcrumb chip — visible while an arc is drilled-in. */}
      {openArcLabel && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[260px] items-center gap-1.5 truncate rounded bg-foreground/80 px-2 py-1 font-mono text-[10.5px] text-muted-dark ring-1 ring-border-dark/60">
          <span className="truncate">{openArcLabel}</span>
          <span className="shrink-0 opacity-50">· Esc to collapse</span>
        </div>
      )}
      {/* Navigation hint — quiet, top-left under the breadcrumb spot when free. */}
      <div className="pointer-events-none absolute bottom-10 right-3 z-10 text-right font-mono text-[11px] leading-relaxed text-muted-foreground">
        scroll = zoom · drag = pan
        <br />
        {hintText ? (
          <span className="font-semibold">{hintText}</span>
        ) : (
          'click card = open · click task = details · esc = collapse'
        )}
      </div>
      {/* Status legend — bottom, over the canvas */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-end gap-3 px-4 py-2 font-mono text-[11px] text-muted-dark">
        {LEGEND_ITEMS.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-[9px] w-[9px] rounded-[2px]" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </main>
  )
}

export const TopologyView = (props: TopologyViewProps) => (
  <ReactFlowProvider>
    <TopologyViewInner {...props} />
  </ReactFlowProvider>
)
