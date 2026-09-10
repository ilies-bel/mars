import { ChevronRight } from 'lucide-react'
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
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { chainForProposal, chainForTask, type ChainResult } from '@/shared/chainTrace'
import { isEditableTarget } from '@/shared/isEditableTarget'
import {
  encodeProgressStateAsTaskParams,
  readProgressStateFromUrl,
} from '@/shared/progressUrlState'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { taskHash } from '@/shared/routing'
import {
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

interface LegendItem {
  label: string
  color: string
  /** The node cluster this swatch stands for; null for the proposal frame. */
  cluster: Cluster | null
}

const LEGEND_ITEMS: ReadonlyArray<LegendItem> = [
  { label: 'proposal', color: PROPOSAL_STROKE, cluster: null },
  { label: 'in progress', color: CLUSTER_CSS['In progress'].dot, cluster: 'In progress' },
  { label: 'blocked', color: CLUSTER_CSS.Blocked.dot, cluster: 'Blocked' },
  { label: 'queued', color: CLUSTER_CSS.Queued.dot, cluster: 'Queued' },
  { label: 'failed', color: CLUSTER_CSS.Failed.dot, cluster: 'Failed' },
]

/**
 * The legend is a key to THIS graph, not a catalogue of states the app knows.
 *
 * All five swatches rendered unconditionally, so a snapshot containing three
 * colours advertised five — and the reader's first job became hunting the
 * canvas for a "queued" card that was not there. A key that names something
 * absent is worse than no key: it turns a complete graph into an apparently
 * incomplete one.
 */
export const visibleLegendItems = (
  clusters: ReadonlySet<Cluster>,
  hasProposal: boolean,
): ReadonlyArray<LegendItem> =>
  LEGEND_ITEMS.filter((item) =>
    item.cluster === null ? hasProposal : clusters.has(item.cluster),
  )

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
        className="line-clamp-2 font-sans text-label leading-snug"
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
  const countDisplay =
    data.totalCount > data.count
      ? `${data.count} of ${data.totalCount} active`
      : `${data.count} task${data.count === 1 ? '' : 's'}`
  return (
    <div
      className={`topo-node topo-card relative flex h-16 w-[232px] cursor-pointer flex-col justify-center gap-0.5 rounded-lg border-[1.5px] px-3 shadow-[0_2px_12px_rgba(0,0,0,0.4)] ${emphasisClass(data.emphasis)}`}
      style={{ background: style.fill, borderColor: data.isProposal ? PROPOSAL_STROKE : style.stroke }}
      aria-label={`${data.label} · ${countDisplay} · click to open`}
    >
      <FlowHandles />
      <span
        className="line-clamp-2 font-sans text-label font-semibold leading-snug"
        style={{ color: data.isProposal ? PROPOSAL_TEXT : style.text }}
      >
        {data.label}
      </span>
      <span className="font-mono text-micro" style={{ color: style.text, opacity: 0.7 }}>
        {countDisplay} · {data.dom.toLowerCase()}
      </span>
    </div>
  )
})
ArcCardNode.displayName = 'ArcCardNode'

const ArcGroupNode = memo(({ data, width, height }: NodeProps<Node<ArcGroupNodeData>>) => {
  const style = CLUSTER_CSS[data.dom]
  const countDisplay =
    data.totalCount > data.count
      ? `${data.count} of ${data.totalCount} active`
      : `${data.count} task${data.count === 1 ? '' : 's'}`
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
        className="flex items-center gap-2 truncate px-3 font-sans text-label font-semibold"
        style={{ color: data.isProposal ? PROPOSAL_TEXT : style.text, height: GROUP_HEADER_H }}
      >
        <span className="truncate">{data.label}</span>
        <span className="shrink-0 font-mono text-micro font-normal opacity-60">
          {countDisplay}
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
      background: 'var(--color-bg)',
      borderColor: 'var(--color-dag-queued-stroke)',
    }}
    aria-label={`${data.count} linked tasks · click to expand`}
  >
    <FlowHandles />
    <span className="font-mono text-label text-muted-dark">
      {data.count} linked tasks
    </span>
    <ChevronRight size={11} strokeWidth={2} aria-hidden="true" className="text-muted-dark" />
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
  const nodesInitialized = useNodesInitialized()

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
  // Tracks the current search query so toggleArc/collapse can suppress proposal
  // filter propagation while the user is searching.
  const searchQueryRef = useRef(searchQuery)
  searchQueryRef.current = searchQuery

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

  // Only the swatches this graph actually uses — see visibleLegendItems.
  const legendItems = useMemo(() => {
    const clusters = new Set<Cluster>()
    let hasProposal = false
    for (const n of emphasized.nodes) {
      const d = n.data
      if (d.kind === 'task') clusters.add(d.cluster)
      else if (d.kind === 'fanoutBundle') clusters.add('Queued')
      else {
        hasProposal = true
        clusters.add(d.dom)
      }
    }
    return visibleLegendItems(clusters, hasProposal)
  }, [emphasized.nodes])

  // Fit the viewport on structural changes, drill-in toggles, and bundle toggles.
  const fitKey = `${structSig}|${openArcKey ?? ''}|${[...expandedBundles].sort().join(',')}`
  const lastFitKeyRef = useRef<string | null>(null)
  useEffect(() => {
    // Gate on nodesInitialized so fitView runs only after React Flow has
    // measured every node in the updated graph. A bare requestAnimationFrame
    // fires too early when new nodes are added (e.g. arcGroup on drill-in) —
    // unmeasured nodes are excluded from the bounds, leaving the graph pinned
    // at its layout origin in the top-left corner of the canvas.
    if (empty || !nodesInitialized || lastFitKeyRef.current === fitKey) return
    lastFitKeyRef.current = fitKey
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    void fitView({ padding: 0.1, duration: reduced ? 0 : 240, maxZoom: 1.2 })
  }, [empty, fitKey, nodesInitialized, fitView])

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
      // When a search query is active, arc expansion/collapse only changes the
      // local drill-in state — it does NOT propagate to the proposal filter.
      // This prevents the topology from entering single-proposal mode (which
      // hides all non-proposal tasks) while the user is searching for a specific
      // task, keeping the matched task visible and the URL free of ?proposal=.
      //
      // Without a search query: propagate only when the arc key is a real
      // proposal id. Origin arcs are keyed by a task id — propagating that id
      // would set selectedProposalId to a task id, which matches no
      // parentProposalId and empties the board.
      if (!searchQueryRef.current?.trim() && (next === null || proposalIdsRef.current.has(arcKey))) {
        onSelectProposalRef.current?.(next)
      }
      clearHover()
    },
    [clearHover],
  )
  const collapse = useCallback(() => {
    if (openArcKeyRef.current !== null) {
      setOpenArcKey(null)
      // Skip proposal filter propagation while a search is active (same
      // reasoning as toggleArc: leave the proposal filter untouched so
      // the search results are not disturbed by the collapse gesture).
      if (!searchQueryRef.current?.trim()) {
        onSelectProposalRef.current?.(null)
      }
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
      // Guard against editable targets so pressing Escape inside the search
      // input (or any other text field) does not collapse the open arc.
      if (e.key === 'Escape' && !isEditableTarget(e.target)) collapse()
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


  const openArcLabel = useMemo(() => {
    if (!openArcKey) return null
    const group = baseNodes.find((n) => n.data.kind === 'arcGroup' && n.data.arcKey === openArcKey)
    return group ? String(group.data.label) : null
  }, [baseNodes, openArcKey])

  if (empty) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background">
        {selectedProposalId != null ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              className="select-none font-mono text-5xl leading-none text-muted-foreground"
              aria-hidden="true"
            >
              ◈
            </span>
            <p className="text-title font-medium text-foreground">No active tasks for this proposal</p>
            <p className="text-body text-muted-foreground">Remove the proposal filter to see all tasks</p>
            <button
              data-testid="clear-proposal-filter"
              onClick={() => onSelectProposal?.(null)}
              className="mt-1 rounded border border-border px-3 py-1.5 text-label text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
            >
              Clear filter
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              className="select-none font-mono text-5xl leading-none text-muted-foreground"
              aria-hidden="true"
            >
              ◈
            </span>
            <p className="text-title font-medium text-foreground">No active tasks</p>
          </div>
        )}
      </main>
    )
  }

  return (
    <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background" onDoubleClick={onWrapperDoubleClick}>
      {/* Canvas area. Everything that floats over the graph lives in here, so
          the status bar below can never be painted on top of a node. */}
      <div className="relative min-h-0 flex-1">
      <div
        role="img"
        className="dag-canvas absolute inset-0 h-full w-full"
        style={{ background: 'var(--color-bg)' }}
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
          {/* No minimap.
            *
            * It was an unlabelled 180x120 panel pinned bottom-right, and it
            * covered a task card outright — the same defect that moved the
            * status bar off this canvas ("covered a whole task card outright
            * — measured at 100% of that node's area"). The status bar at
            * least explained itself; the minimap was a grid of unreadable
            * dashes.
            *
            * It also had nothing to navigate. The view opens fitted, so the
            * whole graph is on screen and the minimap duplicates it at 1/8
            * scale; once a reader zooms in, drag-to-pan and the zoom controls
            * in the opposite corner already do the job. */}
        </ReactFlow>
      </div>
      {/* Zero-state search pill — shown when the active search matches nothing. */}
      {searchMatchIds != null && searchMatchIds.size === 0 && (
        <div
          data-testid="search-zero-state"
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
        >
          <span className="rounded bg-foreground/90 px-3 py-1.5 font-mono text-label text-muted-dark ring-1 ring-border-dark/60">
            {`0 tasks match '${(searchQuery ?? '').trim()}'`}
          </span>
        </div>
      )}
      {/* Breadcrumb chip — visible while an arc is drilled-in. */}
      {openArcLabel && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[260px] items-center gap-1.5 truncate rounded bg-foreground/80 px-2 py-1 font-mono text-label text-muted-dark ring-1 ring-border-dark/60">
          <span className="truncate">{openArcLabel}</span>
          <span className="shrink-0 opacity-50">· Esc to collapse</span>
        </div>
      )}
      </div>
      {/* Status bar, NOT an overlay.
       *
       * This was one backed panel floating at bottom-left of the canvas, and
       * being 420x93 it covered a whole task card outright — measured at 100%
       * of that node's area. Worse, it is pointer-events-none, so the card
       * underneath could not even be reached by dragging the panel away.
       *
       * Out of the canvas and onto its own row it cannot occlude anything, and
       * a single line reads as chrome rather than as a sticker on the graph.
       * The minimap and zoom controls keep their corners; they are controls,
       * they are small, and they sit where a graph UI is expected to put them. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-surface px-3 py-1.5">
        <div className="flex items-center gap-2.5 text-micro text-muted-foreground">
          {legendItems.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1.5">
              <i className="inline-block h-[9px] w-[9px] rounded-[2px]" style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
        {/* text-label, not text-micro: the navigation hint was pinned to 12px
            by an earlier AA-contrast fix (TopologyView.test.tsx) and that
            decision still holds — this is the one line a first-time user has
            to read to know the canvas is interactive. */}
        <span className="text-label text-muted-foreground">scroll = zoom · drag = pan</span>
        <span className="text-label text-muted-foreground">
          {hintText ? (
            <span className="font-medium text-foreground">{hintText}</span>
          ) : (
            'click card = open · click task = details · esc = collapse'
          )}
        </span>
        {emphasized.edges.length === 0 && (
          /* A dot grid of disconnected cards reads as "the graph failed to
           * draw". It has not: a recovery edge is internal to its arc's card,
           * so a snapshot where nothing blocks anything ACROSS arcs genuinely
           * has no line to draw. Say so rather than leaving it ambiguous. */
          <p className="ml-auto text-micro text-muted-foreground" data-testid="topo-no-edges">
            No dependencies between active arcs.
          </p>
        )}
      </div>
    </main>
  )
}

export const TopologyView = (props: TopologyViewProps) => (
  <ReactFlowProvider>
    <TopologyViewInner {...props} />
  </ReactFlowProvider>
)
