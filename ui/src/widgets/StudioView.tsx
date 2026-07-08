/**
 * StudioView — the live per-instance step execution tree.
 *
 * Renders one task's workflow runs (from `GET /api/runs/:taskId`, the same
 * RunTimeline the task drawer consumes) as a top-to-bottom tree of step
 * nodes connected in execution order. Each node carries the step name, a
 * status icon (the drawer's exported StepStatusIcon — identical ring/check/×
 * semantics), its duration (live elapsed while running), and three
 * on-demand panels: Input, Output, and Show trace (the EXACT composed
 * prompt sent to the step's worker, fetched lazily from
 * `GET /api/step-prompt`).
 *
 * Rendering is plain DOM/React — deliberately NOT @antv/g6. The
 * @mars/workflow engine is imperative (no static graph to lay out); a single
 * instance's tree is the observed sequence of ctx.step() spans, near-linear
 * and single-digit in node count, and the nodes need rich interactive HTML
 * affordances (expandable panels, copy, keyboard focus, WCAG AA) that a
 * canvas cannot host. G6 remains solely the cross-task blocker topology
 * tool (ADR-0043). Per PRODUCT.md the novelty budget is spent on the
 * topology view alone — Studio earns familiarity by reusing the drawer's
 * StepCardEntry normalisation (runStepToCard) as its node bodies.
 *
 * Read-only projection throughout: only observed execution renders — no
 * speculative future steps, no invented status. An instance with no
 * recorded spans gets an explicit empty state naming the task and why
 * nothing renders (never a blank canvas or a spinner pretending to load).
 */

import { useEffect, useState } from 'react'
import type { RunTimeline, RunTimelineEntry, StepCardEntry } from '@/widgets/TaskDetailDrawer'
import { formatDuration, runStepToCard, StepStatusIcon } from '@/widgets/TaskDetailDrawer'
import { useStepPrompt } from '@/entities/studio/useStudio'
import type { StepPrompt } from '@/entities/studio/types'
import { CopyButton } from '@/components/CopyButton'

// ── Pure model ────────────────────────────────────────────────────────────────

/** One workflow run prepared for rendering: its ordered node entries. */
export interface StudioRunModel {
  runId: string
  startedAt: string
  endedAt: string | null
  entries: StepCardEntry[]
}

/**
 * Normalises a RunTimeline into per-run node lists using the drawer's
 * runStepToCard — Studio nodes ARE StepCardEntry bodies; no parallel shape.
 * Runs keep the timeline's chronological order (earliest first).
 */
export const buildStudioRuns = (timeline: RunTimeline): StudioRunModel[] =>
  timeline.runs.map((run: RunTimelineEntry) => ({
    runId: run.runId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    entries: run.steps.map((step, i) => runStepToCard(step, run.runId, i)),
  }))

/** Key for the stepPrompts test seam — one entry per (runId, stepName). */
export const stepPromptKey = (runId: string, stepName: string): string =>
  `${runId}:${stepName}`

// ── Live elapsed ticker ───────────────────────────────────────────────────────

/**
 * Wall-clock "now", ticking once per second while `active`. The `nowMs`
 * override freezes it for tests / static rendering (effects never run under
 * renderToStaticMarkup, so the initial value is what renders).
 */
const useNowMs = (active: boolean, nowMs?: number): number => {
  const [now, setNow] = useState<number>(() => nowMs ?? Date.now())
  useEffect(() => {
    if (!active || nowMs !== undefined) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active, nowMs])
  return nowMs ?? now
}

/** Live elapsed label for a running step, e.g. "12.3s". */
export const liveElapsedLabel = (startedAt: string, nowMs: number): string => {
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return '—'
  return formatDuration(Math.max(0, nowMs - started))
}

// ── Panels ────────────────────────────────────────────────────────────────────

const PANEL_SUMMARY_CLASS =
  'cursor-pointer list-none rounded border border-iron/30 px-2 py-0.5 font-mono text-[10px] text-iron hover:bg-iron/10 [&::-webkit-details-marker]:hidden'

/** Space-key toggle for <details>, mirroring the drawer's step cards. */
const toggleOnSpace = (e: React.KeyboardEvent): void => {
  if (e.key === ' ') {
    e.preventDefault()
    const parent = e.currentTarget.closest('details') as HTMLDetailsElement | null
    if (parent) parent.open = !parent.open
  }
}

/** The prompt body shared by the Input and Show-trace panels. */
const PromptBody = ({
  prompt,
  isLoading,
  error,
  claudeSessionId,
  withCopy,
}: {
  prompt: StepPrompt | undefined
  isLoading: boolean
  error: Error | null
  claudeSessionId?: string | null
  withCopy: boolean
}) => {
  if (isLoading && prompt === undefined) {
    return <p className="font-mono text-[11px] text-muted">Loading prompt…</p>
  }
  if (error !== null && prompt === undefined) {
    return (
      <p className="font-mono text-[11px] text-error/80">
        Could not load the prompt ({error.message}).
      </p>
    )
  }
  if (prompt === undefined || prompt.prompt === null) {
    return (
      <p data-testid="studio-prompt-empty" className="font-mono text-[11px] text-muted">
        No prompt recorded for this step — the run predates prompt persistence
        and no transcript could be recovered.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {prompt.source === 'recovered' ? (
          <span
            data-testid="studio-prompt-source"
            className="rounded border border-warn/40 bg-warn/5 px-1 py-0.5 font-mono text-[10px] text-warn"
          >
            recovered from transcript
          </span>
        ) : (
          <span
            data-testid="studio-prompt-source"
            className="rounded border border-iron/30 px-1 py-0.5 font-mono text-[10px] text-muted"
          >
            persisted
          </span>
        )}
        {claudeSessionId != null ? (
          <span className="font-mono text-[10px] text-muted" title={claudeSessionId}>
            session:{claudeSessionId.slice(0, 8)}
          </span>
        ) : null}
        {withCopy ? (
          <CopyButton
            text={prompt.prompt}
            data-testid="studio-prompt-copy"
            aria-label="Copy the composed prompt"
            className="ml-auto shrink-0 rounded border border-iron/40 px-2 py-0.5 font-mono text-[10px] text-iron hover:bg-iron/10"
          />
        ) : null}
      </div>
      <pre
        data-testid="studio-prompt-text"
        className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-panel/60 p-2 font-mono text-[10px] leading-relaxed text-iron"
      >
        {prompt.prompt}
      </pre>
    </div>
  )
}

// ── Node ──────────────────────────────────────────────────────────────────────

const StudioNode = ({
  taskId,
  runId,
  entry,
  isLast,
  nowMs,
  stepPrompts,
  fetchImpl,
}: {
  taskId: string
  runId: string
  entry: StepCardEntry
  /** Suppresses the trailing connector on the run's final node. */
  isLast: boolean
  nowMs?: number
  stepPrompts?: Record<string, StepPrompt>
  fetchImpl?: typeof fetch
}) => {
  // The prompt is fetched lazily: the query only fires once a prompt-bearing
  // panel (Input / Show trace) has been opened at least once.
  const [promptWanted, setPromptWanted] = useState(false)
  const seeded = stepPrompts?.[stepPromptKey(runId, entry.stepName)]
  const promptQuery = useStepPrompt(
    taskId,
    runId,
    entry.stepName,
    promptWanted && seeded === undefined,
    fetchImpl,
  )
  const prompt = seeded ?? promptQuery.data

  const isRunning = entry.outcome === 'running'
  const now = useNowMs(isRunning, nowMs)
  const isLlmStep = entry.workerName != null

  const borderClass =
    entry.outcome === 'running'
      ? 'border-warn/40'
      : entry.outcome === 'failed'
        ? 'border-error/40'
        : entry.outcome === 'killed'
          ? 'border-ochre/40'
          : 'border-iron/20'
  const bgClass =
    entry.outcome === 'running'
      ? 'bg-warn/5'
      : entry.outcome === 'failed'
        ? 'bg-error/5'
        : entry.outcome === 'killed'
          ? 'bg-ochre/5'
          : 'bg-panel/30'

  const durationLabel = isRunning
    ? liveElapsedLabel(entry.startedAt, now)
    : entry.durationMs != null
      ? formatDuration(entry.durationMs)
      : null

  const onPromptPanelToggle = (e: React.SyntheticEvent<HTMLDetailsElement>): void => {
    if (e.currentTarget.open) setPromptWanted(true)
  }

  return (
    <li data-step-name={entry.stepName} className="list-none">
      <div
        data-testid="studio-node"
        data-outcome={entry.outcome}
        data-step-name={entry.stepName}
        className={`rounded-lg border ${borderClass} ${bgClass} p-3`}
      >
      {/* Node face */}
      <div className="flex items-start gap-3">
        <StepStatusIcon outcome={entry.outcome} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-semibold text-fg">{entry.stepName}</span>
            {entry.workerName != null ? (
              <span className="font-mono text-[10px] text-muted">{entry.workerName}</span>
            ) : null}
            {entry.phase != null ? (
              <span className="rounded border border-iron/30 px-1 font-mono text-[10px] text-muted">
                {entry.phase}
              </span>
            ) : null}
          </div>
          {entry.outcome === 'failed' || entry.outcome === 'killed' ? (
            <p
              data-testid="studio-node-failure"
              className={`font-mono text-[11px] ${entry.outcome === 'failed' ? 'text-error' : 'text-ochre'}`}
            >
              {entry.failureReason ?? entry.outcome}
            </p>
          ) : null}
          {entry.inputTokens != null || entry.outputTokens != null ? (
            <p className="font-mono text-[10px] text-muted">
              {entry.inputTokens != null ? `in:${entry.inputTokens}` : null}
              {entry.outputTokens != null ? ` out:${entry.outputTokens}` : null}
              {entry.cacheReadTokens != null && entry.cacheReadTokens > 0
                ? ` cache:${entry.cacheReadTokens}`
                : null}
            </p>
          ) : null}
        </div>
        {durationLabel !== null ? (
          <span
            data-testid="studio-node-duration"
            className="shrink-0 font-mono text-xs text-muted"
          >
            {durationLabel}
          </span>
        ) : null}
      </div>

      {/* Affordances — Input / Output / Show trace */}
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <details
          data-testid="studio-input-panel"
          className="min-w-0 basis-full"
          onToggle={onPromptPanelToggle}
        >
          <summary tabIndex={0} className={PANEL_SUMMARY_CLASS} onKeyDown={toggleOnSpace}>
            Input
          </summary>
          <div className="mt-1.5 border-t border-iron/15 pt-1.5">
            {isLlmStep ? (
              <PromptBody
                prompt={prompt}
                isLoading={promptQuery.isLoading}
                error={promptQuery.error}
                withCopy={false}
              />
            ) : (
              <p className="font-mono text-[11px] text-muted">
                Non-worker step — it consumes workflow state, not a prompt. No
                input is recorded for this step.
              </p>
            )}
          </div>
        </details>

        <details data-testid="studio-output-panel" className="min-w-0 basis-full">
          <summary tabIndex={0} className={PANEL_SUMMARY_CLASS} onKeyDown={toggleOnSpace}>
            Output
          </summary>
          <div className="mt-1.5 border-t border-iron/15 pt-1.5">
            {entry.resultJson != null ? (
              <pre
                data-testid="studio-output-json"
                className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-panel/60 p-1.5 font-mono text-[10px] text-iron"
              >
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(entry.resultJson), null, 2)
                  } catch {
                    return entry.resultJson
                  }
                })()}
              </pre>
            ) : (
              <p className="font-mono text-[11px] text-muted">
                {entry.outcome === 'running'
                  ? 'Still running — no output yet.'
                  : 'No output recorded for this step.'}
              </p>
            )}
          </div>
        </details>

        <details
          data-testid="studio-trace-panel"
          className="min-w-0 basis-full"
          onToggle={onPromptPanelToggle}
        >
          <summary tabIndex={0} className={PANEL_SUMMARY_CLASS} onKeyDown={toggleOnSpace}>
            Show trace
          </summary>
          <div className="mt-1.5 border-t border-iron/15 pt-1.5">
            {isLlmStep ? (
              <PromptBody
                prompt={prompt}
                isLoading={promptQuery.isLoading}
                error={promptQuery.error}
                claudeSessionId={entry.claudeSessionId}
                withCopy
              />
            ) : (
              <p className="font-mono text-[11px] text-muted">
                Non-worker step — no worker session or prompt to trace.
              </p>
            )}
          </div>
        </details>
      </div>
      </div>

      {/* Connector to the next node — execution order made visible. */}
      {!isLast ? (
        <div
          data-testid="studio-connector"
          className="mx-5 h-5 w-0 border-l-2 border-iron/30"
          aria-hidden="true"
        />
      ) : null}
    </li>
  )
}

// ── View ──────────────────────────────────────────────────────────────────────

export interface StudioViewProps {
  /** The task whose workflow runs are shown. */
  taskId: string
  /** Run timeline from GET /api/runs/:taskId (via useStudio). */
  timeline: RunTimeline
  /**
   * Pre-loaded step prompts keyed by `stepPromptKey(runId, stepName)`.
   * Test / static-rendering seam: when a node's key is present the lazy
   * `/api/step-prompt` fetch is skipped. Omit in production.
   */
  stepPrompts?: Record<string, StepPrompt>
  /** Freezes the live-elapsed clock. Test seam; omit in production. */
  nowMs?: number
  /** Override the fetcher in tests. Production callers omit it. */
  fetchImpl?: typeof fetch
}

/**
 * The execution tree for every recorded run of one task, or an explicit
 * empty state when no step spans exist yet.
 */
export const StudioView = ({ taskId, timeline, stepPrompts, nowMs, fetchImpl }: StudioViewProps) => {
  const runs = buildStudioRuns(timeline)

  if (runs.length === 0) {
    return (
      <div
        data-testid="studio-empty"
        className="flex flex-1 items-center justify-center p-6"
      >
        <p className="max-w-[52ch] text-center font-mono text-sm text-iron">
          No step spans recorded for task {taskId} yet. Either its workflow has
          not started executing, or the run predates step tracing.
        </p>
      </div>
    )
  }

  return (
    <div data-testid="studio-view" className="flex flex-col gap-6">
      {runs.map((run, runIdx) => (
        <section key={run.runId} data-testid="studio-run" data-run-id={run.runId}>
          <header className="mb-2 flex flex-wrap items-baseline gap-2">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
              Run {runIdx + 1} of {runs.length}
            </h3>
            <span className="break-all font-mono text-[10px] text-muted/70" title={run.runId}>
              {run.runId}
            </span>
            {run.endedAt === null ? (
              <span className="rounded border border-warn/40 bg-warn/5 px-1 font-mono text-[10px] text-warn">
                in flight
              </span>
            ) : null}
          </header>
          <ol className="m-0 flex list-none flex-col p-0">
            {run.entries.map((entry, i) => (
              <StudioNode
                key={entry.key}
                taskId={taskId}
                runId={run.runId}
                entry={entry}
                isLast={i === run.entries.length - 1}
                nowMs={nowMs}
                stepPrompts={stepPrompts}
                fetchImpl={fetchImpl}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}
