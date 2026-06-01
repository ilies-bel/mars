/**
 * Task detail drawer — right-side panel opened from any task node on the
 * Progress tab (DAG or column view).
 *
 * Two independent data sources:
 *   1. The `tasks`/`proposals` props (supplied immediately by the parent) drive
 *      the focus-subgraph section, visible before the detail fetch completes.
 *   2. A fetch to `/api/tasks/:id` drives the tiered detail body below the
 *      subgraph.
 *
 * The subgraph reuses `focusSubgraph` — the same helper used by the main DAG
 * canvas — and uses identical cluster colours so nodes carry the same visual
 * semantics in both contexts.
 *
 * A step timeline section shows every Step span for the currently-shown task's
 * originId, fetched from `/api/step-spans`. Pass `stepSpans` directly to skip
 * that fetch (used in tests and static rendering).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProgressProposalNode, ProgressTask, Task } from '@/shared/schemas'
import { taskSchema } from '@/shared/schemas'
import { focusSubgraph } from '@/shared/focusSubgraph'
import { dagClusterStyle, DAG_EDGE_BLOCKER, DAG_EDGE_PROVENANCE } from '@/shared/dagColors'
import { relativeTime } from '@/shared/time'
import { OriginTree } from './OriginTree'

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

// ── Drill-in trail helpers ────────────────────────────────────────────────────

/**
 * Computes the next breadcrumb trail after a drill-in click.
 *
 * Pure and order-preserving: if `id` already appears in `trail`, the trail is
 * TRUNCATED to it (clicking a crumb/ancestor walks back up); otherwise `id` is
 * PUSHED onto the end. The returned array's last element is always the
 * now-current task.
 */
export const applyNavigate = (trail: string[], id: string): string[] => {
  const at = trail.indexOf(id)
  return at === -1 ? [...trail, id] : trail.slice(0, at + 1)
}

/**
 * Compact crumb label: strips a leading `mars-` prefix, else falls back to the
 * last 8 characters. Keeps the breadcrumb tight while the header keeps the
 * full id.
 */
export const crumbLabel = (id: string): string =>
  id.startsWith('mars-') ? id.slice('mars-'.length) : id.length > 8 ? id.slice(-8) : id

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
  /**
   * Seeds the drill-in breadcrumb trail. Test-only seam: production callers
   * omit it and the trail initialises to `[taskId]`. When supplied it must end
   * with `taskId` so the external-reset logic still treats `taskId` as the
   * current node; otherwise the next `taskId` effect would reset the trail.
   */
  initialTrail?: string[]
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; task: Task }

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
 * Proposal nodes are built with `kind='proposal'` so `focusSubgraph` correctly
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
      kind: 'proposal' as const,
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
  // hop + the originating Proposal (as 'proposal' provenance).
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

// ── Detail body ───────────────────────────────────────────────────────────────
// Pure, fetch-free presentation of a fully-loaded Task. Split out from the
// drawer shell so it renders synchronously in unit tests (the drawer's own
// fetch effect never fires under renderToStaticMarkup).

const SECTION_LABEL = 'font-mono text-[11px] uppercase tracking-[0.1em] text-muted'

/** A section header in the drawer body, matching the existing "Context" style. */
const SectionLabel = ({ children }: { children: ReactNode }) => (
  <h3 className={`mb-1.5 ${SECTION_LABEL}`}>{children}</h3>
)

/** A bullet list of strings; renders nothing when the array is empty. */
const StringList = ({ items }: { items: string[] }) =>
  items.length > 0 ? (
    <ul className="flex flex-col gap-0.5">
      {items.map((s) => (
        <li key={s} className="break-all font-mono text-[11px] text-iron">
          {s}
        </li>
      ))}
    </ul>
  ) : null

/** One labelled cell in the compact meta grid. */
const MetaCell = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
      {label}
    </span>
    <span className="break-all font-mono text-[11px] text-fg">{value}</span>
  </div>
)

/**
 * Renders the STATUS-FIRST tiered detail body for a fully-loaded Task.
 *
 * Section order: Header → Failure/blocker banner → Prompt → Plan → Spec →
 * Origins → Meta grid → Diagnostics. Every section after the header is omitted
 * entirely (no empty header) when its backing data is null/empty.
 */
export const TaskDetailBody = ({
  task,
  onNavigate,
  currentId,
}: {
  task: Task
  /** Drill-in handler threaded into the OriginTree; omit for display-only. */
  onNavigate?: (id: string) => void
  /** Id the OriginTree bolds as "current"; defaults to the task's own id. */
  currentId?: string
}) => {
  const firstLine = task.prompt.split('\n')[0] ?? task.prompt
  // The header already shows the whole prompt when it's a single short line;
  // in that case the dedicated Prompt section would be redundant.
  const title = firstLine
  const promptFullyShownInHeader =
    task.prompt === firstLine && firstLine.length <= 80
  const isBlocked = task.status === 'blocked'
  const showBanner =
    task.status === 'failed' || isBlocked || task.error != null
  const spec = task.spec ?? null

  return (
    <div className="flex flex-col gap-4">
      {/* a. Header tier — always present. */}
      <div>
        <p className="break-words text-sm font-medium text-fg">{title}</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span
            data-testid="task-detail-status"
            className="font-mono text-xs uppercase tracking-wide text-iron"
          >
            {task.status}
          </span>
          <span className="break-all font-mono text-[10px] text-muted">{task.id}</span>
        </div>
      </div>

      {/* b. Failure / blocker banner — prominent. */}
      {showBanner ? (
        <div
          data-testid="task-detail-error"
          className="rounded border border-error/50 bg-error/5 px-3 py-2"
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-error">
            {task.status === 'failed' ? 'Failure' : isBlocked ? 'Blocked' : 'Error'}
          </p>
          {isBlocked ? (
            <p className="mt-1 text-[11px] text-iron">
              Waiting on {task.blockedBy.length} blocker
              {task.blockedBy.length === 1 ? '' : 's'}.
            </p>
          ) : null}
          {task.error != null ? (
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-error">
              {task.error}
            </pre>
          ) : null}
          {task.failureSignature != null ? (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-error/70">
              {task.failureSignature}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* c. Prompt — only when not already fully shown in the header. */}
      {!promptFullyShownInHeader ? (
        <div>
          <SectionLabel>Prompt</SectionLabel>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-fg">
            {task.prompt}
          </pre>
        </div>
      ) : null}

      {/* d. Plan. */}
      {task.plan != null ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Plan</SectionLabel>
          {task.plan.functional ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Functional
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-fg">
                {task.plan.functional}
              </p>
            </div>
          ) : null}
          {task.plan.technical ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Technical
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-fg">
                {task.plan.technical}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* e. Spec. */}
      {spec != null ? (
        <div data-testid="task-detail-spec" className="flex flex-col gap-2">
          <SectionLabel>Spec</SectionLabel>
          {spec.files.length > 0 ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Files
              </p>
              <StringList items={spec.files} />
            </div>
          ) : null}
          {spec.readFirst.length > 0 ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Read first
              </p>
              <StringList items={spec.readFirst} />
            </div>
          ) : null}
          {spec.prescriptiveAction != null ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Action
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-fg">
                {spec.prescriptiveAction}
              </p>
            </div>
          ) : null}
          {spec.verifyCmd != null ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Verify
              </p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-fg">
                {spec.verifyCmd}
              </p>
            </div>
          ) : null}
          {spec.doneCriteria.length > 0 ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Done
              </p>
              <StringList items={spec.doneCriteria} />
            </div>
          ) : null}
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-iron/60">
            {spec.taskType}
          </p>
        </div>
      ) : null}

      {/* f. Origins — drill-in capable when the drawer passes onNavigate. */}
      <div className="text-[11px]">
        <OriginTree taskId={task.id} onNavigate={onNavigate} currentId={currentId} />
      </div>

      {/* g. Meta grid. */}
      <div data-testid="task-detail-meta" className="flex flex-col gap-2">
        <SectionLabel>Meta</SectionLabel>
        <div className="grid grid-cols-2 gap-2">
          <MetaCell label="Type" value={spec?.taskType ?? '—'} />
          <MetaCell label="Branch" value={task.branch ?? '—'} />
          <MetaCell label="Created" value={relativeTime(task.createdAt) || task.createdAt} />
          <MetaCell label="Updated" value={relativeTime(task.updatedAt) || task.updatedAt} />
        </div>
        <p className="font-mono text-[10px] text-iron">retries: {task.retryCount}</p>
      </div>

      {/* h. Diagnostics — collapsed by default. */}
      <details data-testid="task-detail-diagnostics" className="text-[11px]">
        <summary className={`cursor-pointer ${SECTION_LABEL}`}>Diagnostics</summary>
        <dl className="mt-2 flex flex-col gap-1.5">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
              Worktree
            </dt>
            <dd className="break-all font-mono text-[11px] text-iron">
              {task.worktreePath ?? '—'}
            </dd>
          </div>
          {task.blockerTaskId != null ? (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Blocker task id
              </dt>
              <dd className="break-all font-mono text-[11px] text-iron">
                {task.blockerTaskId}
              </dd>
            </div>
          ) : null}
          {task.blockedBy.length > 0 ? (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Blocked by
              </dt>
              <dd>
                <StringList items={task.blockedBy} />
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </div>
  )
}

/**
 * The step timeline — every Step span for the focused task's run, shown as a
 * compact ordered list. Rendered as its own drawer section (independent of the
 * detail fetch) so it surfaces as soon as span data is available, whether from
 * the `stepSpans` prop (tests / static rendering) or the `/api/step-spans`
 * fetch. Returns null until span data resolves.
 */
const StepTimeline = ({ spans }: { spans: StepSpan[] }) => (
  <section
    data-testid="task-step-timeline"
    className="border-b border-iron/20 px-4 py-3"
  >
    <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
      Steps
    </h3>
    {spans.length === 0 ? (
      <p className="font-mono text-xs text-iron">No steps recorded yet</p>
    ) : (
      <ol className="flex flex-col gap-1">
        {spans.map((s, i) => (
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
)

export const TaskDetailDrawer = ({
  taskId,
  onClose,
  fetchImpl,
  tasks,
  proposals,
  stepSpans,
  initialTrail,
}: TaskDetailDrawerProps) => {
  const drawerRef = useRef<HTMLElement>(null)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)

  // Drill-in breadcrumb trail. The LAST element is the currently-shown task;
  // it always starts as (and, for a single task, stays) `[taskId]`.
  const [trail, setTrail] = useState<string[]>(() => initialTrail ?? [taskId])
  const currentId = trail[trail.length - 1] ?? taskId

  /**
   * Step spans fetched from the API for the currently-shown task. Null until
   * the task detail fetch succeeds and the spans request completes. Ignored
   * when the `stepSpans` prop is set.
   */
  const [fetchedSpans, setFetchedSpans] = useState<StepSpan[] | null>(null)

  // Distinguish an external open from our own drill-in. Both arrive as a
  // changed `taskId` prop (a self-nav writes the hash, which re-derives the
  // prop), so we can't react to the prop alone. A self-nav has already pushed
  // the id onto the trail, so `taskId` is the last element — leave the trail
  // untouched. An external open targets an id the trail has never seen as
  // current, so reset to `[taskId]`.
  useEffect(() => {
    setTrail((prev) => (prev[prev.length - 1] === taskId ? prev : [taskId]))
  }, [taskId])

  // Drill-in / crumb click: truncate-or-push the trail, then write the hash so
  // the rest of the app (and our own taskId prop) follows. Matches TaskCard's
  // `window.location.hash = '#/task/<id>'` mechanism.
  const navigate = useCallback((id: string) => {
    setTrail((prev) => applyNavigate(prev, id))
    if (typeof window !== 'undefined') {
      window.location.hash = `#/task/${encodeURIComponent(id)}`
    }
  }, [])

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

  // Loads the CURRENT task (last trail element), so drilling in fetches the
  // newly-focused task's data rather than the original prop. On success it also
  // fetches that task's step spans (keyed off the task's originId), unless the
  // caller supplied them via the `stepSpans` prop.
  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    // Reset spans on every (re)load so a drill-in never shows the prior task's
    // timeline while the new one is in flight.
    setFetchedSpans(null)
    const f = fetchImpl ?? fetch
    f(`/api/tasks/${encodeURIComponent(currentId)}`)
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
        const raw = (await res.json()) as { task: unknown }
        const parsed = taskSchema.safeParse(raw.task)
        if (!parsed.success) {
          setState({ kind: 'error', message: 'response failed schema validation' })
          return
        }
        setState({ kind: 'ready', task: parsed.data })

        // When the caller pre-loaded spans, the timeline reads off the prop —
        // skip the spans fetch entirely.
        if (stepSpans !== undefined) return

        // Fetch step spans. Use the originId carried on the raw task response
        // (not on the parsed Task, which drops unknown keys); fall back to the
        // current task id when the column is absent from older DBs.
        const rawTask = raw.task as { originId?: string | null } | null
        const originId = rawTask?.originId ?? currentId
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
  }, [currentId, fetchImpl, stepSpans])

  // Compute the focus subgraph from props. This is independent of the detail
  // fetch so it renders immediately — the operator sees relationship context
  // while the status row is still loading.
  const subgraph = useMemo(
    () =>
      tasks != null && proposals != null
        ? buildSubgraphLayout(tasks, proposals, currentId)
        : null,
    [tasks, proposals, currentId],
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
        className="drawer-scrim fixed inset-0 z-40 hidden bg-fg/40 xl:block"
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
        className="drawer-panel fixed inset-0 z-50 flex w-full flex-col border-iron/40 bg-bg outline-none xl:inset-y-0 xl:left-auto xl:right-0 xl:w-[min(560px,100vw)] xl:border-l xl:shadow-2xl"
      >
      <header className="flex items-center justify-between border-b border-iron/40 px-4 py-3">
        <h2 className="font-mono text-sm uppercase tracking-wide text-iron">
          Task {currentId}
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

      {/* Drill-in breadcrumb — only once the trail has more than one hop. */}
      {trail.length > 1 ? (
        <nav
          data-testid="task-detail-breadcrumb"
          aria-label="Task drill-in trail"
          className="flex flex-wrap items-center gap-1 border-b border-iron/20 px-4 py-2 font-mono text-[11px]"
        >
          {trail.map((id, i) => {
            const isCurrent = i === trail.length - 1
            return (
              <span key={id} className="flex items-center gap-1">
                {i > 0 ? <span className="text-iron/50">▸</span> : null}
                {isCurrent ? (
                  <span data-crumb-id={id} className="font-medium text-fg">
                    {crumbLabel(id)}
                  </span>
                ) : (
                  <button
                    type="button"
                    data-crumb-id={id}
                    onClick={() => navigate(id)}
                    className="text-iron hover:underline"
                  >
                    {crumbLabel(id)}
                  </button>
                )}
              </span>
            )
          })}
        </nav>
      ) : null}

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

              {/* Nodes — each wrapped in an SVG <a> so click and keyboard
                  Enter both invoke navigate(), matching TopologyView's pattern. */}
              {subgraph.positioned.map((node) => {
                const s = miniNodeStyle(node.kind, node.cluster)
                return (
                  <a
                    key={node.id}
                    href={`#/task/${encodeURIComponent(node.id)}`}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(node.id)
                    }}
                  >
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
                  </a>
                )
              })}
            </svg>
          </div>
        </section>
      ) : null}

      {/* Step timeline — renders when spans data is available (prop or fetched).
          Sits between the relationship Context and the per-task detail body as
          a diagnostic-ish view of the task's run. */}
      {resolvedSpans !== null ? <StepTimeline spans={resolvedSpans} /> : null}

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
          <TaskDetailBody task={state.task} onNavigate={navigate} currentId={currentId} />
        </div>
      ) : null}
    </aside>
    </>
  )
}
