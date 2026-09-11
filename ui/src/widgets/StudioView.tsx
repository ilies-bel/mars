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
 * Rendering is plain DOM/React — deliberately NOT a graph library. The
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
 * recorded spans gets an explicit empty state naming the task (never a
 * blank canvas or a spinner pretending to load).
 */

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { RunTimeline, RunTimelineEntry, StepCardEntry } from '@/widgets/TaskDetailDrawer'
import { formatDuration, runStepToCard, StepStatusIcon } from '@/widgets/TaskDetailDrawer'
import { useStepPrompt } from '@/entities/studio/useStudio'
import type { StepPrompt } from '@/entities/studio/types'
import { primitiveForStep } from '@/entities/primitive/types'
import { primitiveHash } from '@/shared/routing'
import { CopyButton } from '@/components/CopyButton'
import { formatTokensLabel } from '@/shared/displayStrings'

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

/**
 * A disclosure chip, not a bar. These summaries used to carry `basis-full`, so
 * each rendered as a full-bleed bordered row with a tiny label at the left
 * edge — visually a disabled text input, three of them stacked per step. They
 * now hug their label and sit inline; only an OPEN panel claims the full row
 * (`open:basis-full` on the <details>), so its body still gets the width.
 */
const PANEL_SUMMARY_CLASS =
  'inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded border border-border px-2 py-0.5 text-micro text-muted-foreground hover:bg-foreground/5 hover:text-foreground [&::-webkit-details-marker]:hidden'

/** Space-key toggle for <details>, mirroring the drawer's step cards. */
const toggleOnSpace = (e: React.KeyboardEvent): void => {
  if (e.key === ' ') {
    e.preventDefault()
    const parent = e.currentTarget.closest('details') as HTMLDetailsElement | null
    if (parent) parent.open = !parent.open
  }
}

/**
 * One disclosure panel on a node face.
 *
 * The open state is React state rather than a CSS `open:` variant because the
 * two things that must change on open — the chevron rotating and the panel
 * claiming the full row so its body gets the width — were both silently
 * dropped by the utility generator (the classes landed on the elements and no
 * rule was ever emitted for them). A boolean is not clever, but it is checkable.
 */
const NodePanel = ({
  label,
  testId,
  onOpen,
  children,
}: {
  label: string
  testId: string
  /** Fired the first time the panel is opened — the lazy prompt fetch trigger. */
  onOpen?: () => void
  children: React.ReactNode
}) => {
  const [open, setOpen] = useState(false)
  return (
    <details
      data-testid={testId}
      className={`min-w-0 ${open ? 'basis-full' : ''}`}
      onToggle={(e: React.SyntheticEvent<HTMLDetailsElement>) => {
        const isOpen = e.currentTarget.open
        setOpen(isOpen)
        if (isOpen) onOpen?.()
      }}
    >
      <summary tabIndex={0} className={PANEL_SUMMARY_CLASS} onKeyDown={toggleOnSpace}>
        <ChevronRight
          size={10}
          strokeWidth={2.5}
          aria-hidden="true"
          className="shrink-0 transition-transform"
          style={open ? { transform: 'rotate(90deg)' } : undefined}
        />
        {label}
      </summary>
      <div className="mt-1.5 border-t border-border pt-1.5">{children}</div>
    </details>
  )
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
    return <p className="text-label text-muted-foreground">Loading prompt…</p>
  }
  if (error !== null && prompt === undefined) {
    return (
      <p className="text-label text-error/80">
        Could not load the prompt ({error.message}).
      </p>
    )
  }
  if (prompt === undefined || prompt.prompt === null) {
    const msg =
      prompt?.source === 'none'
        ? 'No prompt for this step type — setup, verify, and merge steps are not LLM-backed.'
        : prompt?.source === 'not-captured'
          ? 'Prompt not captured — this run predates prompt persistence and no transcript survived.'
          : 'No prompt recorded for this step — the run predates prompt persistence and no transcript could be recovered.'
    return (
      <p data-testid="studio-prompt-empty" className="text-label text-muted-foreground">
        {msg}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {prompt.source === 'recovered' ? (
          <span
            data-testid="studio-prompt-source"
            className="rounded border border-warn/40 bg-warn/5 px-1 py-0.5 text-micro text-warn"
          >
            recovered from transcript
          </span>
        ) : (
          <span
            data-testid="studio-prompt-source"
            className="rounded border border-border px-1 py-0.5 text-micro text-muted-foreground"
          >
            persisted
          </span>
        )}
        {claudeSessionId != null ? (
          <span className="text-micro text-muted-foreground" title={claudeSessionId}>
            session:{claudeSessionId.slice(0, 8)}
          </span>
        ) : null}
        {withCopy ? (
          <CopyButton
            text={prompt.prompt}
            data-testid="studio-prompt-copy"
            aria-label="Copy the composed prompt"
            className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-micro text-muted-foreground hover:bg-foreground/5"
          />
        ) : null}
      </div>
      <pre
        data-testid="studio-prompt-text"
        className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-secondary/60 p-2 font-mono text-micro leading-relaxed text-muted-foreground"
      >
        {prompt.prompt}
      </pre>
    </div>
  )
}

// ── Node ──────────────────────────────────────────────────────────────────────

/**
 * The primitive facet chip on a node face. When the step's (phase, stepName)
 * maps to a known primitive, the phase chip becomes a link into the
 * route-addressable primitive drawer (`#/primitive/<name>`) — the Studio
 * entry point for the per-primitive tool surface and run history. Unmapped
 * phases keep the plain chip.
 */
const PhaseChip = ({ phase, stepName }: { phase: string; stepName: string }) => {
  const primitive = primitiveForStep(phase, stepName)
  if (primitive === null) {
    return (
      <span className="rounded border border-border px-1 text-micro text-muted-foreground">
        {phase}
      </span>
    )
  }
  return (
    <a
      href={primitiveHash(primitive)}
      data-testid="studio-node-primitive-link"
      title={`Open the ${primitive} primitive — tool surface and run history`}
      className="rounded border border-border px-1 text-micro text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
    >
      {phase}
    </a>
  )
}

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
  // A completed step with no recorded result has nothing to open; a running
  // one does ("no output yet" is news, "no output recorded" is not).
  const hasOutput = entry.resultJson != null || entry.outcome === 'running'

  const borderClass =
    entry.outcome === 'running'
      ? 'border-warn/40'
      : entry.outcome === 'failed'
        ? 'border-error/40'
        : entry.outcome === 'killed'
          ? 'border-warn/40'
          : 'border-border'
  const bgClass =
    entry.outcome === 'running'
      ? 'bg-warn/5'
      : entry.outcome === 'failed'
        ? 'bg-error/5'
        : entry.outcome === 'killed'
          ? 'bg-warn/5'
          : 'bg-secondary/30'

  const durationLabel = isRunning
    ? liveElapsedLabel(entry.startedAt, now)
    : entry.durationMs != null
      ? formatDuration(entry.durationMs)
      : null

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
            <span className="text-title font-semibold text-foreground">{entry.stepName}</span>
            {entry.workerName != null ? (
              <span className="text-micro text-muted-foreground">{entry.workerName}</span>
            ) : null}
            {entry.phase != null ? (
              <PhaseChip phase={entry.phase} stepName={entry.stepName} />
            ) : null}
          </div>
          {entry.outcome === 'failed' || entry.outcome === 'killed' ? (
            <p
              data-testid="studio-node-failure"
              className={`text-label ${entry.outcome === 'failed' ? 'text-error' : 'text-warn'}`}
            >
              {entry.failureReason ?? entry.outcome}
            </p>
          ) : null}
          {(() => {
            const label = formatTokensLabel(entry.inputTokens, entry.outputTokens, entry.cacheReadTokens)
            return label !== null ? (
              <p data-testid="studio-node-tokens" className="text-micro text-muted-foreground">
                {label}
              </p>
            ) : null
          })()}
        </div>
        {durationLabel !== null ? (
          <span
            data-testid="studio-node-duration"
            className="shrink-0 text-body text-muted-foreground"
          >
            {durationLabel}
          </span>
        ) : null}
      </div>

      {/*
        Only offer a panel that has something behind it.

        Every node used to render all three panels unconditionally. On a
        four-step run that is fifteen disclosure rows, and NINE of them expand
        onto a sentence explaining that nothing was recorded — the operator
        learns that opening one is a coin flip and stops opening any.

        Two of the three were also the same panel. "Input" and "Show trace"
        both rendered `PromptBody` over the same fetched prompt; the only
        difference was that trace added a copy button and the session id. They
        are merged into one "Input" panel that carries both.

        What is left is knowable in advance: a non-worker step (setup, verify,
        merge) has no prompt by construction, and Output is gated on a recorded
        result. A step with nothing to show renders as its face alone, which is
        the honest shape for it.
      */}
      {isLlmStep || hasOutput ? (
        <div className="mt-2 flex flex-wrap items-start gap-2">
          {isLlmStep ? (
            <NodePanel label="Input" testId="studio-input-panel" onOpen={() => setPromptWanted(true)}>
              <PromptBody
                prompt={prompt}
                isLoading={promptQuery.isLoading}
                error={promptQuery.error}
                claudeSessionId={entry.claudeSessionId}
                withCopy
              />
            </NodePanel>
          ) : null}

          {hasOutput ? (
            <NodePanel label="Output" testId="studio-output-panel">
              {entry.resultJson != null ? (
                <pre
                  data-testid="studio-output-json"
                  className="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-secondary/60 p-1.5 font-mono text-micro text-muted-foreground"
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
                <p className="text-label text-muted-foreground">Still running — no output yet.</p>
              )}
            </NodePanel>
          ) : null}
        </div>
      ) : null}
      </div>

      {/* Connector to the next node — execution order made visible. */}
      {!isLast ? (
        <div
          data-testid="studio-connector"
          className="mx-5 h-5 w-0 border-l-2 border-border"
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
        <p className="max-w-[52ch] text-center font-mono text-title text-muted-foreground">
          No step spans for {taskId}
        </p>
      </div>
    )
  }

  return (
    <div data-testid="studio-view" className="flex flex-col gap-6">
      {runs.map((run, runIdx) => (
        <section key={run.runId} data-testid="studio-run" data-run-id={run.runId}>
          <header className="mb-2 flex flex-wrap items-baseline gap-2">
            <h3 className="eyebrow text-muted-foreground">
              Run {runIdx + 1} of {runs.length}
            </h3>
            {/* runId is a long internal string (e.g. scorer-bc1661fb-…); keep it
                accessible on hover for support/debugging but off the face. */}
            <span className="sr-only" title={run.runId}>{run.runId}</span>
            {run.endedAt === null ? (
              <span className="rounded border border-warn/40 bg-warn/5 px-1 text-micro text-warn">
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
