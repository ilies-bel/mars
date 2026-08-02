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
import { useQuery } from '@tanstack/react-query'
import type { AgentToolCall, ProgressProposalNode, ProgressTask, Task, TraceEvent } from '@/shared/schemas'
import { taskSchema } from '@/shared/schemas'
import { focusSubgraph } from '@/shared/focusSubgraph'
import { dagClusterStyle } from '@/shared/dagColors'
import { relativeTime, formatDuration } from '@/shared/time'
import { studioHash } from '@/shared/routing'
import { humanizeFailureCode } from '@/shared/actionQueueDetail'
import { FallbackSurface } from '@/components/FallbackSurface'
import { CopyButton } from '@/components/CopyButton'
import { SkeletonBlock } from '@/components/Skeleton'
import { OriginTree } from './OriginTree'
import { StewardLedgerPanel } from './StewardLedgerPanel'

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
  evalResults?: Array<{ label: string; value: number | string | null; warn: boolean }>
}

/** A single step within a workflow run entry. */
export interface RunTimelineStep {
  stepName: string
  phase: string | null
  workerName: string | null
  status: 'completed' | 'failed' | 'killed' | 'running'
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  /** Claude session id — transcript reference for LLM-backed steps. */
  claudeSessionId: string | null
  /** Failure reason when status is 'failed' or 'killed'. */
  failureReason: string | null
  /** JSON-serialised return value of the step function, or null when absent. */
  resultJson?: string | null
  /** JSON-serialised input payload passed to the step function, or null when absent. */
  inputJson?: string | null
  /** Human-readable one-line summary produced by non-LLM steps (e.g. reflect). */
  summary?: string | null
}

/** One workflow run with its ordered step list. */
export interface RunTimelineEntry {
  runId: string
  startedAt: string
  endedAt: string | null
  steps: RunTimelineStep[]
}

/** Full run history for a task, as returned by GET /api/runs/:taskId. */
export interface RunTimeline {
  taskId: string
  runs: RunTimelineEntry[]
}

/**
 * Normalised card data for a single step — derived from either StepSpan or
 * RunTimelineStep. Drives StepCard and StepCardList; avoids duplicating per-
 * outcome rendering logic across the two source shapes.
 */
export interface StepCardEntry {
  key: string
  stepName: string
  phase: string | null
  /** Unified outcome/status field — 'running' | 'completed' | 'failed' | 'killed'. */
  outcome: 'running' | 'completed' | 'failed' | 'killed'
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  workerName: string | null
  /** Failure reason text (RunTimelineStep only). */
  failureReason?: string | null
  evalResults?: Array<{ label: string; value: number | string | null; warn: boolean }>
  /** Token counts (LLM-backed steps only; from RunTimelineStep). */
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  claudeSessionId?: string | null
  /** JSON-serialised step result, rendered as an expandable Output panel. */
  resultJson?: string | null
  /** JSON-serialised step input, rendered as an expandable Input panel. */
  inputJson?: string | null
  /** Human-readable one-line summary produced by non-LLM steps (e.g. reflect). */
  summary?: string | null
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
   * Fired when the detail fetch for the currently-shown node returns 404 — the
   * task has been purged from the DB. The currently-shown id (which may differ
   * from `taskId` after a drill-in) is passed so the caller can drop the stale
   * node from the graph (e.g. invalidate the progress query) and dismiss the
   * drawer instead of leaving a dead "not found" panel open over a stale graph.
   * Omit it and the drawer falls back to rendering the not-found message.
   */
  onPurged?: (purgedId: string) => void
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
   * Pre-loaded run timeline. When provided the run timeline renders immediately
   * without fetching `/api/runs/:taskId`. Omit in production; pass in tests or
   * static rendering to control the run timeline content directly.
   */
  runTimeline?: RunTimeline
  /**
   * Seeds the drill-in breadcrumb trail. Test-only seam: production callers
   * omit it and the trail initialises to `[taskId]`. When supplied it must end
   * with `taskId` so the external-reset logic still treats `taskId` as the
   * current node; otherwise the next `taskId` effect would reset the trail.
   */
  initialTrail?: string[]
  /**
   * Step name to highlight in the step timeline. When the drawer is opened
   * from an event row, this is set to the event's `payload.stepName` so the
   * matching step row is visually distinguished. Events without a step name
   * leave this undefined — the timeline renders normally with no active row.
   */
  activeStepName?: string
  /**
   * Pre-loaded tool invocations (tool_invoked trace events). When provided the
   * step cards render tool rows immediately without fetching /api/trace-events.
   * Omit in production; pass in tests or static rendering.
   */
  toolInvocations?: TraceEvent[]
  /**
   * Pre-loaded agent tool calls keyed by claudeSessionId. When provided the
   * step cards render agent tool rows immediately without fetching
   * /api/agent-tool-calls. Omit in production; pass in tests or static
   * rendering to control agent tool content directly.
   */
  agentToolCallsBySession?: Record<string, AgentToolCall[]>
  /**
   * Overrides the query-derived load state. Test-only seam: production callers
   * omit it and the state is derived from the `['task', currentId]` React Query
   * (loading while pending, error on failure, ready/not-found from the data).
   * Use in `renderToStaticMarkup` tests to exercise the 'loading' and 'error'
   * render branches synchronously, since the query never resolves without
   * running effects.
   */
  initialState?: LoadState
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; task: Task }

// ── Mini-subgraph SVG constants ───────────────────────────────────────────────
// Slightly smaller than TopologyView's main-canvas constants; the drawer
// wraps in overflow-x-auto so wide chains remain navigable.

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

/** Re-exported so StudioView / PrimitiveDetailDrawer keep their existing import
 * path; the single definition lives in `@/shared/time`. */
export { formatDuration } from '@/shared/time'

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

/** Returns the humanized command line for a tool_invoked event payload. */
const humanizeCmd = (payload: Record<string, unknown>): string => {
  const tool = typeof payload.tool === 'string' ? payload.tool : '?'
  const argv = Array.isArray(payload.argv) ? (payload.argv as unknown[]).map(String) : []
  const basename = tool.split('/').at(-1) ?? tool
  return [basename, ...argv].join(' ')
}

/**
 * Derives a one-line summary for a collapsed step card from its tool invocations.
 * Prefers the explicit failureReason for failed steps, then derives from tool counts.
 */
const deriveStepSummary = (
  tools: TraceEvent[],
  failureReason?: string | null,
  outcome?: string,
): string => {
  if (failureReason) {
    return failureReason.length > 80 ? `${failureReason.slice(0, 80)}…` : failureReason
  }
  const total = tools.length
  if (total === 0) {
    if (!outcome || outcome === 'completed') return ''
    if (outcome === 'running') return 'running…'
    return outcome
  }
  const failed = tools.filter((e) => {
    const p = e.payload
    return typeof p.exitCode === 'number' && p.exitCode !== 0 && !p.expectsFailure
  }).length
  return failed > 0
    ? `${total} tool call${total !== 1 ? 's' : ''}, ${failed} failed`
    : `${total} tool call${total !== 1 ? 's' : ''}`
}

/** Normalises a StepSpan into the unified StepCardEntry format. */
const spanToCard = (s: StepSpan, i: number): StepCardEntry => ({
  key: `${s.workflowInstanceId}-${s.stepName}-${i}`,
  stepName: s.stepName,
  phase: s.phase,
  outcome: s.outcome,
  startedAt: s.startedAt,
  endedAt: s.endedAt,
  durationMs: s.durationMs,
  workerName: s.workerName,
  evalResults: s.evalResults,
})

/** Normalises a RunTimelineStep into the unified StepCardEntry format.
 * Exported for reuse by StudioView — Studio nodes are StepCardEntry bodies,
 * the same normalisation the drawer's step cards use (no parallel shape). */
export const runStepToCard = (
  step: RunTimelineStep,
  runId: string,
  stepIdx: number,
  evalResults?: Array<{ label: string; value: number | string | null; warn: boolean }>,
): StepCardEntry => ({
  key: `${runId}-${step.stepName}-${stepIdx}`,
  stepName: step.stepName,
  phase: step.phase,
  outcome: step.status,
  startedAt: step.startedAt,
  endedAt: step.endedAt,
  durationMs: step.durationMs,
  workerName: step.workerName,
  failureReason: step.failureReason,
  evalResults,
  inputTokens: step.inputTokens,
  outputTokens: step.outputTokens,
  cacheReadTokens: step.cacheReadTokens,
  claudeSessionId: step.claudeSessionId,
  resultJson: step.resultJson,
  inputJson: step.inputJson,
  summary: step.summary,
})

// ── Detail body ───────────────────────────────────────────────────────────────
// Pure, fetch-free presentation of a fully-loaded Task. Split out from the
// drawer shell so it renders synchronously in unit tests (the drawer's own
// fetch effect never fires under renderToStaticMarkup).

const SECTION_LABEL = 'font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground'

/** A section header in the drawer body, matching the existing "Context" style. */
const SectionLabel = ({ children }: { children: ReactNode }) => (
  <h3 className={`mb-1.5 ${SECTION_LABEL}`}>{children}</h3>
)

/** A bullet list of strings; renders nothing when the array is empty. */
const StringList = ({ items }: { items: string[] }) =>
  items.length > 0 ? (
    <ul className="flex flex-col gap-0.5">
      {items.map((s) => (
        <li key={s} className="break-all font-mono text-[11px] text-primary">
          {s}
        </li>
      ))}
    </ul>
  ) : null

/** One labelled cell in the compact meta grid. */
const MetaCell = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
      {label}
    </span>
    <span className="break-all font-mono text-[11px] text-foreground">{value}</span>
  </div>
)

/**
 * Renders the STATUS-FIRST tiered detail body for a fully-loaded Task.
 *
 * Section order: Header → Failure/blocker banner → Prompt → Workflow step →
 * Origins → Meta grid → Diagnostics. Every section after the header is omitted
 * entirely (no empty header) when its backing data is null/empty.
 */
export const TaskDetailBody = ({
  task,
  onNavigate,
  currentId,
  currentStep,
}: {
  task: Task
  /** Drill-in handler threaded into the OriginTree; omit for display-only. */
  onNavigate?: (id: string) => void
  /** Id the OriginTree bolds as "current"; defaults to the task's own id. */
  currentId?: string
  /**
   * The current (or last) workflow step the task is on — step name and when
   * the step started. When provided, a compact one-line step indicator is
   * shown in place of the old Plan/Spec builder breakdown.
   */
  currentStep?: { stepName: string; startedAt: string } | null
}) => {
  const promptLines = task.prompt.split('\n')
  const firstLine = promptLines[0] ?? task.prompt
  // The header already shows the whole prompt when it's a single short line;
  // in that case the dedicated Prompt section would be redundant.
  const title = firstLine
  const promptFullyShownInHeader =
    task.prompt === firstLine && firstLine.length <= 80
  // Collapse prompts longer than 20 lines behind a <details> disclosure.
  const promptLineCount = promptLines.length
  const promptIsLong = promptLineCount > 20
  const isBlocked = task.status === 'blocked'
  const showBanner =
    task.status === 'failed' || isBlocked || task.error != null
  const spec = task.spec ?? null

  return (
    <div className="flex flex-col gap-4">
      {/* a. Header tier — always present. */}
      <div>
        <p className="break-words text-sm font-medium text-foreground">{title}</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span
            data-testid="task-detail-status"
            className="font-mono text-xs uppercase tracking-wide text-primary"
          >
            {task.status}
          </span>
          {task.failureSignature != null ? (
            <span
              data-testid="task-detail-failure-reason"
              className="font-mono text-xs text-error"
              title={task.failureSignature}
            >
              · {humanizeFailureCode(task.failureSignature)}
            </span>
          ) : null}
          <CopyButton
            text={task.id}
            label={task.id}
            data-testid="copy-task-id"
            aria-label={`Copy task id: ${task.id}`}
            className="break-all cursor-pointer font-mono text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          />
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
            <p className="mt-1 text-[11px] text-primary">
              Waiting on {task.blockedBy.length} blocker
              {task.blockedBy.length === 1 ? '' : 's'}.
            </p>
          ) : null}
          {/* Lead with humanized cause — same source as the Action Queue banner. */}
          {task.failureSignature != null ? (
            <div className="mt-1 flex items-center gap-2">
              <p
                data-testid="task-detail-failure-cause"
                className="flex-1 text-[11px] text-error"
              >
                {humanizeFailureCode(task.failureSignature)}
              </p>
              <CopyButton
                text={task.failureSignature}
                data-testid="copy-failure-signature"
                aria-label={`Copy failure signature: ${task.failureSignature}`}
                className="shrink-0 rounded border border-error/30 px-1.5 py-0.5 font-mono text-[10px] text-error/60 hover:bg-error/10"
              />
            </div>
          ) : null}
          {/* Raw error and signature demoted to a secondary technical detail. */}
          {(task.error != null || task.failureSignature != null) ? (
            <details className="mt-1">
              <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">
                Technical details
              </summary>
              {task.error != null ? (
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-error/80">
                  {task.error}
                </pre>
              ) : null}
              {task.failureSignature != null ? (
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-error/50">
                  {task.failureSignature}
                </p>
              ) : null}
            </details>
          ) : null}
          {/* Ready-made restart command — one click to copy, then paste into CLI. */}
          {task.status === 'failed' ? (
            <div className="mt-2 flex items-center gap-2">
              <code
                data-testid="task-restart-cmd"
                className="flex-1 truncate rounded bg-error/10 px-2 py-1 font-mono text-[11px] text-error/80"
              >
                {`mars restart ${task.id}`}
              </code>
              <CopyButton
                text={`mars restart ${task.id}`}
                data-testid="copy-restart-cmd"
                aria-label={`Copy: mars restart ${task.id}`}
                className="shrink-0 rounded border border-error/30 px-2 py-0.5 font-mono text-xs text-error/60 hover:bg-error/10"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* c. Prompt — only when not already fully shown in the header. */}
      {!promptFullyShownInHeader ? (
        promptIsLong ? (
          <div>
            <details>
              <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                Prompt · {promptLineCount} lines
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
                {task.prompt}
              </pre>
            </details>
          </div>
        ) : (
          <div>
            <SectionLabel>Prompt</SectionLabel>
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">
              {task.prompt}
            </pre>
          </div>
        )
      ) : null}

      {/* d. Current workflow step — one line: step name · time since step began. */}
      {currentStep != null ? (
        <div data-testid="task-detail-current-step">
          <SectionLabel>Step</SectionLabel>
          <p className="font-mono text-[11px] text-foreground">
            {currentStep.stepName}
            <span className="text-muted-foreground"> · {relativeTime(currentStep.startedAt)}</span>
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
          <MetaCell label="Merge" value={spec?.mergeMode ?? '—'} />
          <MetaCell label="Branch" value={task.branch ?? '—'} />
          <MetaCell label="Created" value={relativeTime(task.createdAt) || task.createdAt} />
          <MetaCell label="Updated" value={relativeTime(task.updatedAt) || task.updatedAt} />
        </div>
        <p className="font-mono text-[10px] text-primary">recovery: {task.retryCount}</p>
      </div>

      {/* h. Diagnostics — collapsed by default. */}
      <details data-testid="task-detail-diagnostics" className="text-[11px]">
        <summary className={`cursor-pointer ${SECTION_LABEL}`}>Diagnostics</summary>
        <dl className="mt-2 flex flex-col gap-1.5">
          <div>
            <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
              Worktree
            </dt>
            <dd className="break-all font-mono text-[11px] text-primary">
              {task.worktreePath ?? '—'}
            </dd>
          </div>
          {task.blockerTaskId != null ? (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                Blocker task id
              </dt>
              <dd className="break-all font-mono text-[11px] text-primary">
                {task.blockerTaskId}
              </dd>
            </div>
          ) : null}
          {task.blockedBy.length > 0 ? (
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
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
 * Human-readable descriptions for known eval metric labels. Used as tooltip
 * titles and aria-labels so screen-reader users and hovering operators can
 * understand what each chip measures — especially ctx%, which is the root cause
 * of over-budget failures when it exceeds 100%.
 */
const EVAL_METRIC_DESC: Record<string, string> = {
  'ctx%': 'Context window used — 100% = full budget; above 100% means the run overran its context limit',
  'out/in': 'Output-to-input token ratio — higher values mean the model generated more relative to its input',
  'msgs': 'Number of messages in the conversation',
}

const EvalChip = ({ label, value, warn }: { label: string; value: number | string | null; warn: boolean }) => {
  if (value === null) return null
  const desc = EVAL_METRIC_DESC[label]
  return (
    <span
      title={desc}
      aria-label={desc != null ? `${label} ${String(value)}: ${desc}` : undefined}
      className={`rounded border px-1 py-0.5 font-mono text-[10px] ${
        warn
          ? 'border-warn/40 bg-warn/5 text-warn'
          : 'border-primary/30 text-muted-foreground'
      }`}
    >
      {label} {String(value)}
    </span>
  )
}

// ── Step card components ──────────────────────────────────────────────────────

/**
 * Status icon for a step card — a small ring with a symbol inside.
 * Green check ring = completed, warn pulse = running, red × = failed,
 * warn dot = killed. Uses CSS design tokens so it matches the rest of the
 * drawer's colour palette. Exported for reuse by StudioView so step status
 * carries identical visual semantics on both surfaces.
 */
export const StepStatusIcon = ({ outcome }: { outcome: StepCardEntry['outcome'] }) => {
  if (outcome === 'running') {
    return (
      <span
        data-testid="step-status-icon"
        aria-label="running"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-warn bg-warn/10 motion-safe:animate-pulse"
      >
        <span className="h-2 w-2 rounded-full bg-warn" />
      </span>
    )
  }
  if (outcome === 'completed') {
    return (
      <span
        data-testid="step-status-icon"
        aria-label="completed"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-done/60 bg-done/10 text-done"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 5L4 7L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  if (outcome === 'failed') {
    return (
      <span
        data-testid="step-status-icon"
        aria-label="failed"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-error/60 bg-error/10 text-error"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M3 3L7 7M7 3L3 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  // killed
  return (
    <span
      data-testid="step-status-icon"
      aria-label="killed"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-warn/60 bg-warn/10"
    >
      <span className="h-2 w-2 rounded-full bg-warn" />
    </span>
  )
}

/**
 * One agent (Claude Code) tool call row inside an expanded step card.
 * Renders the tool name, a success/error badge, and a truncated preview of
 * the tool input. Distinct from ToolInvocationRow (no exit code, no argv, no
 * stdout/stderr — agent calls have a different shape from shell invocations).
 */
const AgentToolCallRow = ({ call }: { call: AgentToolCall }) => {
  const inputPreview =
    call.input === null || call.input === undefined
      ? ''
      : typeof call.input === 'string'
        ? call.input
        : JSON.stringify(call.input)

  return (
    <div
      data-testid="agent-tool-row"
      className="border-t border-primary/10 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Success / error badge */}
        <span
          className={`shrink-0 rounded border px-1 py-0.5 font-mono text-[10px] ${
            call.isError
              ? 'border-error/40 bg-error/10 text-error'
              : 'border-done/30 bg-done/5 text-done'
          }`}
        >
          {call.isError ? '✗' : '✓'}
        </span>

        {/* Tool name */}
        <code
          data-testid="agent-tool-name"
          className="shrink-0 font-mono text-[11px] text-foreground"
        >
          {call.toolName}
        </code>

        {/* Truncated input preview */}
        {inputPreview ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {inputPreview.slice(0, 120)}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One tool invocation row inside an expanded step card.
 * Renders the humanized command line (basename + argv), an exit-code badge
 * (green ✓ for 0; red for unexpected non-zero; amber for expectsFailure), the
 * duration, and expandable stdout/stderr blocks.
 */
const ToolInvocationRow = ({ event }: { event: TraceEvent }) => {
  const p = event.payload
  const cmd = humanizeCmd(p)
  const exitCode = typeof p.exitCode === 'number' ? p.exitCode : null
  const durationMs = typeof p.durationMs === 'number' ? p.durationMs : null
  const stdout = typeof p.stdout === 'string' ? p.stdout : ''
  const stderr = typeof p.stderr === 'string' ? p.stderr : ''
  const expectsFailure = Boolean(p.expectsFailure)
  const isSuccess = exitCode === null || exitCode === 0
  const isExpectedFail = !isSuccess && expectsFailure
  const isActualFail = !isSuccess && !expectsFailure

  return (
    <div
      data-testid="step-tool-row"
      className="border-t border-primary/10 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Exit-code badge */}
        <span
          data-testid="exit-code-badge"
          aria-label={exitCode !== null ? `exit ${exitCode}` : undefined}
          className={`shrink-0 rounded border px-1 py-0.5 font-mono text-[10px] ${
            isActualFail
              ? 'border-error/40 bg-error/10 text-error'
              : isExpectedFail
                ? 'border-warn/40 bg-warn/5 text-warn'
                : 'border-done/30 bg-done/5 text-done'
          }`}
        >
          {exitCode === 0 ? '✓' : exitCode !== null ? `✗ ${exitCode}` : '?'}
        </span>

        {/* Humanized command */}
        <code
          data-testid="tool-cmd"
          className="flex-1 break-all font-mono text-[11px] text-foreground"
        >
          {cmd}
        </code>

        {/* Duration */}
        {durationMs !== null && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatDuration(durationMs)}
          </span>
        )}
      </div>

      {/* stdout / stderr — expandable via native <details> */}
      {(stdout || stderr) && (
        <details className="mt-1">
          <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">
            output
          </summary>
          <div className="mt-1 space-y-1">
            {stdout ? (
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-1.5 font-mono text-[10px] text-primary">
                {stdout}
              </pre>
            ) : null}
            {stderr ? (
              <pre
                className={`max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded p-1.5 font-mono text-[10px] ${
                  isActualFail ? 'bg-error/5 text-error/80' : 'bg-secondary/60 text-primary'
                }`}
              >
                {stderr}
              </pre>
            ) : null}
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * A single step card in the Mastra-Studio-style step graph.
 *
 * Collapsed view (always visible):
 *   - Status icon ring (left)
 *   - Step name as card title + optional worker name
 *   - One-line summary (tool count or failure reason)
 *   - Duration badge (right-aligned)
 *   - Eval chips
 *
 * Expanded view (on click / Enter / Space):
 *   - Token counts for LLM steps (in/out/cache)
 *   - Claude session id
 *   - All tool_invoked events grouped inside: humanized command, exit badge,
 *     duration, expandable stdout/stderr
 *
 * Uses a native <details>/<summary> for expand/collapse so the content is
 * always present in the DOM (enabling static-markup tests) and keyboard-
 * accessible (Enter toggles natively; Space handled via onKeyDown).
 */
const StepCard = ({
  entry,
  toolEvents,
  agentToolCalls,
  isActive,
}: {
  entry: StepCardEntry
  toolEvents: TraceEvent[]
  agentToolCalls: AgentToolCall[]
  isActive: boolean
}) => {
  const summary =
    deriveStepSummary(toolEvents, entry.failureReason, entry.outcome) || entry.summary || ''

  const borderClass =
    entry.outcome === 'running'
      ? 'border-warn/40'
      : entry.outcome === 'failed'
        ? 'border-error/40'
        : entry.outcome === 'killed'
          ? 'border-warn/40'
          : 'border-primary/20'

  const bgClass =
    entry.outcome === 'running'
      ? 'bg-warn/5'
      : entry.outcome === 'failed'
        ? 'bg-error/5'
        : entry.outcome === 'killed'
          ? 'bg-warn/5'
          : 'bg-secondary/30'

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      const parent = e.currentTarget.closest('details') as HTMLDetailsElement | null
      if (parent) parent.open = !parent.open
    }
  }

  return (
    <details
      data-testid="step-card"
      data-outcome={entry.outcome}
      data-active={isActive}
      className={`overflow-hidden rounded-lg border ${borderClass} ${bgClass}${isActive ? ' ring-1 ring-warn' : ''}`}
    >
      <summary
        tabIndex={0}
        className="flex cursor-pointer list-none items-start gap-3 p-3 [&::-webkit-details-marker]:hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Status icon (left) */}
        <StepStatusIcon outcome={entry.outcome} />

        {/* Step info */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm text-foreground">{entry.stepName}</span>
            {entry.workerName != null ? (
              <span className="font-mono text-[10px] text-muted-foreground">{entry.workerName}</span>
            ) : null}
          </div>
          {summary ? (
            <p className="font-mono text-[11px] text-muted-foreground">{summary}</p>
          ) : null}
          {entry.evalResults && entry.evalResults.length > 0 ? (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {entry.evalResults.map((r) => (
                <EvalChip key={r.label} label={r.label} value={r.value} warn={r.warn} />
              ))}
            </div>
          ) : null}
        </div>

        {/* Duration badge (right) */}
        {entry.durationMs != null ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {formatDuration(entry.durationMs)}
          </span>
        ) : null}
      </summary>

      {/* Expanded content — always in DOM, hidden by <details> when closed */}
      <div data-testid="step-card-expanded" className="border-t border-primary/15 px-3 pb-3">
        {/* Token counts (LLM-backed steps) */}
        {(entry.inputTokens != null || entry.outputTokens != null) ? (
          <p className="pt-2 font-mono text-[10px] text-muted-foreground">
            {entry.inputTokens != null ? `in:${entry.inputTokens}` : null}
            {entry.outputTokens != null ? ` out:${entry.outputTokens}` : null}
            {entry.cacheReadTokens != null && entry.cacheReadTokens > 0
              ? ` cache:${entry.cacheReadTokens}`
              : null}
          </p>
        ) : null}
        {entry.claudeSessionId != null ? (
          <p
            className="pt-1 font-mono text-[10px] text-muted-foreground"
            title={entry.claudeSessionId}
          >
            session:{entry.claudeSessionId.slice(0, 8)}
          </p>
        ) : null}

        {/* Orchestrator shell tool invocations */}
        {toolEvents.length > 0 ? (
          <div className="mt-2">
            {toolEvents.map((t) => (
              <ToolInvocationRow key={t.id} event={t} />
            ))}
          </div>
        ) : null}

        {/* Agent (Claude Code) tool calls extracted from transcript chunks */}
        {agentToolCalls.length > 0 ? (
          <div className={toolEvents.length > 0 ? 'mt-1' : 'mt-2'}>
            {agentToolCalls.map((c) => (
              <AgentToolCallRow key={c.toolUseId} call={c} />
            ))}
          </div>
        ) : toolEvents.length === 0 && entry.claudeSessionId == null ? (
          <p className="pt-2 font-mono text-[11px] text-muted-foreground/60">
            No tool invocations recorded
          </p>
        ) : null}

        {/* Input — collapsed by default; keyboard-accessible via <details>/<summary> */}
        {entry.inputJson != null ? (
          <details className="mt-2 border-t border-primary/10 pt-1.5">
            <summary
              tabIndex={0}
              className="cursor-pointer font-mono text-[10px] text-muted-foreground [&::-webkit-details-marker]:hidden"
              onKeyDown={(e) => {
                if (e.key === ' ') {
                  e.preventDefault()
                  const parent = e.currentTarget.closest('details') as HTMLDetailsElement | null
                  if (parent) parent.open = !parent.open
                }
              }}
            >
              Input
            </summary>
            <pre
              data-testid="step-result-input"
              className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-1.5 font-mono text-[10px] text-primary"
            >
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(entry.inputJson), null, 2)
                } catch {
                  return entry.inputJson
                }
              })()}
            </pre>
          </details>
        ) : null}

        {/* Output — collapsed by default; keyboard-accessible via <details>/<summary> */}
        {entry.resultJson != null ? (
          <details className="mt-2 border-t border-primary/10 pt-1.5">
            <summary
              tabIndex={0}
              className="cursor-pointer font-mono text-[10px] text-muted-foreground [&::-webkit-details-marker]:hidden"
              onKeyDown={(e) => {
                if (e.key === ' ') {
                  e.preventDefault()
                  const parent = e.currentTarget.closest('details') as HTMLDetailsElement | null
                  if (parent) parent.open = !parent.open
                }
              }}
            >
              Output
            </summary>
            <pre
              data-testid="step-result-output"
              className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-1.5 font-mono text-[10px] text-primary"
            >
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(entry.resultJson), null, 2)
                } catch {
                  return entry.resultJson
                }
              })()}
            </pre>
          </details>
        ) : null}
      </div>
    </details>
  )
}

/**
 * The primary step-trace surface — a vertical sequence of step cards connected
 * by dashed arrow connectors. Each card represents one workflow step; cards are
 * data-driven from the supplied entries (derived from StepSpan[] or RunTimeline)
 * so custom workflows with non-standard step names render correctly.
 *
 * Tool invocations are grouped into the matching card by timestamp: events
 * whose timestamp falls between a step's startedAt and endedAt (inclusive)
 * belong to that step. For running steps (no endedAt) all events after
 * startedAt are included.
 *
 * Replaces the old flat StepTimeline and RunTimelineSection components.
 */
const StepCardList = ({
  cards,
  toolEvents,
  agentToolCallsBySession,
  activeStepName,
  studioHref,
}: {
  cards: StepCardEntry[]
  toolEvents: TraceEvent[]
  /**
   * Agent (Claude Code) tool calls keyed by claudeSessionId. Each step card
   * looks up its own session's calls so agent tool activity is scoped to the
   * correct step.
   */
  agentToolCallsBySession?: Map<string, AgentToolCall[]>
  activeStepName?: string
  /**
   * When set, an "Open in Studio →" link renders beside the section header,
   * navigating to the full-page execution tree (`#/studio/<taskId>`) for the
   * task these steps belong to. Omitted for proposal subjects, which have no
   * single-instance Studio view.
   */
  studioHref?: string
}) => (
  <section
    data-testid="step-card-list"
    className="border-b border-primary/20 px-4 py-3"
  >
    <div className="mb-3 flex items-baseline justify-between">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        Steps
      </h3>
      {studioHref !== undefined ? (
        <a
          href={studioHref}
          data-testid="open-in-studio"
          className="font-mono text-[11px] text-primary hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Open in Studio →
        </a>
      ) : null}
    </div>
    {cards.length === 0 ? (
      <p className="font-mono text-xs text-primary">No steps recorded yet</p>
    ) : (
      <div className="flex flex-col">
        {cards.map((card, i) => {
          const cardStartedAt = new Date(card.startedAt).getTime()
          const cardEndedAt = card.endedAt == null ? null : new Date(card.endedAt).getTime()
          const cardTools = toolEvents.filter(
            (e) =>
              e.timestamp >= cardStartedAt &&
              (cardEndedAt == null || e.timestamp <= cardEndedAt),
          )
          const cardAgentCalls =
            card.claudeSessionId != null
              ? (agentToolCallsBySession?.get(card.claudeSessionId) ?? [])
              : []
          return (
            <div key={card.key}>
              <StepCard
                entry={card}
                toolEvents={cardTools}
                agentToolCalls={cardAgentCalls}
                isActive={activeStepName != null && card.stepName === activeStepName}
              />
              {i < cards.length - 1 ? (
                <div
                  className="mx-4 h-4 border-l-2 border-dashed border-primary/25"
                  aria-hidden="true"
                />
              ) : null}
            </div>
          )
        })}
      </div>
    )}
  </section>
)

/**
 * Renders the step timeline for a PROPOSAL subject, grouping spans by taskId.
 *
 * Layout:
 *   1. 'Proposal steps' section (data-testid="step-group-proposal") — spans
 *      where span.taskId === null.  auto-linker-direction spans inside this
 *      group are wrapped in a <details> (collapsed by default) showing count
 *      and summed duration; other proposal-level spans render as normal rows.
 *   2. One section per distinct non-null taskId in insertion order, each with
 *      data-testid="step-group-<taskId>".  Spine spans are rendered directly
 *      (expanded by default — no <details> wrapper).
 *
 * activeStepName highlighting uses the same data-active / ring-warn mechanism
 * as StepTimeline so the caller can pass it through without branching.
 */
const ProposalStepTimeline = ({
  spans,
  activeStepName,
}: {
  spans: StepSpan[]
  activeStepName?: string
}) => {
  // Bucket spans by taskId, preserving insertion order for task groups.
  const proposalSpans: StepSpan[] = []
  const taskBuckets = new Map<string, StepSpan[]>()
  for (const s of spans) {
    if (s.taskId === null) {
      proposalSpans.push(s)
    } else {
      if (!taskBuckets.has(s.taskId)) taskBuckets.set(s.taskId, [])
      taskBuckets.get(s.taskId)!.push(s)
    }
  }

  const autoLinkerSpans = proposalSpans.filter((s) => s.stepName === 'auto-linker-direction')
  const otherProposalSpans = proposalSpans.filter((s) => s.stepName !== 'auto-linker-direction')
  const autoLinkerTotalMs = autoLinkerSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)

  // Inline row renderer — mirrors StepTimeline's <li> shape so activeStepName
  // highlighting and data-outcome/data-active attributes behave identically.
  const renderSpanRow = (s: StepSpan, i: number, arr: StepSpan[]) => {
    const isActive = activeStepName != null && s.stepName === activeStepName
    const isLast = i === arr.length - 1
    const rowTextClass =
      s.outcome === 'running'
        ? 'text-warn'
        : s.outcome === 'failed'
          ? 'text-error'
          : s.outcome === 'killed'
            ? 'text-warn'
            : 'text-foreground'
    const dotClass =
      s.outcome === 'running'
        ? 'bg-warn border-warn/60 motion-safe:animate-pulse'
        : s.outcome === 'failed'
          ? 'bg-error/80 border-error/60'
          : s.outcome === 'killed'
            ? 'bg-warn/80 border-warn/60'
            : 'bg-accent/40 border-accent/30'
    return (
      <li
        key={`${s.workflowInstanceId}-${s.stepName}-${i}`}
        data-testid="step-timeline-row"
        data-outcome={s.outcome}
        data-active={isActive}
        className={`relative flex items-start gap-2 rounded pl-5 pr-2 py-1 font-mono text-xs ${rowTextClass}${isActive ? ' ring-1 ring-warn bg-warn/5' : ''}`}
      >
        <span className="absolute left-0 top-0 flex h-full flex-col items-center" aria-hidden="true">
          <span
            data-testid="step-status-dot"
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full border ${dotClass}`}
          />
          {!isLast && <span className="mt-0.5 w-px flex-1 bg-border/60" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="min-w-[6rem] font-semibold">{s.stepName}</span>
          {s.workerName != null ? (
            <span className="shrink-0 text-muted-foreground">{s.workerName}</span>
          ) : null}
          <span className="shrink-0 text-muted-foreground">{outcomeLabel(s.outcome)}</span>
          {s.durationMs != null ? (
            <span className="ml-auto shrink-0 text-muted-foreground">{formatDuration(s.durationMs)}</span>
          ) : null}
          {s.evalResults && s.evalResults.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {s.evalResults.map((r) => (
                <EvalChip key={r.label} label={r.label} value={r.value} warn={r.warn} />
              ))}
            </span>
          ) : null}
        </div>
      </li>
    )
  }

  return (
    <div className="border-b border-primary/20">
      {/* ── Proposal steps group ─────────────────────────────────────────── */}
      <section data-testid="step-group-proposal" className="px-4 py-3">
        <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
          Proposal steps
        </h3>
        {otherProposalSpans.length > 0 ? (
          <ol className="flex flex-col">
            {otherProposalSpans.map((s, i, arr) => renderSpanRow(s, i, arr))}
          </ol>
        ) : null}
        {autoLinkerSpans.length > 0 ? (
          <details className="mt-1">
            <summary className="cursor-pointer font-mono text-[11px] text-muted-foreground">
              auto-linker-direction &times; {autoLinkerSpans.length} ({formatDuration(autoLinkerTotalMs)})
            </summary>
            <ol className="mt-1 flex flex-col">
              {autoLinkerSpans.map((s, i, arr) => renderSpanRow(s, i, arr))}
            </ol>
          </details>
        ) : null}
        {proposalSpans.length === 0 ? (
          <p className="font-mono text-xs text-primary">No proposal-level steps recorded</p>
        ) : null}
      </section>

      {/* ── Per-task groups (spine expanded by default) ──────────────────── */}
      {[...taskBuckets.entries()].map(([taskId, taskSpans]) => (
        <section
          key={taskId}
          data-testid={`step-group-${taskId}`}
          className="border-t border-primary/20 px-4 py-3"
        >
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            {taskId} &middot; {taskSpans.length} steps
          </h3>
          <ol className="flex flex-col">
            {taskSpans.map((s, i) => renderSpanRow(s, i, taskSpans))}
          </ol>
        </section>
      ))}
    </div>
  )
}

export const TaskDetailDrawer = ({
  taskId,
  onClose,
  onPurged,
  fetchImpl,
  tasks,
  proposals,
  stepSpans,
  runTimeline,
  initialTrail,
  activeStepName,
  initialState,
  toolInvocations,
  agentToolCallsBySession: agentToolCallsBySessionProp,
}: TaskDetailDrawerProps) => {
  const drawerRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)

  // Held in a ref so the detail-fetch effect can fire the latest callback
  // without re-running when App passes a fresh inline arrow each render.
  const onPurgedRef = useRef(onPurged)
  onPurgedRef.current = onPurged

  // The graph (tasks + proposals) the drawer already holds, mirrored into refs
  // so the 404 handler can ask "is this id still in the graph?" without adding
  // these props to the fetch effect's deps (which would re-fire the fetch on
  // every graph refresh). A 404 for an id the graph still knows about is a
  // transient/source-divergence case — NOT a purge — so we must not self-close.
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks
  const proposalsRef = useRef(proposals)
  proposalsRef.current = proposals

  // Drill-in breadcrumb trail. The LAST element is the currently-shown task;
  // it always starts as (and, for a single task, stays) `[taskId]`.
  const [trail, setTrail] = useState<string[]>(() => initialTrail ?? [taskId])
  const currentId = trail[trail.length - 1] ?? taskId

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

  // Determine whether the current node is a proposal (used both for the spans
  // query URL and for selecting which timeline component to render).
  const isProposal = proposals?.some((p) => p.id === currentId) ?? false

  // Loads the CURRENT task (last trail element) via React Query so that
  // SseInvalidator's `invalidateQueries({ queryKey: ['task', openId] })`
  // triggers a re-fetch while the drawer is open, updating the status chip
  // and detail body in place without reopening.
  const taskQuery = useQuery<
    { kind: 'found'; task: Task } | { kind: 'not-found' }
  >({
    queryKey: ['task', currentId],
    queryFn: async () => {
      const f = fetchImpl ?? fetch
      const res = await f(`/api/tasks/${encodeURIComponent(currentId)}`)
      if (res.status === 404) {
        // Signal not-found as data rather than an error so we can distinguish
        // purged vs. server-error downstream.
        return { kind: 'not-found' as const }
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const raw = (await res.json()) as { task: unknown }
      const parsed = taskSchema.safeParse(raw.task)
      if (!parsed.success) {
        throw new Error('response failed schema validation')
      }
      return { kind: 'found' as const, task: parsed.data }
    },
    retry: false,
  })

  // Handle purge: a 404 only means "purged" when the id is also absent from
  // the graph the drawer already holds. The detail endpoint (local SQLite) and
  // the graph (daemon /view/*) are distinct sources — a node can exist in the
  // graph yet 404 on detail (proposal/arc node, cross-project id, transient
  // divergence). Self-closing on those flashes open-then-shut. Fire onPurged
  // only when the graph no longer knows the id; otherwise show not-found panel.
  useEffect(() => {
    if (taskQuery.data?.kind !== 'not-found') return
    const stillInGraph =
      (tasksRef.current?.some((t) => t.id === currentId) ?? false) ||
      (proposalsRef.current?.some((p) => p.id === currentId) ?? false)
    if (onPurgedRef.current && !stillInGraph) {
      onPurgedRef.current(currentId)
    }
  }, [taskQuery.data, currentId])

  // Derive the LoadState the rest of the component already uses from the query.
  // An explicit `initialState` prop overrides the query-derived state — a
  // test-only seam so `renderToStaticMarkup` can exercise the 'loading' and
  // 'error' branches synchronously (the query never resolves under static
  // rendering, so the error branch is otherwise unreachable in a test).
  const state: LoadState = (() => {
    if (initialState !== undefined) return initialState
    if (taskQuery.isPending) return { kind: 'loading' }
    if (taskQuery.isError) {
      const message =
        taskQuery.error instanceof Error ? taskQuery.error.message : 'request failed'
      return { kind: 'error', message }
    }
    if (!taskQuery.data || taskQuery.data.kind === 'not-found') return { kind: 'not-found' }
    return { kind: 'ready', task: taskQuery.data.task }
  })()

  // Step spans — fetched once the task is known (proposals need the originId
  // from the task; plain tasks can be keyed by currentId directly).
  // The `['task', currentId, 'spans']` key is a sub-key of `['task', currentId]`,
  // so the same SseInvalidator invalidation also retargets this query.
  const readyTask = taskQuery.data?.kind === 'found' ? taskQuery.data.task : null
  const spansQuery = useQuery<StepSpan[]>({
    queryKey: ['task', currentId, 'spans'],
    queryFn: async () => {
      const f = fetchImpl ?? fetch
      const spansUrl = isProposal
        ? `/api/step-spans?originId=${encodeURIComponent(readyTask?.originId ?? currentId)}`
        : `/api/step-spans?taskId=${encodeURIComponent(currentId)}`
      const res = await f(spansUrl)
      if (!res.ok) return []
      const data = (await res.json()) as { spans: StepSpan[] }
      return data.spans
    },
    // For proposals, wait until the task is loaded so we have the originId.
    enabled: stepSpans === undefined && (!isProposal || readyTask !== null),
    retry: false,
  })

  // Run timeline — optional display data; a failed fetch leaves the section
  // absent rather than erroring the drawer.
  const runsQuery = useQuery<RunTimeline>({
    queryKey: ['task', currentId, 'runs'],
    queryFn: async () => {
      const f = fetchImpl ?? fetch
      const res = await f(`/api/runs/${encodeURIComponent(currentId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as RunTimeline
    },
    enabled: runTimeline === undefined,
    retry: false,
  })

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

  // (posById / svgWidth / svgHeight removed — context chips are now flex HTML
  // elements; x/y coordinates from buildSubgraphLayout are no longer used for
  // rendering, only for the topological ordering in positioned[].)

  // Tool invocations — fetched from /api/trace-events?kind=tool_invoked&taskId=<id>.
  // Grouped into step cards by timestamp (events between step.startedAt and
  // step.endedAt belong to that step). The prop path skips the fetch for tests.
  const toolEventsQuery = useQuery<TraceEvent[]>({
    queryKey: ['task', currentId, 'tool-events'],
    queryFn: async () => {
      const f = fetchImpl ?? fetch
      const res = await f(
        `/api/trace-events?taskId=${encodeURIComponent(currentId)}&kind=tool_invoked&limit=500`,
      )
      if (!res.ok) return []
      const data = (await res.json()) as { events: TraceEvent[] }
      // Events come newest-first; reverse to chronological order for per-step grouping.
      return (data.events ?? []).slice().reverse()
    },
    enabled: toolInvocations === undefined,
    retry: false,
  })

  // The resolved spans to render: prefer the prop (for testing / static
  // rendering), otherwise use the spans fetched from the API.
  const resolvedSpans = stepSpans !== undefined ? stepSpans : (spansQuery.data ?? null)
  // Same resolution for the run timeline data.
  const resolvedRunTimeline = runTimeline !== undefined ? runTimeline : (runsQuery.data ?? null)
  // Resolved tool invocations.
  const resolvedToolEvents: TraceEvent[] =
    toolInvocations !== undefined ? toolInvocations : (toolEventsQuery.data ?? [])

  // Collect unique claudeSessionIds from the run timeline so we can fetch
  // agent tool calls per session. Only populated once run data is available.
  const sessionIds = useMemo(() => {
    const ids = new Set<string>()
    const timeline = resolvedRunTimeline
    if (timeline != null) {
      for (const run of timeline.runs) {
        for (const step of run.steps) {
          if (step.claudeSessionId != null) ids.add(step.claudeSessionId)
        }
      }
    }
    return [...ids]
  }, [resolvedRunTimeline])

  // Agent tool calls — fetched per-session from /api/agent-tool-calls and merged
  // into a Map<sessionId, AgentToolCall[]> so each step card can look up its
  // own session's calls. The prop path (agentToolCallsBySessionProp) skips the
  // fetch for tests and static rendering.
  const agentToolCallsQuery = useQuery<Map<string, AgentToolCall[]>>({
    queryKey: ['task', currentId, 'agent-tool-calls', sessionIds.join(',')],
    queryFn: async () => {
      const f = fetchImpl ?? fetch
      const results = new Map<string, AgentToolCall[]>()
      await Promise.all(
        sessionIds.map(async (sid) => {
          const res = await f(
            `/api/agent-tool-calls?taskId=${encodeURIComponent(currentId)}&sessionId=${encodeURIComponent(sid)}`,
          )
          if (!res.ok) return
          const data = (await res.json()) as { calls: AgentToolCall[] }
          results.set(sid, data.calls ?? [])
        }),
      )
      return results
    },
    enabled: sessionIds.length > 0 && agentToolCallsBySessionProp === undefined,
    retry: false,
  })

  const resolvedAgentToolCallsBySession: Map<string, AgentToolCall[]> = useMemo(() => {
    if (agentToolCallsBySessionProp !== undefined) {
      return new Map(Object.entries(agentToolCallsBySessionProp))
    }
    return agentToolCallsQuery.data ?? new Map()
  }, [agentToolCallsBySessionProp, agentToolCallsQuery.data])

  // Build a lookup of eval results keyed by `${workflowInstanceId}:${stepName}`
  // so StepCardList can fold eval chips from StepSpan data into run timeline cards.
  const spanEvalMap = useMemo(() => {
    if (resolvedSpans == null) return undefined
    const m = new Map<string, Array<{ label: string; value: number | string | null; warn: boolean }>>()
    for (const s of resolvedSpans) {
      if (s.evalResults != null && s.evalResults.length > 0) {
        m.set(`${s.workflowInstanceId}:${s.stepName}`, s.evalResults)
      }
    }
    return m.size > 0 ? m : undefined
  }, [resolvedSpans])

  // Derive the current (or last) workflow step from the run timeline or spans.
  // Prefers a step with status/outcome='running'; falls back to the last step
  // in the most recent run. Passed into TaskDetailBody for the step indicator.
  const currentStep = useMemo<{ stepName: string; startedAt: string } | null>(() => {
    if (resolvedRunTimeline !== null && resolvedRunTimeline.runs.length > 0) {
      const allSteps = resolvedRunTimeline.runs.flatMap((r) => r.steps)
      const running = allSteps.filter((s) => s.status === 'running').at(-1)
      return running ?? allSteps.at(-1) ?? null
    }
    if (resolvedSpans !== null && resolvedSpans.length > 0) {
      const running = resolvedSpans.filter((s) => s.outcome === 'running').at(-1)
      return running ?? resolvedSpans.at(-1) ?? null
    }
    return null
  }, [resolvedRunTimeline, resolvedSpans])

  return (
    <>
      {/* Scrim — sits at z-40 (below the drawer's z-50) so clicks outside dismiss the panel */}
      <div
        data-testid="task-detail-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 hidden bg-foreground/40 xl:block"
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
        className="drawer-panel fixed inset-0 z-50 flex w-full flex-col border-primary/40 bg-background outline-none xl:inset-y-0 xl:left-auto xl:right-0 xl:w-[min(560px,100vw)] xl:border-l xl:shadow-2xl"
      >
      <header className="flex items-center justify-between border-b border-primary/40 px-4 py-3">
        <h2 className="font-mono text-sm uppercase tracking-wide text-primary">
          Task {currentId}
        </h2>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close task detail"
          data-testid="task-detail-close"
          className="rounded border border-primary/40 px-2 py-0.5 font-mono text-xs text-primary hover:bg-primary/10"
        >
          Close
        </button>
      </header>

      {/* Drill-in breadcrumb — only once the trail has more than one hop. */}
      {trail.length > 1 ? (
        <nav
          data-testid="task-detail-breadcrumb"
          aria-label="Task drill-in trail"
          className="flex flex-wrap items-center gap-1 border-b border-primary/20 px-4 py-2 font-mono text-[11px]"
        >
          {trail.map((id, i) => {
            const isCurrent = i === trail.length - 1
            return (
              <span key={id} className="flex items-center gap-1">
                {i > 0 ? <span className="text-muted-foreground">▸</span> : null}
                {isCurrent ? (
                  <span data-crumb-id={id} className="font-medium text-foreground">
                    {crumbLabel(id)}
                  </span>
                ) : (
                  <button
                    type="button"
                    data-crumb-id={id}
                    onClick={() => navigate(id)}
                    className="text-primary hover:underline"
                  >
                    {crumbLabel(id)}
                  </button>
                )}
              </span>
            )
          })}
        </nav>
      ) : null}

      {subgraph != null && state.kind !== 'not-found' ? (
        <section
          data-testid="task-detail-subgraph"
          className="border-b border-primary/20 px-4 py-3"
        >
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            Context
          </h3>
          {/* Flex-wrap chip layout — each node is an HTML anchor chip so labels
              never overflow into adjacent nodes and the styling sits naturally on
              the drawer's light card background.  Edge metadata is preserved in
              hidden spans for structural assertions. */}
          <div className="flex flex-wrap items-center gap-2">
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
                  data-node-id={node.id}
                  data-node-kind={node.kind}
                  {...(node.kind === 'task' ? { 'data-cluster': node.cluster } : {})}
                  className="flex min-w-0 items-center gap-1.5 rounded border border-border bg-secondary px-2 py-1 font-mono text-[10px] text-foreground hover:bg-secondary/80"
                >
                  {/* Status dot — uses the dag cluster fill token so cluster
                      identity is preserved on the light surface without painting
                      the entire chip with the dark-canvas palette. */}
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: s.fill }}
                    aria-hidden="true"
                  />
                  <span className="max-w-[140px] truncate">{node.label}</span>
                </a>
              )
            })}
            {/* Edge metadata preserved as screen-reader-only spans so structural
                assertions on data-edge-kind continue to hold. */}
            {subgraph.edges.map((e) => (
              <span
                key={`${e.from}::${e.to}::${e.kind}`}
                data-edge-kind={e.kind}
                className="sr-only"
                aria-hidden="true"
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Step cards — the primary trace surface.
          When run timeline data is available it takes precedence: steps are
          derived from each run's step list (richer: tokens, session ids, failure
          reasons) and eval chips are folded in from span data.
          When only span data is available the spans become the cards directly.
          For proposals the legacy ProposalStepTimeline handles grouping by taskId.
          Exactly one step-card-list renders; no duplicate step lists. */}
      {state.kind === 'not-found' ? null : resolvedRunTimeline !== null && resolvedRunTimeline.runs.length > 0 ? (
        <StepCardList
          cards={resolvedRunTimeline.runs.flatMap((run) =>
            run.steps.map((step, i) =>
              runStepToCard(
                step,
                run.runId,
                i,
                spanEvalMap?.get(`${run.runId}:${step.stepName}`),
              ),
            ),
          )}
          toolEvents={resolvedToolEvents}
          agentToolCallsBySession={resolvedAgentToolCallsBySession}
          activeStepName={activeStepName}
          studioHref={isProposal ? undefined : studioHash(currentId)}
        />
      ) : resolvedSpans !== null ? (
        isProposal ? (
          <ProposalStepTimeline spans={resolvedSpans} activeStepName={activeStepName} />
        ) : (
          <StepCardList
            cards={resolvedSpans.map(spanToCard)}
            toolEvents={resolvedToolEvents}
            agentToolCallsBySession={resolvedAgentToolCallsBySession}
            activeStepName={activeStepName}
            studioHref={studioHash(currentId)}
          />
        )
      ) : null}

      {state.kind === 'loading' ? (
        <div
          data-testid="task-detail-loading"
          className="flex-1 p-4"
          aria-busy="true"
          aria-label="Loading task details"
        >
          <SkeletonBlock className="mb-3 h-4 w-3/4" />
          <SkeletonBlock className="mb-3 h-4 w-1/2" />
          <SkeletonBlock className="mb-3 h-4 w-2/3" />
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <div data-testid="task-detail-error" className="flex-1">
          <FallbackSurface error={new Error(state.message)} of="task details" variant="pane" />
        </div>
      ) : null}

      {state.kind === 'not-found' ? (
        <div
          data-testid="task-detail-not-found"
          className="flex flex-1 items-center justify-center p-6"
        >
          <p className="max-w-[40ch] text-center font-mono text-sm text-primary">
            Task not found. It may have been purged.
          </p>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <div
          data-testid="task-detail-body"
          className="flex-1 overflow-y-auto p-4"
        >
          <TaskDetailBody task={state.task} onNavigate={navigate} currentId={currentId} currentStep={currentStep} />
          <StewardLedgerPanel
            targetKind={isProposal ? 'arc' : 'task'}
            targetId={currentId}
          />
        </div>
      ) : null}
    </aside>
    </>
  )
}
