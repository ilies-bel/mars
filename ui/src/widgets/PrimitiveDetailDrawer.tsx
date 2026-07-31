/**
 * Primitive detail drawer — the route-addressable facet at
 * `#/primitive/<name>` for one of the six workflow primitives
 * (setupWorktree, runAgent, verify, behaviourVerify, merge, awaitHuman).
 *
 * A facet of the Studio surface, not a standalone page: Studio step nodes
 * link here via their phase chip, and the overlay-route convention matches
 * the proposal drawers exactly (scrim + right panel + Escape). Read-only
 * projection throughout — it renders exactly what `GET /api/primitives/:name`
 * returns.
 *
 * The body follows the PRD's two-section honesty rule:
 *  1. Identity — name, one-line description, executor + phase chips.
 *  2. Tool surface — DECLARED Worker Authorization profiles for agent
 *     primitives; OBSERVED shell tools (tool_invoked events) for
 *     deterministic ones; an explicit "human step — no tool surface" for
 *     awaitHuman. Never conflated, never fabricated. Caveats (e.g. merge's
 *     Vega escalation) render verbatim beside the surface they qualify.
 *  3. Run history — the recent-N Step spans (window-scoped aggregates,
 *     labelled "last N"), each row reusing the drawer's StepStatusIcon /
 *     runStepToCard / formatDuration and linking to its task
 *     (`#/task/<id>`) and into the Studio execution tree
 *     (`#/studio/<taskId>`). awaitHuman renders parks instead — it emits no
 *     spans, and the UI never pretends a human step is an agent run.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RunTimelineStep, StepCardEntry } from '@/widgets/TaskDetailDrawer'
import { formatDuration, runStepToCard, StepStatusIcon } from '@/widgets/TaskDetailDrawer'
import { usePrimitiveDetail } from '@/entities/primitive/usePrimitive'
import type {
  PrimitiveDetail,
  PrimitiveName,
  PrimitiveRun,
  PrimitiveWorkerProfile,
} from '@/entities/primitive/types'
import { PRIMITIVE_NAMES } from '@/entities/primitive/types'
import { primitiveHash, studioHash, taskHash } from '@/shared/routing'
import { relativeTime } from '@/shared/time'
import { SkeletonList } from '@/components/Skeleton'
import { StewardLedgerPanel } from './StewardLedgerPanel'

// ── Pure model ────────────────────────────────────────────────────────────────

/**
 * Normalises a PrimitiveRun into the drawer's unified StepCardEntry via
 * runStepToCard — primitive history rows ARE step cards, no parallel shape.
 * Wire outcomes outside the card union (or a still-open span) map to
 * 'running', mirroring viewRunTimeline's status coercion.
 */
export const primitiveRunToCard = (run: PrimitiveRun, idx: number): StepCardEntry => {
  const status: RunTimelineStep['status'] =
    run.outcome === 'completed' || run.outcome === 'failed' || run.outcome === 'killed'
      ? run.outcome
      : 'running'
  const step: RunTimelineStep = {
    stepName: run.stepName,
    phase: null,
    workerName: run.workerName,
    status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    claudeSessionId: run.claudeSessionId,
    failureReason: null,
    resultJson: null,
  }
  return runStepToCard(step, run.workflowInstanceId, idx)
}

/**
 * Window-scoped success rate over the FINISHED runs (running spans are
 * excluded — they have no outcome yet). Returns null when nothing finished,
 * so the UI shows no rate rather than a fake 0%/100%.
 */
export const windowSuccessRate = (runs: PrimitiveRun[]): number | null => {
  const finished = runs.filter((r) => r.outcome !== 'running')
  if (finished.length === 0) return null
  const completed = finished.filter((r) => r.outcome === 'completed').length
  return Math.round((completed / finished.length) * 100)
}

/** Human label for the executor chip. */
export const executorLabel = (executor: PrimitiveDetail['primitive']['executor']): string => {
  switch (executor) {
    case 'agent':
      return 'agent step'
    case 'shell':
      return 'deterministic shell step'
    case 'human':
      return 'human step'
  }
}

// ── Section chrome ────────────────────────────────────────────────────────────

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
    {children}
  </p>
)

/** One Worker's Authorization profile card. */
const WorkerProfileCard = ({ profile }: { profile: PrimitiveWorkerProfile }) => (
  <li
    data-testid="primitive-worker-profile"
    data-worker-name={profile.workerName}
    className="rounded border border-primary/20 px-2 py-1.5"
  >
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="font-mono text-xs font-semibold text-foreground">{profile.workerName}</span>
      {profile.source === 'registry' ? (
        <span className="rounded border border-warn/40 bg-warn/5 px-1 font-mono text-[9px] uppercase tracking-wide text-warn">
          registry
        </span>
      ) : null}
      <span className="font-mono text-[10px] text-muted-foreground">{profile.model}</span>
    </div>
    <p className="mt-1 font-mono text-[10px] text-primary">
      effort:{profile.effort} · permissions:{profile.permissionMode}
    </p>
    {profile.forfeitedTools.length > 0 ? (
      <div className="mt-1 flex flex-col gap-0.5">
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
          Forfeited tools
        </span>
        <ul className="flex flex-wrap gap-1">
          {profile.forfeitedTools.map((tool) => (
            <li
              key={tool}
              className="rounded border border-error/30 bg-error/5 px-1 font-mono text-[10px] text-error/80"
            >
              {tool}
            </li>
          ))}
        </ul>
      </div>
    ) : (
      <p
        data-testid="primitive-full-surface"
        className="mt-1 font-mono text-[10px] text-done"
      >
        Full tool surface — no forfeited tools.
      </p>
    )}
  </li>
)

/** One run-history row — a step card face with task + Studio links. */
const RunRow = ({ run, idx }: { run: PrimitiveRun; idx: number }) => {
  const entry = primitiveRunToCard(run, idx)
  return (
    <li
      data-testid="primitive-run-row"
      data-outcome={entry.outcome}
      className="flex flex-wrap items-center gap-2 rounded border border-primary/20 px-2 py-1.5"
    >
      <StepStatusIcon outcome={entry.outcome} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-xs font-semibold text-foreground">{entry.stepName}</span>
          {entry.workerName != null ? (
            <span className="font-mono text-[10px] text-muted-foreground">{entry.workerName}</span>
          ) : null}
          {entry.claudeSessionId != null ? (
            <span
              className="font-mono text-[10px] text-muted-foreground"
              title={entry.claudeSessionId}
            >
              session:{entry.claudeSessionId.slice(0, 8)}
            </span>
          ) : null}
        </div>
        <p className="font-mono text-[10px] text-muted-foreground">
          {relativeTime(entry.startedAt)}
          {entry.durationMs != null ? ` · ${formatDuration(entry.durationMs)}` : ''}
        </p>
      </div>
      {run.taskId !== null ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <a
            href={taskHash(run.taskId)}
            data-testid="primitive-run-task-link"
            className="rounded border border-primary/30 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10"
          >
            task →
          </a>
          <a
            href={studioHash(run.taskId)}
            data-testid="primitive-run-studio-link"
            className="rounded border border-primary/30 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10"
          >
            studio →
          </a>
        </span>
      ) : null}
    </li>
  )
}

// ── Drawer ────────────────────────────────────────────────────────────────────

export interface PrimitiveDetailDrawerProps {
  /** Primitive name parsed from `#/primitive/<name>`. */
  name: PrimitiveName
  /** Clears the `#/primitive/<name>` hash so the drawer closes. */
  onClose: () => void
  /**
   * Pre-loaded facet payload. When provided the fetch is skipped entirely
   * (test / static-rendering seam). Omit in production.
   */
  detail?: PrimitiveDetail
  /** Override the fetcher in tests. Production callers omit it. */
  fetchImpl?: typeof fetch
}

export const PrimitiveDetailDrawer = ({
  name,
  onClose,
  detail: seededDetail,
  fetchImpl,
}: PrimitiveDetailDrawerProps) => {
  const drawerRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)

  const query = usePrimitiveDetail(name, seededDetail === undefined, fetchImpl)
  const detail = seededDetail ?? query.detail

  /** Exit animation (180 ms) then the onClose prop — mirrors the proposal drawer. */
  const handleClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose(), 180)
  }, [onClose])

  // Focus management: move focus in on open, restore on close.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    drawerRef.current?.focus()
    return () => {
      prev?.focus?.()
    }
  }, [])

  // Escape-to-close + Tab focus trap (identical to ProposalDetailDrawer).
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

  const successRate = detail !== undefined ? windowSuccessRate(detail.runs) : null

  return (
    <>
      {/* Scrim — below the drawer's z-50 so clicks outside dismiss the panel */}
      <div
        data-testid="primitive-detail-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 bg-foreground/40"
        onClick={handleClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Primitive detail"
        data-testid="primitive-detail-drawer"
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        className="drawer-panel fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-primary/40 bg-background shadow-2xl outline-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-primary/40 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h2
              data-testid="primitive-detail-title"
              className="break-words font-mono text-sm font-semibold text-foreground"
            >
              {name}
            </h2>
            {detail !== undefined ? (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  data-testid="primitive-detail-executor"
                  className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-primary"
                >
                  {executorLabel(detail.primitive.executor)}
                </span>
                {detail.primitive.phase !== null ? (
                  <span
                    data-testid="primitive-detail-phase"
                    className="rounded border border-primary/30 px-1 font-mono text-[10px] text-muted-foreground"
                  >
                    phase:{detail.primitive.phase}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close primitive detail"
            data-testid="primitive-detail-close"
            className="shrink-0 rounded border border-primary/40 px-2 py-0.5 font-mono text-xs text-primary hover:bg-primary/10"
          >
            Close
          </button>
        </header>

        <div className="flex flex-1 flex-col overflow-y-auto">
          {detail === undefined ? (
            <div className="px-4 py-3">
              {query.error !== null ? (
                <p
                  data-testid="primitive-detail-error"
                  className="font-mono text-xs text-error/80"
                >
                  Could not load the primitive ({query.error.message}).
                </p>
              ) : (
                <SkeletonList rows={4} rowClassName="h-6 w-full mb-2" label="Loading primitive" />
              )}
            </div>
          ) : (
            <>
              {/* Identity */}
              <section
                data-testid="primitive-detail-description"
                className="border-b border-primary/40 px-4 py-3"
              >
                <p className="font-mono text-xs leading-relaxed text-foreground">
                  {detail.primitive.description}
                </p>
              </section>

              {/* Tool surface — declared vs observed vs human, never conflated */}
              <section
                data-testid="primitive-detail-tool-surface"
                className="border-b border-primary/40 px-4 py-3"
              >
                {detail.primitive.executor === 'agent' ? (
                  <>
                    <SectionLabel>
                      Tool surface — Worker Authorization profiles (declared)
                    </SectionLabel>
                    <ul className="flex flex-col gap-1.5">
                      {detail.workers.map((profile) => (
                        <WorkerProfileCard key={profile.workerName} profile={profile} />
                      ))}
                    </ul>
                  </>
                ) : detail.primitive.executor === 'shell' ? (
                  <>
                    <SectionLabel>Tool surface — observed shell tools (empirical)</SectionLabel>
                    {detail.observedTools.length > 0 ? (
                      <ul className="flex flex-wrap gap-1.5">
                        {detail.observedTools.map((t) => (
                          <li
                            key={t.tool}
                            data-testid="primitive-observed-tool"
                            title={`last invoked ${relativeTime(t.lastInvokedAt)}`}
                            className="rounded border border-primary/30 px-1.5 py-0.5 font-mono text-[11px] text-primary"
                          >
                            {t.tool} ×{t.count}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p
                        data-testid="primitive-no-observed-tools"
                        className="font-mono text-[11px] text-muted-foreground"
                      >
                        No shell tools observed in the trace window yet.
                      </p>
                    )}
                  </>
                ) : (
                  <p
                    data-testid="primitive-human-surface"
                    className="font-mono text-xs text-foreground"
                  >
                    Human step — no tool surface. It writes task state and raises an
                    action-queue row; nothing executes.
                  </p>
                )}

                {detail.caveats.length > 0 ? (
                  <ul data-testid="primitive-caveats" className="mt-2 flex flex-col gap-1">
                    {detail.caveats.map((caveat) => (
                      <li
                        key={caveat}
                        className="rounded border border-warn/40 bg-warn/5 px-2 py-1 font-mono text-[10px] leading-relaxed text-warn"
                      >
                        {caveat}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              {/* Run history — Step spans (or parks for awaitHuman) */}
              <section
                data-testid="primitive-detail-history"
                className="px-4 py-3"
              >
                {detail.primitive.executor === 'human' ? (
                  <>
                    <SectionLabel>Parks — awaiting-human rows, not Step spans</SectionLabel>
                    {detail.parks.length > 0 ? (
                      <ul className="flex flex-col gap-1.5">
                        {detail.parks.map((park, i) => (
                          <li
                            key={`${park.taskId ?? 'unknown'}-${park.parkedAt}-${i}`}
                            data-testid="primitive-park-row"
                            className="flex flex-wrap items-center gap-2 rounded border border-primary/20 px-2 py-1.5"
                          >
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <div className="flex flex-wrap items-baseline gap-2">
                                {park.taskId !== null ? (
                                  <a
                                    href={taskHash(park.taskId)}
                                    className="font-mono text-xs font-semibold text-foreground hover:underline"
                                  >
                                    {park.taskId}
                                  </a>
                                ) : (
                                  <span className="font-mono text-xs text-muted-foreground">unknown task</span>
                                )}
                                {park.stepName !== null ? (
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    step:{park.stepName}
                                  </span>
                                ) : null}
                              </div>
                              <p className="font-mono text-[10px] text-muted-foreground">
                                parked {relativeTime(park.parkedAt)}
                                {park.leaseOwner !== null ? ` · lease:${park.leaseOwner}` : ''}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p
                        data-testid="primitive-no-parks"
                        className="font-mono text-[11px] text-muted-foreground"
                      >
                        No parks recorded.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <SectionLabel>Run history — Step spans (last {detail.window})</SectionLabel>
                    {detail.runs.length > 0 ? (
                      <>
                        <p
                          data-testid="primitive-history-aggregates"
                          className="mb-2 font-mono text-[10px] text-muted-foreground"
                        >
                          {detail.runs.length} run{detail.runs.length !== 1 ? 's' : ''} in window
                          {successRate !== null ? ` · ${successRate}% success` : ''} — last{' '}
                          {detail.window} runs only, not all-time
                        </p>
                        <ul className="flex flex-col gap-1.5">
                          {detail.runs.map((run, i) => (
                            <RunRow
                              key={`${run.workflowInstanceId}-${run.stepName}-${i}`}
                              run={run}
                              idx={i}
                            />
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p
                        data-testid="primitive-no-runs"
                        className="font-mono text-[11px] text-muted-foreground"
                      >
                        No Step spans recorded in the trace window yet.
                      </p>
                    )}
                  </>
                )}
              </section>
              <StewardLedgerPanel targetKind="primitive" targetId={name} />
            </>
          )}
        </div>

        {/* Sibling primitives — code-pinned names, no fetch needed */}
        <nav
          aria-label="Other primitives"
          className="border-t border-primary/40 px-4 py-3"
        >
          <SectionLabel>Primitives</SectionLabel>
          <ul className="flex flex-wrap gap-1.5">
            {PRIMITIVE_NAMES.map((sibling) =>
              sibling === name ? (
                <li
                  key={sibling}
                  aria-current="page"
                  className="rounded border border-primary/60 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground"
                >
                  {sibling}
                </li>
              ) : (
                <li key={sibling}>
                  <a
                    href={primitiveHash(sibling)}
                    data-testid="primitive-sibling-link"
                    className="block rounded border border-primary/30 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10"
                  >
                    {sibling}
                  </a>
                </li>
              ),
            )}
          </ul>
        </nav>
      </aside>
    </>
  )
}
