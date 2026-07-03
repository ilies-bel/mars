/**
 * Proposal-node drawer — right-side panel opened when a Proposal node is
 * clicked on the Progress DAG canvas.
 *
 * This is the tracer-bullet version: it renders a placeholder where the rich
 * Proposal-detail UI will eventually live, plus the local subgraph showing the
 * Proposal node and the tasks sliced from it.  Clicking a task node in the
 * subgraph navigates to `#/task/<id>`, swapping the surface to the
 * TaskDetailDrawer.
 *
 * The rich Proposal-detail content (title, status, source, sliced-tasks list,
 * CLI commands) is tracked separately as a follow-up slice.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import { dagClusterStyle, DAG_EDGE_PROVENANCE } from '@/shared/dagColors'

// ── Mini-subgraph SVG constants ───────────────────────────────────────────────
// Match TaskDetailDrawer's mini-canvas sizing so both panels feel consistent.

const MINI_NODE_W = 130
const MINI_NODE_H = 28
const MINI_LAYER_W = 160
const MINI_LAYER_H = 44
const MINI_PAD_X = 12
const MINI_PAD_Y = 12

interface PositionedNode {
  id: string
  kind: string
  cluster: string | undefined
  label: string
  x: number
  y: number
}

interface SubgraphLayout {
  nodes: PositionedNode[]
  edges: Array<{ from: string; to: string }>
}

/**
 * Builds the proposal-local subgraph: the proposal node at layer 0 plus all
 * tasks sliced from it (parentProposalId === proposalId) at layer 1.
 *
 * Tasks from other proposals are excluded.  The layout is a two-column grid —
 * proposal left, tasks stacked on the right — using the same mini-canvas
 * constants as TaskDetailDrawer.
 */
const buildSubgraph = (
  proposalId: string,
  proposals: ProgressProposalNode[],
  tasks: ProgressTask[],
): SubgraphLayout => {
  const p = proposals.find((x) => x.id === proposalId)
  const sliced = tasks.filter((t) => t.parentProposalId === proposalId)

  const nodes: PositionedNode[] = []
  const edges: Array<{ from: string; to: string }> = []

  // Proposal node — always present at layer 0.
  nodes.push({
    id: proposalId,
    kind: 'proposal',
    cluster: undefined,
    label: (p?.title ?? proposalId).slice(0, 30),
    x: MINI_PAD_X,
    y: MINI_PAD_Y + (sliced.length > 1 ? ((sliced.length - 1) * MINI_LAYER_H) / 2 : 0),
  })

  // Sliced-task nodes — layer 1, stacked vertically.
  sliced.forEach((t, i) => {
    nodes.push({
      id: t.id,
      kind: 'task',
      cluster: t.cluster as string,
      label: (t.prompt.split('\n')[0] ?? t.id).slice(0, 30),
      x: MINI_PAD_X + MINI_LAYER_W,
      y: MINI_PAD_Y + i * MINI_LAYER_H,
    })
    edges.push({ from: proposalId, to: t.id })
  })

  return { nodes, edges }
}

export interface ProposalNodeDrawerProps {
  /** Proposal id pulled from `#/proposal-node/<id>`. */
  proposalId: string
  /** All in-scope proposal nodes — used to look up the proposal's label. */
  proposals: ProgressProposalNode[]
  /** All in-scope tasks from the Progress tab — used for the subgraph. */
  tasks: ProgressTask[]
  /** Clears the `#/proposal-node/<id>` hash so the drawer closes. */
  onClose: () => void
}

export const ProposalNodeDrawer = ({
  proposalId,
  proposals,
  tasks,
  onClose,
}: ProposalNodeDrawerProps) => {
  const drawerRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  const handleClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose(), 180)
  }, [onClose])

  // On open: save previously focused element and move focus into the drawer.
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
            'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleClose])

  const subgraph = buildSubgraph(proposalId, proposals, tasks)
  const posById = new Map(subgraph.nodes.map((n) => [n.id, n]))

  const svgWidth =
    subgraph.nodes.reduce((acc, n) => Math.max(acc, n.x + MINI_NODE_W), 0) + MINI_PAD_X
  const svgHeight =
    subgraph.nodes.reduce((acc, n) => Math.max(acc, n.y + MINI_NODE_H), 0) + MINI_PAD_Y

  return (
    <>
      {/* Scrim — sits at z-40 (below the drawer's z-50) */}
      <div
        data-testid="proposal-node-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 hidden bg-fg/40 xl:block"
        onClick={handleClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Proposal detail"
        data-testid="proposal-node-drawer"
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        className="drawer-panel fixed inset-0 z-50 flex w-full flex-col border-iron/40 bg-bg outline-none xl:inset-y-0 xl:left-auto xl:right-0 xl:w-[min(560px,100vw)] xl:border-l xl:shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-iron/40 px-4 py-3">
          <h2 className="font-mono text-sm uppercase tracking-wide text-iron">
            Proposal {proposalId}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close proposal detail"
            data-testid="proposal-node-close"
            className="rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
          >
            Close
          </button>
        </header>

        {/* Placeholder — rich Proposal detail will land here in a later slice */}
        <section
          data-testid="proposal-node-placeholder"
          className="border-b border-iron/20 px-4 py-4"
        >
          <p className="font-mono text-[12px] text-muted">
            Proposal detail coming soon — full proposal information will appear here.
          </p>
        </section>

        {/* Local subgraph: proposal node + sliced tasks */}
        <section
          data-testid="proposal-node-subgraph"
          className="border-b border-iron/20 px-4 py-3"
        >
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            Sliced tasks
          </h3>
          <div className="overflow-x-auto">
            <svg
              width={svgWidth}
              height={svgHeight}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              aria-label="Proposal sliced-tasks subgraph"
            >
              {/* Provenance edges — rendered first so nodes appear on top */}
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
                    key={`${e.from}::${e.to}`}
                    d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                    data-edge-kind="provenance"
                    fill="none"
                    style={{ stroke: DAG_EDGE_PROVENANCE }}
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                  />
                )
              })}

              {/* Nodes */}
              {subgraph.nodes.map((node) => {
                const s = dagClusterStyle(node.kind, node.cluster)
                const g = (
                  <g
                    data-node-id={node.id}
                    data-node-kind={node.kind}
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

                // Task nodes in the subgraph are clickable — clicking swaps the
                // drawer to the TaskDetailDrawer for that task.
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

                // The proposal node itself is not a navigation target.
                return <g key={node.id}>{g}</g>
              })}
            </svg>
          </div>
        </section>
      </aside>
    </>
  )
}
