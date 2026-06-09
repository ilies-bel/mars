/**
 * Topology view — @antv/g6 force-clustered Cloud + drill-in Subgraph.
 *
 * Ported from the DevTools-validated prototype (/tmp/mars-graph-proto/app.js).
 * The prototype is vanilla JS; this is the Reactified production port.
 *
 * STRUCTURE
 * ---------
 *  - One G6 `Graph` mounted into a ref'd <div>, constructed once on mount and
 *    destroyed on unmount (NOT recreated per render).
 *  - Cloud overview: `combo-combined` layout (d3-force outer, antv-dagre inner
 *    LR), one COLLAPSED combo per proposal, title + plurality-status tint.
 *  - Hover-to-trace: hover a collapsed combo → `chainForProposal` forest; hover
 *    a visible task node (combo expanded) → `chainForTask` lineage. Everything
 *    not lit dims. ~100ms hover-intent debounce; reduced-motion → instant.
 *  - Single-open drill-in: at most ONE combo open. Double-click toggles;
 *    Escape / canvas-dblclick / the Collapse button closes. Anchored expand +
 *    push-outward + restore, ported faithfully (the load-bearing part).
 *  - Dim sources combine: search (`searchMatchIds`) + hover-trace. A node stays
 *    bright only if it passes the search filter AND (no hover active OR it's
 *    hover-lit). One `computeStateMap` function resolves the per-element state,
 *    applied in ONE batched `setElementState` call.
 *
 * NAVIGATION / CLICK MODEL (documented choice)
 * --------------------------------------------
 *  - double-click a combo  → drill in / out (and call onSelectProposal).
 *  - double-click canvas   → collapse the open combo.
 *  - single-click a TASK node (visible only when its combo is expanded) →
 *    open the task drawer via `window.location.hash = '#/task/<id>'`.
 *  We deliberately do NOT navigate on a single combo click: single-click and
 *  double-click on a combo would conflict, and drill-in is the combo's job.
 *  (G6 has no SVG <a>, so links become hash navigation.)
 *
 * G6 v5.1.1 gotchas honoured (see prototype HANDOFF): setLayout() returns void;
 * collapsed combos move only via translateElementTo; we own the toggle (no
 * native collapse-expand) and write child targets before expanding; expanded
 * combo rect has pointerEvents:'none'; we POLL the real collapsed state; expand/
 * collapse run with animation OFF.
 */

import { useEffect, useRef } from 'react'
import { Graph, type ComboData, type EdgeData, type IPointerEvent, type NodeData } from '@antv/g6'
import { chainForProposal, chainForTask, type ChainResult } from '@/shared/chainTrace'
import type { ProgressProposalNode, ProgressTask } from '@/shared/schemas'
import {
  ACTIVE_ACCENT,
  buildG6Data,
  CANVAS_SURFACE,
  CLUSTER_STYLE,
  computeStateMap,
  dataSignature,
  EDGE_BLOCK,
  PROPOSAL_STROKE,
  PROPOSAL_TEXT,
  arcKeyFromComboId,
  pulseOpacity,
} from './topologyGraphModel'
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
  /**
   * Reports drill-in changes back up: the proposal id when a combo opens, null
   * when it collapses. Optional so tests / other callers don't break.
   */
  onSelectProposal?: (id: string | null) => void
}

// ---------------------------------------------------------------------------
// Legend (React chrome — uses theme token classes + JS hex swatches)
// ---------------------------------------------------------------------------

const LEGEND_ITEMS: ReadonlyArray<{ label: string; color: string }> = [
  { label: 'proposal', color: PROPOSAL_STROKE },
  { label: 'in progress', color: CLUSTER_STYLE['In progress'].dot },
  { label: 'blocked', color: CLUSTER_STYLE.Blocked.dot },
  { label: 'queued', color: CLUSTER_STYLE.Queued.dot },
  { label: 'failed', color: CLUSTER_STYLE.Failed.dot },
]

const clusterStyle = (c: unknown): (typeof CLUSTER_STYLE)[Cluster] =>
  CLUSTER_STYLE[c as Cluster] ?? CLUSTER_STYLE.Queued

const comboFill = (dom: unknown): string => clusterStyle(dom).combo

const isBenignBounds = (s: unknown): boolean => typeof s === 'string' && s.includes('getLocalBounds')

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TopologyView = ({
  tasks,
  proposals,
  selectedProposalId,
  searchMatchIds,
  onSelectProposal,
}: TopologyViewProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<Graph | null>(null)

  // Live mutable state shared by the imperative G6 handlers. Kept in refs so
  // they survive re-renders without recreating the graph.
  const litRef = useRef<ChainResult | null>(null)
  const openComboIdRef = useRef<string | null>(null)
  const cloudHomeRef = useRef<Map<string, [number, number]>>(new Map())
  const nudgeHomeRef = useRef<Map<string, [number, number]>>(new Map())
  const animGenRef = useRef(0)
  const pulseGenRef = useRef(0)
  const busyRef = useRef(false)
  const pendingSwapRef = useRef<string | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest props the imperative handlers read (avoids stale closures).
  const propsRef = useRef({ tasks, searchMatchIds })
  propsRef.current = { tasks, searchMatchIds }
  const onSelectProposalRef = useRef(onSelectProposal)
  onSelectProposalRef.current = onSelectProposal
  // Tracks the externally-driven selectedProposalId so we only react to changes
  // and don't echo our own onSelectProposal callbacks back into a drill-in.
  const lastSelectedRef = useRef<string | null | undefined>(undefined)
  const lastSignatureRef = useRef<string>('')

  const empty = tasks.length === 0

  useEffect(() => {
    if (empty || !containerRef.current) return
    const container = containerRef.current

    const reduced = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // DEFENSIVE NET — swallow ONLY the benign async getLocalBounds throw G6 can
    // emit from combo teardown. Scoped to this mount; removed on cleanup.
    const onWindowError = (ev: ErrorEvent): boolean | void => {
      if (isBenignBounds(ev.message) || isBenignBounds(ev.error?.message)) {
        ev.preventDefault()
        ev.stopImmediatePropagation()
        return true
      }
    }
    const onRejection = (ev: PromiseRejectionEvent): boolean | void => {
      if (isBenignBounds((ev.reason as { message?: unknown } | undefined)?.message)) {
        ev.preventDefault()
        return true
      }
    }
    window.addEventListener('error', onWindowError, true)
    window.addEventListener('unhandledrejection', onRejection)

    const { nodes, edges, combos } = buildG6Data(propsRef.current.tasks, proposals)
    lastSignatureRef.current = dataSignature(propsRef.current.tasks, proposals)

    const graph = new Graph({
      container,
      autoResize: true,
      // generous viewport padding so the cloud breathes inside the canvas;
      // fitView() (below) reads this graph-level padding.
      padding: [48, 64, 48, 64],
      animation: { duration: 160, easing: 'ease-out' },
      background: CANVAS_SURFACE,
      data: { nodes, edges, combos },
      node: {
        type: 'rect',
        style: {
          size: [148, 32],
          radius: 6,
          fill: (d: NodeData) => clusterStyle(d.data?.cluster).fill,
          stroke: (d: NodeData) => clusterStyle(d.data?.cluster).stroke,
          lineWidth: 1.25,
          labelText: (d: NodeData) => String(d.data?.label ?? ''),
          labelFill: (d: NodeData) => clusterStyle(d.data?.cluster).text,
          labelFontSize: 10,
          labelFontFamily: 'Inter, sans-serif',
          labelPlacement: 'center',
          labelMaxWidth: 138,
          labelWordWrap: true,
        },
        state: {
          active: { lineWidth: 2.5, shadowColor: 'rgba(167,139,250,0.5)', shadowBlur: 8 },
          dim: { fillOpacity: 0.14, strokeOpacity: 0.14, labelFillOpacity: 0.14 },
        },
      },
      edge: {
        type: 'cubic-horizontal',
        style: { stroke: EDGE_BLOCK, lineWidth: 1, endArrow: true, endArrowSize: 5, opacity: 0.55 },
        state: {
          active: { stroke: ACTIVE_ACCENT, lineWidth: 2.25, opacity: 1, endArrowSize: 6 },
          dim: { opacity: 0.05 },
        },
      },
      combo: {
        type: 'rect',
        style: {
          fill: (d: ComboData) => comboFill(d.data?.dom),
          fillOpacity: (d: ComboData) => (d.style?.collapsed === false ? 0.35 : 1),
          stroke: (d: ComboData) => clusterStyle(d.data?.dom).stroke,
          strokeOpacity: 1,
          pointerEvents: (d: ComboData) => (d.style?.collapsed === false ? 'none' : 'auto'),
          lineWidth: 1.5,
          radius: 10,
          shadowColor: 'rgba(0,0,0,0.4)',
          shadowBlur: (d: ComboData) => (d.style?.collapsed === false ? 0 : 12),
          shadowOffsetY: 2,
          labelText: (d: ComboData) => String(d.data?.label ?? ''),
          labelFill: PROPOSAL_TEXT,
          labelFontSize: 11,
          labelFontWeight: 600,
          labelFontFamily: 'Inter, sans-serif',
          labelPlacement: (d: ComboData) => (d.style?.collapsed === false ? 'top' : 'center'),
          labelMaxWidth: 150,
          labelMaxLines: 2,
          labelWordWrap: true,
          padding: 24,
          collapsedSize: [168, 46],
          collapsedFill: (d: ComboData) => comboFill(d.data?.dom),
          collapsedMarker: false,
        },
        state: {
          active: { lineWidth: 3, stroke: ACTIVE_ACCENT, shadowColor: 'rgba(167,139,250,0.5)', shadowBlur: 12 },
          dim: { fillOpacity: 0.18, strokeOpacity: 0.2, labelFillOpacity: 0.22 },
        },
      },
      layout: {
        type: 'combo-combined',
        comboPadding: 22,
        spacing: 80,
        outerLayout: {
          type: 'd3-force',
          link: { distance: 320, strength: 0.04 },
          manyBody: { strength: -2000 },
          collide: { radius: 132, strength: 1, iterations: 6 },
          center: { strength: 0.05 },
          forceX: { strength: 0.008 },
          forceY: { strength: 0.03 },
          alphaDecay: 0.012,
        },
        innerLayout: { type: 'antv-dagre', rankdir: 'LR', nodesep: 12, ranksep: 40, ranker: 'network-simplex' },
      },
      // Read-only viewer: pan + zoom only. We own the toggle (no native
      // collapse-expand) so we control the reveal order — see expandAnchored.
      behaviors: ['drag-canvas', 'zoom-canvas'],
    })
    graphRef.current = graph

    // ---- highlight: one batched setElementState per change ----------------
    // All dim/active resolution lives in the pure `computeStateMap` (model
    // module); here we just feed it the live element snapshot + current inputs.
    const applyHighlight = (): void => {
      const { searchMatchIds: search } = propsRef.current
      const map = computeStateMap(
        { nodes: graph.getNodeData(), edges: graph.getEdgeData(), combos: graph.getComboData() },
        { searchMatchIds: search, lit: litRef.current },
      )
      void graph.setElementState(map)
    }

    // ---- debounced hover --------------------------------------------------
    const hoverDelay = (): number => (reduced() ? 0 : 100)
    const schedule = (fn: () => void): void => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = setTimeout(fn, hoverDelay())
    }
    const hoverTask = (taskId: string): void => {
      litRef.current = chainForTask({ tasks: propsRef.current.tasks }, taskId)
      applyHighlight()
    }
    const hoverProposal = (comboId: string): void => {
      litRef.current = chainForProposal({ tasks: propsRef.current.tasks }, arcKeyFromComboId(comboId))
      applyHighlight()
    }
    const clearHover = (): void => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      litRef.current = null
      applyHighlight()
    }

    // ---- anchored expand / collapse / push-outward ------------------------
    const cloudHome = cloudHomeRef.current
    const nudgeHome = nudgeHomeRef.current
    const setHome = (id: string, x: number, y: number): void => {
      cloudHome.set(id, [x, y])
    }

    // Deterministic LR layered layout over a small subgraph. Longest-path rank
    // + barycentre sweeps. Returns id -> {x,y} centred on (0,0).
    const layeredPositions = (
      nodeIds: string[],
      innerEdges: EdgeData[],
    ): Map<string, { x: number; y: number }> => {
      const idset = new Set(nodeIds)
      const succ = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
      const pred = new Map<string, string[]>(nodeIds.map((id) => [id, []]))
      const indeg = new Map<string, number>(nodeIds.map((id) => [id, 0]))
      for (const e of innerEdges) {
        const s = String(e.source)
        const t = String(e.target)
        if (!idset.has(s) || !idset.has(t)) continue
        succ.get(s)!.push(t)
        pred.get(t)!.push(s)
        indeg.set(t, indeg.get(t)! + 1)
      }
      const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]))
      const queue = nodeIds.filter((id) => indeg.get(id) === 0)
      const seen = new Set<string>(queue)
      while (queue.length) {
        const cur = queue.shift() as string
        for (const nx of succ.get(cur)!) {
          if (rank.get(nx)! < rank.get(cur)! + 1) rank.set(nx, rank.get(cur)! + 1)
          if (!seen.has(nx)) {
            seen.add(nx)
            queue.push(nx)
          }
        }
      }
      const byRank = new Map<number, string[]>()
      for (const id of nodeIds) {
        const r = rank.get(id)!
        if (!byRank.has(r)) byRank.set(r, [])
        byRank.get(r)!.push(id)
      }
      const rankKeys = [...byRank.keys()].sort((a, b) => a - b)
      const order = new Map<string, number>()
      for (const r of rankKeys) byRank.get(r)!.forEach((id, i) => order.set(id, i))
      const bary = (id: string, neighbours: Map<string, string[]>): number => {
        const ns = neighbours.get(id)!
        if (!ns.length) return order.get(id)!
        return ns.reduce((s, n) => s + order.get(n)!, 0) / ns.length
      }
      for (let sweep = 0; sweep < 6; sweep++) {
        const forward = sweep % 2 === 0
        const seq = forward ? rankKeys.slice(1) : rankKeys.slice(0, -1).reverse()
        for (const r of seq) {
          const ids = byRank.get(r)!
          const ref = forward ? pred : succ
          ids.sort((a, b) => bary(a, ref) - bary(b, ref))
          ids.forEach((id, i) => order.set(id, i))
        }
      }
      const COL = 200
      const ROW = 56
      const pos = new Map<string, { x: number; y: number }>()
      rankKeys.forEach((r, ci) => {
        const ids = byRank.get(r)!
        const y0 = -((ids.length - 1) * ROW) / 2
        ids.forEach((id, i) => pos.set(id, { x: ci * COL, y: y0 + i * ROW }))
      })
      const ranks = rankKeys.length
      const offX = -((ranks - 1) * COL) / 2
      const out = new Map<string, { x: number; y: number }>()
      for (const [id, p] of pos) out.set(id, { x: p.x + offX, y: p.y })
      return out
    }

    const nextFrame = (): Promise<void> =>
      new Promise((res) => {
        let done = false
        const fin = (): void => {
          if (!done) {
            done = true
            res()
          }
        }
        requestAnimationFrame(fin)
        setTimeout(fin, 100)
      })

    interface Box {
      w: number
      h: number
      cx: number
      cy: number
    }

    const comboRenderBox = (comboId: string): Box | null => {
      try {
        const element = (graph as unknown as { context?: { element?: { getElement?: (id: string) => unknown } } })
          .context?.element
        const el = element?.getElement ? element.getElement(comboId) : null
        const bounded = el as { getRenderBounds?: () => { min: number[]; max: number[] } } | null
        if (bounded?.getRenderBounds) {
          const b = bounded.getRenderBounds()
          const minX = b.min[0]!
          const minY = b.min[1]!
          const maxX = b.max[0]!
          const maxY = b.max[1]!
          if (isFinite(minX) && maxX > minX) {
            return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
          }
        }
      } catch {
        /* not measurable yet */
      }
      return null
    }

    interface Move {
      id: string
      to: [number, number]
    }

    // Animate a set of collapsed cards to new positions. Generation token: a new
    // call supersedes any in-flight tween so a swap's restore + push don't fight.
    const animateCombos = (moves: Move[]): void => {
      if (!moves.length) return
      const gen = ++animGenRef.current
      const from = new Map<string, [number, number]>(
        moves.map((m) => {
          const p = graph.getElementPosition(m.id)
          return [m.id, [p[0], p[1]]]
        }),
      )
      if (reduced()) {
        for (const m of moves) void graph.translateElementTo({ [m.id]: m.to }, false).catch(() => {})
        return
      }
      const t0 = performance.now()
      const DUR = 280
      const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
      const stepFn = (now: number): void => {
        if (gen !== animGenRef.current) return
        const p = Math.min(1, (now - t0) / DUR)
        const k = ease(p)
        for (const m of moves) {
          const [fx, fy] = from.get(m.id)!
          void graph
            .translateElementTo({ [m.id]: [fx + (m.to[0] - fx) * k, fy + (m.to[1] - fy) * k] }, false)
            .catch(() => {})
        }
        if (p < 1) requestAnimationFrame(stepFn)
      }
      requestAnimationFrame(stepFn)
    }

    const CARD_HALF_W = 124
    const CARD_HALF_H = 64

    const pushOutward = (openId: string, box: Box): void => {
      const GAP = 16
      const halfW = box.w / 2 + CARD_HALF_W + GAP
      const halfH = box.h / 2 + CARD_HALF_H + GAP
      const CW = CARD_HALF_W * 2 + 12
      const CH = CARD_HALF_H * 2 + 12
      const cards: Array<{ id: string; from: [number, number]; x: number; y: number }> = []
      for (const c of graph.getComboData()) {
        if (c.id === openId || c.style?.collapsed === false) continue
        const home = cloudHome.get(String(c.id)) ?? graph.getElementPosition(c.id)
        cards.push({ id: String(c.id), from: [home[0]!, home[1]!], x: home[0]!, y: home[1]! })
      }
      const clearBox = (m: { x: number; y: number }): void => {
        const dx = m.x - box.cx
        const dy = m.y - box.cy
        const penX = halfW - Math.abs(dx)
        const penY = halfH - Math.abs(dy)
        if (penX > 0 && penY > 0) {
          if (penX <= penY) m.x = box.cx + (dx >= 0 ? halfW : -halfW)
          else m.y = box.cy + (dy >= 0 ? halfH : -halfH)
        }
      }
      for (const m of cards) clearBox(m)
      for (let pass = 0; pass < 40; pass++) {
        let moved = false
        for (let i = 0; i < cards.length; i++) {
          for (let j = i + 1; j < cards.length; j++) {
            const a = cards[i]!
            const b = cards[j]!
            const dx = b.x - a.x
            const dy = b.y - a.y
            const penX = CW - Math.abs(dx)
            const penY = CH - Math.abs(dy)
            if (penX > 0 && penY > 0) {
              if (penX <= penY) {
                const s = ((dx === 0 ? 1 : Math.sign(dx)) * penX) / 2
                a.x -= s
                b.x += s
              } else {
                const s = ((dy === 0 ? 1 : Math.sign(dy)) * penY) / 2
                a.y -= s
                b.y += s
              }
              moved = true
            }
          }
        }
        for (const m of cards) clearBox(m)
        if (!moved) break
      }
      for (const m of cards) {
        const dx = m.x - box.cx
        const dy = m.y - box.cy
        if (Math.abs(dx) < halfW && Math.abs(dy) < halfH) {
          if (halfW - Math.abs(dx) <= halfH - Math.abs(dy)) m.x = box.cx + (dx >= 0 ? halfW : -halfW)
          else m.y = box.cy + (dy >= 0 ? halfH : -halfH)
        }
      }
      const moves: Move[] = []
      for (const m of cards) {
        if (Math.abs(m.x - m.from[0]) < 0.5 && Math.abs(m.y - m.from[1]) < 0.5) continue
        if (!nudgeHome.has(m.id)) nudgeHome.set(m.id, [m.from[0], m.from[1]])
        moves.push({ id: m.id, to: [m.x, m.y] })
      }
      animateCombos(moves)
    }

    const restoreNudged = (): void => {
      const moves: Move[] = []
      for (const [id, home] of nudgeHome) moves.push({ id, to: home })
      nudgeHome.clear()
      animateCombos(moves)
    }

    const isCollapsed = (comboId: string): boolean => {
      const c = graph.getComboData().find((x) => x.id === comboId)
      return !c || c.style?.collapsed !== false
    }

    const expandAnchored = async (comboId: string): Promise<void> => {
      if (!isCollapsed(comboId)) return
      clearHover()

      const kidIds = graph
        .getNodeData()
        .filter((n) => n.combo === comboId)
        .map((n) => String(n.id))
      const innerEdges = graph
        .getEdgeData()
        .filter((e) => kidIds.includes(String(e.source)) && kidIds.includes(String(e.target)))

      const anchorPos = cloudHome.get(comboId) ?? graph.getElementPosition(comboId)
      const anchor: [number, number] = [anchorPos[0]!, anchorPos[1]!]

      const pos = layeredPositions(kidIds, innerEdges)
      const finalPos = new Map<string, [number, number]>(
        kidIds.map((id) => {
          const p = pos.get(id) ?? { x: 0, y: 0 }
          return [id, [anchor[0] + p.x, anchor[1] + p.y]]
        }),
      )

      graph.updateComboData([{ id: comboId, style: { x: anchor[0], y: anchor[1] } }])
      graph.updateNodeData(
        kidIds.map((id) => {
          const [x, y] = finalPos.get(id)!
          return { id, style: { x, y } }
        }),
      )

      void graph.expandElement(comboId, false).catch(() => {})
      for (let i = 0; i < 60 && isCollapsed(comboId); i++) await nextFrame()
      graph.updateComboData([{ id: comboId, style: { x: anchor[0], y: anchor[1] } }])

      openComboIdRef.current = comboId

      await nextFrame()
      const box =
        comboRenderBox(comboId) ??
        (() => {
          const NODE_HW = 148 / 2
          const NODE_HH = 32 / 2
          const PAD = 24
          const xs = [...finalPos.values()].map((p) => p[0])
          const ys = [...finalPos.values()].map((p) => p[1])
          const minX = Math.min(...xs) - NODE_HW - PAD
          const maxX = Math.max(...xs) + NODE_HW + PAD
          const minY = Math.min(...ys) - NODE_HH - PAD
          const maxY = Math.max(...ys) + NODE_HH + PAD
          return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
        })()
      pushOutward(comboId, box)
    }

    const collapseAnchored = async (comboId: string): Promise<void> => {
      if (isCollapsed(comboId)) return
      clearHover()
      const anchorPos = cloudHome.get(comboId) ?? graph.getElementPosition(comboId)
      const anchor: [number, number] = [anchorPos[0]!, anchorPos[1]!]

      void graph.collapseElement(comboId, false).catch(() => {})
      for (let i = 0; i < 60 && !isCollapsed(comboId); i++) await nextFrame()
      // collapsed combos move only via translateElementTo (v5.1.1 quirk).
      await graph.translateElementTo({ [comboId]: [anchor[0], anchor[1]] }, false).catch(() => {})

      openComboIdRef.current = null
      restoreNudged()
      await graph.draw()
    }

    // ---- single-open toggle control ---------------------------------------
    const toggleCombo = async (id: string): Promise<void> => {
      if (busyRef.current) {
        pendingSwapRef.current = id
        return
      }
      busyRef.current = true
      try {
        await Promise.race([
          (async () => {
            const open = openComboIdRef.current
            if (open === id) await collapseAnchored(id)
            else if (open == null) await expandAnchored(id)
            else {
              await collapseAnchored(open)
              await expandAnchored(id)
            }
          })(),
          new Promise<void>((res) => setTimeout(res, 8000)),
        ])
      } catch {
        /* benign G6 teardown — must not wedge the lock */
      } finally {
        busyRef.current = false
        // report drill-in state up
        const open = openComboIdRef.current
        onSelectProposalRef.current?.(open ? arcKeyFromComboId(open) : null)
        const next = pendingSwapRef.current
        pendingSwapRef.current = null
        if (next != null && next !== openComboIdRef.current) void toggleCombo(next)
      }
    }

    const collapse = (): void => {
      const open = openComboIdRef.current
      if (open !== null) void toggleCombo(open)
    }

    // Expose the toggle on the graph instance so the external selectedProposalId
    // effect can drive the SAME single-open machinery (no duplicate code path).
    ;(graph as unknown as { __marsToggle?: (id: string) => void; __marsCollapse?: () => void }).__marsToggle = (
      id: string,
    ) => {
      void toggleCombo(id)
    }
    ;(graph as unknown as { __marsCollapse?: () => void }).__marsCollapse = () => collapse()

    // ---- event wiring -----------------------------------------------------
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && openComboIdRef.current !== null) collapse()
    }
    window.addEventListener('keydown', onKeyDown)

    void graph.render().then(() => {
      void graph.fitView({ when: 'always' }, false)
      for (const c of graph.getComboData()) {
        const p = graph.getElementPosition(c.id)
        setHome(String(c.id), p[0]!, p[1]!)
      }
      // apply any initial filter dim state
      applyHighlight()

      // Pulse the orange stroke of 'In progress' nodes on a ~1.6 s ease-in-out
      // cosine cycle, echoing the board view's animate-mars-pulse CSS animation.
      // - Skipped entirely under prefers-reduced-motion.
      // - Dimmed nodes (state includes 'dim') are left at their dim opacity so
      //   the search/cluster/hover dim state is never overridden by the pulse.
      // - In-progress IDs are cached at loop start (stable within a graph
      //   lifecycle) so per-frame work is O(in-progress nodes).
      // - Generation token (pulseGenRef) cancels the loop on graph rebuild or
      //   unmount, following the same pattern as animateCombos / animGenRef.
      if (!reduced()) {
        const pulseGen = ++pulseGenRef.current
        const inProgressIds = graph
          .getNodeData()
          .filter((n) => n.data?.cluster === 'In progress')
          .map((n) => String(n.id))
        if (inProgressIds.length > 0) {
          const t0 = performance.now()
          const pulseFn = (): void => {
            if (pulseGen !== pulseGenRef.current) return
            const opacity = pulseOpacity(performance.now() - t0)
            const updates = inProgressIds
              .filter((id) => !graph.getElementState(id).includes('dim'))
              .map((id) => ({ id, style: { strokeOpacity: opacity } }))
            if (updates.length > 0) {
              graph.updateNodeData(updates)
              void graph.draw().catch(() => {})
            }
            requestAnimationFrame(pulseFn)
          }
          requestAnimationFrame(pulseFn)
        }
      }

      graph.on('node:pointerenter', (ev: IPointerEvent) => {
        const id = String((ev.target as { id?: string }).id)
        schedule(() => hoverTask(id))
      })
      graph.on('combo:pointerenter', (ev: IPointerEvent) => {
        const id = String((ev.target as { id?: string }).id)
        const c = graph.getComboData().find((x) => x.id === id)
        if (c && c.style?.collapsed === false) return // expanded → it's a box, not a card
        schedule(() => hoverProposal(id))
      })
      graph.on('node:pointerleave', () => clearHover())
      graph.on('combo:pointerleave', () => clearHover())
      graph.on('canvas:click', () => clearHover())

      // single-click a task node → open its drawer (task nodes are visible only
      // when their combo is expanded). Combo single-click does NOT navigate.
      graph.on('node:click', (ev: IPointerEvent) => {
        const id = String((ev.target as { id?: string }).id)
        window.location.hash = `#/task/${encodeURIComponent(id)}`
      })

      graph.on('combo:dblclick', (ev: IPointerEvent) => {
        void toggleCombo(String((ev.target as { id?: string }).id))
      })
      graph.on('canvas:dblclick', () => collapse())
    })

    return () => {
      ++pulseGenRef.current // cancel in-progress pulse rAF loop
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('error', onWindowError, true)
      window.removeEventListener('unhandledrejection', onRejection)
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
      try {
        graph.destroy()
      } catch {
        /* ignore teardown throws */
      }
      graphRef.current = null
      litRef.current = null
      openComboIdRef.current = null
      cloudHome.clear()
      nudgeHome.clear()
    }
    // Recreate the graph only when the structural data signature changes, or the
    // empty/non-empty boundary flips. (Filter/selection props are applied via
    // the separate effects below without rebuilding the graph.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty, dataSignature(tasks, proposals)])

  // Re-apply the dim/highlight map when filter props change (no graph rebuild).
  // Uses the same pure resolver as the hover handlers so the two can't drift.
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    const map = computeStateMap(
      { nodes: graph.getNodeData(), edges: graph.getEdgeData(), combos: graph.getComboData() },
      { searchMatchIds, lit: litRef.current },
    )
    void graph.setElementState(map)
  }, [searchMatchIds])

  // Drive drill-in from the external selectedProposalId control.
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    if (lastSelectedRef.current === selectedProposalId) return
    lastSelectedRef.current = selectedProposalId

    const targetCombo = selectedProposalId ? `combo:${selectedProposalId}` : null
    const open = openComboIdRef.current
    // already in the desired state — nothing to do (prevents echo loops)
    if ((targetCombo ?? null) === (open ?? null)) return

    // Fire the toggle through the same single-open machinery the dblclick uses.
    // The component stores the toggle on the graph instance during mount; reach
    // it through a custom hook attached below.
    const driver = (graph as unknown as { __marsToggle?: (id: string) => void; __marsCollapse?: () => void })
    if (targetCombo) driver.__marsToggle?.(targetCombo)
    else driver.__marsCollapse?.()
  }, [selectedProposalId])

  if (empty) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-bg">
        <p className="font-mono text-[13px] text-iron">No active tasks</p>
      </main>
    )
  }

  return (
    <main className="relative flex min-h-0 flex-1 overflow-hidden bg-bg">
      <div
        ref={containerRef}
        className="dag-canvas absolute inset-0 h-full w-full"
        style={{ background: CANVAS_SURFACE }}
        aria-label="Task dependency graph"
      />
      {/* Navigation hint — quiet, top-right inside the canvas */}
      <div className="pointer-events-none absolute right-3 top-3 z-10 text-right font-mono text-[10.5px] leading-relaxed text-muted-dark opacity-70">
        scroll = zoom · drag = pan
        <br />
        hover → trace · double-click → expand / collapse
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
