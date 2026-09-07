/**
 * ReflectionsPage — list and detail view for arc reflection reports.
 *
 * Arc reflections are the most expensive analysis the product performs.
 * Each report contains:
 *   - a summary and root cause at the top (headline, not buried)
 *   - dissonant calls ordered by severity (high before low)
 *   - verify mismatches and thrashing patterns
 *   - tool-call statistics as a compact breakdown
 *   - suggestions that were filed as proposals (linked to the proposal drawer),
 *     each showing its lever binding (id + family + gesture) or declared gap,
 *     or explicitly marked as unbound (predates the binding feature)
 *
 * Lever changes render as actionable controls — not reports. Each bound finding
 * shows a single apply button labelled with the transition (`id: old → new`).
 * Global levers that need a daemon reload show a confirmation step naming the
 * blast radius (in-flight count). Lever gaps are visually distinct and carry no
 * apply control.
 *
 * The page states when reflection last ran and what would trigger the next run,
 * so the surface is honest about whether anything feeds it.
 *
 * Reachable at #/reflections (list) and #/reflections/<originId> (detail).
 * Renders on cold load — no click or SSE event required.
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchDeepReflections, fetchDeepReflection, applyLever } from '@/shared/api'
import type {
  DeepReflectionSummary,
  DeepReflectionDetail,
  DeepReflectionsListResponse,
  ReflectionDissonantCall,
} from '@/shared/api'
import { useFocusedProject } from '@/shared/useFocusedProject'
import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonList } from '@/components/Skeleton'
import { CopyButton } from '@/components/CopyButton'
import { parseReflectionDetailRoute, reflectionDetailHash, proposalHash } from '@/shared/routing'
import { useHashRoute } from '@/shared/useHashRoute'
import { formatAbsoluteDateTime } from '@/shared/time'
import { PageHeader, SectionLabel } from '@/widgets/primitives/DensityPrimitives'

// ---------------------------------------------------------------------------
// Outcome types (mirrored from the server-side ReflectionSuggestionOutcome)
// ---------------------------------------------------------------------------

export interface LeverApplyHistoryEntry {
  appliedAt: string
  leverId: string
  fromValue: string | null
  toValue: string
  findingId?: string
}

export interface LeverData {
  id: string
  family: string
  scope: string
  currentValue: string | null
  proposedValue: string
  gesture: string | null
  appliesWithoutRestart: boolean
  history: LeverApplyHistoryEntry[]
}

type SuggestionOutcome =
  | { type: 'lever'; lever: LeverData }
  | { type: 'leverGap'; leverGap: { proposedLeverId: string; family: string; whatItWouldControl: string } }
  | null

// ---------------------------------------------------------------------------
// Per-lever apply state (managed by ReflectionDetailView)
// ---------------------------------------------------------------------------

export type LeverApplyState =
  | { status: 'idle' }
  | { status: 'applying' }
  | { status: 'applied'; appliedAt: string; appliedValue: string }
  | { status: 'error'; error: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmtRelative = (iso: string | null): string => {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 2) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

/** Sort dissonant calls: high → medium → low → other. */
const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }
const sortBySeverity = (calls: ReflectionDissonantCall[]): ReflectionDissonantCall[] =>
  [...calls].sort((a, b) => {
    const ao = SEVERITY_ORDER[a.severity] ?? 3
    const bo = SEVERITY_ORDER[b.severity] ?? 3
    return ao - bo
  })

const severityClass = (severity: string): string => {
  if (severity === 'high') return 'text-error'
  if (severity === 'medium') return 'text-warn'
  return 'text-muted-foreground'
}

const severityLabel = (severity: string): string =>
  severity.charAt(0).toUpperCase() + severity.slice(1)

// ---------------------------------------------------------------------------
// Outcome chip — shows lever binding (id + gesture) or declared gap, or
// renders an explicit "unbound" badge when no binding is present.
// ---------------------------------------------------------------------------

interface OutcomeTagProps {
  outcome: SuggestionOutcome
}

const OutcomeTag = ({ outcome }: OutcomeTagProps) => {
  if (outcome == null) {
    return (
      <div
        data-testid="outcome-unbound"
        className="mt-2 border border-primary/20 bg-card px-2 py-1 font-mono text-micro text-muted-foreground inline-flex items-center gap-1"
      >
        <span className="uppercase tracking-wide">No lever binding</span>
        <span className="text-micro">(predates binding feature)</span>
      </div>
    )
  }
  if (outcome.type === 'lever') {
    const { id, family, currentValue, proposedValue, gesture } = outcome.lever
    return (
      <div
        data-testid="outcome-lever"
        className="mt-2 border border-primary/30 bg-primary/5 px-2 py-1 font-mono text-micro"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="uppercase tracking-wide text-muted-foreground">Lever</span>
          <span className="text-primary font-semibold">{id}</span>
          <span className="text-muted-foreground text-micro uppercase">{family}</span>
          {currentValue !== null && (
            <>
              <span className="text-muted-foreground">{currentValue}</span>
              <span className="text-muted-foreground">→</span>
            </>
          )}
          <span className="text-foreground">{proposedValue}</span>
        </div>
        {gesture && (
          <div className="mt-1 text-micro text-foreground">
            <span className="text-muted-foreground uppercase tracking-wide text-micro">Gesture: </span>
            <code className="text-primary">{gesture}</code>
          </div>
        )}
      </div>
    )
  }
  // leverGap
  const { proposedLeverId, family, whatItWouldControl } = outcome.leverGap
  return (
    <div
      data-testid="outcome-lever-gap"
      className="mt-2 border border-warn/30 bg-warn/5 px-2 py-1 font-mono text-micro"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="uppercase tracking-wide text-warn">Lever Gap</span>
        <span className="text-foreground font-semibold">{proposedLeverId}</span>
        <span className="text-muted-foreground text-micro uppercase">{family}</span>
      </div>
      <div className="mt-1 text-micro text-muted-foreground">{whatItWouldControl}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LeverChangeCard — one actionable lever binding.
//
// Exported for direct unit testing: render it with a specific `applyState` and
// `showConfirm` value to assert the static markup without a DOM environment.
// ---------------------------------------------------------------------------

export interface LeverChangeCardProps {
  lever: LeverData
  applyState: LeverApplyState
  showConfirm: boolean
  /** In-flight task count — needed only when scope=global and !appliesWithoutRestart. */
  inFlightCount: number
  index: number
  proposalTargetId?: string | null
  /** Called when the operator clicks the apply button (per-task) or the confirm button (global). */
  onApply: () => void
  /** Called when the operator clicks the apply button on a global lever (shows confirmation first). */
  onRequestConfirm: () => void
  /** Called when the operator cancels the confirmation. */
  onCancelConfirm: () => void
}

export const LeverChangeCard = ({
  lever,
  applyState,
  showConfirm,
  inFlightCount,
  index,
  proposalTargetId,
  onApply,
  onRequestConfirm,
  onCancelConfirm,
}: LeverChangeCardProps) => {
  const isGlobal = lever.scope === 'global'
  const needsRestart = !lever.appliesWithoutRestart
  const transitionLabel = `${lever.id}: ${lever.currentValue ?? '(unset)'} → ${lever.proposedValue}`

  return (
    <div
      data-testid={`lever-change-${index}`}
      className="border border-primary/30 bg-primary/5 p-2 font-mono text-label"
    >
      {/* Header: id + family + optional proposal link */}
      <div className="flex items-center gap-2 mb-1">
        <span data-testid={`lever-change-id-${index}`} className="text-primary font-semibold">{lever.id}</span>
        <span className="text-muted-foreground text-micro uppercase">{lever.family}</span>
        <span className="text-muted-foreground text-micro">{lever.scope}</span>
        {proposalTargetId && (
          <a
            href={proposalHash(proposalTargetId, 'reflections')}
            className="ml-auto text-micro text-muted-foreground hover:text-primary transition-colors"
          >
            → proposal {proposalTargetId}
          </a>
        )}
      </div>

      {/* Transition */}
      <div className="flex items-center gap-2 text-micro mt-1">
        <span className="text-muted-foreground">{lever.currentValue ?? '(unset)'}</span>
        <span className="text-muted-foreground">→</span>
        <span data-testid={`lever-change-proposed-${index}`} className="text-foreground font-semibold">{lever.proposedValue}</span>
      </div>

      {/* Gesture (read-only reference) */}
      {lever.gesture && (
        <div className="mt-1">
          <span className="text-micro uppercase tracking-wide text-muted-foreground">CLI: </span>
          <code data-testid={`lever-change-gesture-${index}`} className="text-primary select-all">{lever.gesture}</code>
        </div>
      )}

      {/* Apply state: idle → show apply button or confirmation */}
      {applyState.status === 'idle' && !showConfirm && (
        <div className="mt-2 border-t border-primary/10 pt-2">
          {isGlobal ? (
            // Global levers: click opens confirmation step first
            <button
              data-testid={`lever-apply-btn-${index}`}
              onClick={onRequestConfirm}
              className="border border-primary/50 bg-primary/10 px-2 py-1 text-micro text-primary hover:bg-primary/20 focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
              aria-label={`Apply ${transitionLabel} (requires confirmation)`}
            >
              {transitionLabel}
            </button>
          ) : (
            // Per-task / per-workflow levers: apply directly, no confirmation
            <button
              data-testid={`lever-apply-btn-${index}`}
              onClick={onApply}
              className="border border-primary/50 bg-primary/10 px-2 py-1 text-micro text-primary hover:bg-primary/20 focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
              aria-label={`Apply ${transitionLabel}`}
            >
              {transitionLabel}
            </button>
          )}
        </div>
      )}

      {/* Confirmation step for global levers */}
      {applyState.status === 'idle' && showConfirm && (
        <div
          data-testid={`lever-confirm-${index}`}
          className="mt-2 border border-warn/40 bg-warn/5 p-2 text-micro"
          role="alertdialog"
          aria-label={`Confirm applying ${lever.id} globally`}
        >
          <div className="text-warn font-semibold mb-1">
            Apply globally: {transitionLabel}
          </div>
          <div className="text-muted-foreground mb-1">
            This lever has <strong>global scope</strong> — it affects every future task.
          </div>
          {needsRestart && (
            <div
              data-testid={`lever-confirm-blast-radius-${index}`}
              className="text-error text-micro mb-1"
            >
              ⚠ Requires daemon reload — this will hard-stop{' '}
              <strong>{inFlightCount} in-flight task{inFlightCount !== 1 ? 's' : ''}</strong>{' '}
              and re-queue them.
            </div>
          )}
          {!needsRestart && (
            <div className="text-muted-foreground text-micro mb-1">
              Takes effect without a daemon restart.
            </div>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button
              data-testid={`lever-confirm-apply-btn-${index}`}
              onClick={onApply}
              className="border border-warn/50 bg-warn/10 px-2 py-1 text-micro text-warn hover:bg-warn/20 focus:outline-none focus:ring-1 focus:ring-warn transition-colors"
              aria-label={`Confirm: ${transitionLabel}`}
            >
              Confirm: {transitionLabel}
            </button>
            <button
              data-testid={`lever-confirm-cancel-btn-${index}`}
              onClick={onCancelConfirm}
              className="border border-primary/20 px-2 py-1 text-micro text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
              aria-label="Cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Applying in progress */}
      {applyState.status === 'applying' && (
        <div
          data-testid={`lever-applying-${index}`}
          className="mt-2 border-t border-primary/10 pt-2 text-micro text-muted-foreground"
          aria-live="polite"
        >
          Applying…
        </div>
      )}

      {/* Applied successfully */}
      {applyState.status === 'applied' && (
        <div
          data-testid={`lever-applied-${index}`}
          className="mt-2 border-t border-success/20 pt-2 text-micro text-success"
          aria-live="polite"
        >
          ✓ Applied: {applyState.appliedValue} at {formatAbsoluteDateTime(applyState.appliedAt)}
        </div>
      )}

      {/* Failed apply — surface error and keep the finding actionable */}
      {applyState.status === 'error' && (
        <div
          data-testid={`lever-apply-error-${index}`}
          className="mt-2 border border-error/30 bg-error/5 p-2 text-micro"
          role="alert"
          aria-live="assertive"
        >
          <div className="text-error font-semibold mb-1">Apply failed</div>
          <div className="text-error">{applyState.error}</div>
          <div className="mt-1">
            {isGlobal ? (
              <button
                data-testid={`lever-retry-btn-${index}`}
                onClick={onRequestConfirm}
                className="border border-primary/50 bg-primary/10 px-2 py-1 text-micro text-primary hover:bg-primary/20 focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
              >
                Try again: {transitionLabel}
              </button>
            ) : (
              <button
                data-testid={`lever-retry-btn-${index}`}
                onClick={onApply}
                className="border border-primary/50 bg-primary/10 px-2 py-1 text-micro text-primary hover:bg-primary/20 focus:outline-none focus:ring-1 focus:ring-primary transition-colors"
              >
                Try again: {transitionLabel}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Apply history — shows prior applications of this lever */}
      {lever.history.length > 0 && applyState.status !== 'applied' && (
        <div
          data-testid={`lever-history-${index}`}
          className="mt-2 border-t border-primary/10 pt-1 text-micro text-muted-foreground"
        >
          Last applied: {fmtRelative(lever.history[0].appliedAt)}
          {lever.history[0].fromValue !== null && (
            <> ({lever.history[0].fromValue} → {lever.history[0].toValue})</>
          )}
          {lever.history.length > 1 && <> · {lever.history.length} total applications</>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LeverGapCard — clearly NOT an actionable control.
// Must be visually and semantically distinct from LeverChangeCard.
// ---------------------------------------------------------------------------

export interface LeverGapCardProps {
  gap: { proposedLeverId: string; family: string; whatItWouldControl: string }
  index: number
}

export const LeverGapCard = ({ gap, index }: LeverGapCardProps) => (
  <div
    data-testid={`lever-gap-${index}`}
    className="border border-warn/30 bg-warn/5 p-2 font-mono text-label"
    aria-label={`Lever gap: no parameter controls ${gap.proposedLeverId}`}
  >
    <div className="flex items-center gap-2">
      <span className="uppercase font-semibold text-warn text-micro tracking-wide">Lever Gap</span>
      <span className="text-foreground font-semibold">{gap.proposedLeverId}</span>
      <span className="text-muted-foreground text-micro uppercase">{gap.family}</span>
    </div>
    <div className="mt-1 text-micro text-muted-foreground">{gap.whatItWouldControl}</div>
    {/* Explicit "no apply control" statement — cannot be confused with a bound finding */}
    <div
      data-testid={`lever-gap-no-control-${index}`}
      className="mt-1 border border-warn/20 bg-warn/5 px-2 py-1 text-micro text-warn"
      role="note"
    >
      Not configurable
    </div>
  </div>
)

// ---------------------------------------------------------------------------
// RunState banner — when did reflection last run, what triggers the next?
// ---------------------------------------------------------------------------

interface RunStateBannerProps {
  autoRunReflect: 'on' | 'off'
  autoEnqueue: boolean
  lastReflectedAt: string | null
  /**
   * The arc this banner is scoped to, when known (detail view only — the
   * list view spans every arc, so there is no single command to offer).
   * When present, the manual-trigger message swaps its `<originId>`
   * placeholder for a real, copyable `mars arc reflect <originId>` command
   * instead of prose the operator has to retype by hand.
   */
  originId?: string | null
}

const RunStateBanner = ({ autoRunReflect, autoEnqueue, lastReflectedAt, originId = null }: RunStateBannerProps) => {
  const lastRan = lastReflectedAt ? `Last reflection: ${formatAbsoluteDateTime(lastReflectedAt)} (${fmtRelative(lastReflectedAt)})` : 'No reflection has run yet.'
  const needsManualTrigger = autoRunReflect === 'off' || !autoEnqueue
  const triggerLabel =
    autoRunReflect === 'off'
      ? 'auto-reflect is OFF — reflection will not run automatically.'
      : autoEnqueue
        ? 'auto-reflect is ON and auto-trigger is ON — reflection runs automatically after each arc.'
        : 'auto-reflect is ON but auto-trigger is OFF — reflection must be triggered manually.'
  const reflectCmd = originId ? `mars arc reflect ${originId}` : null

  return (
    <div
      data-testid="run-state-banner"
      className="border border-primary/20 bg-card p-3 font-mono text-label"
    >
      <span className="text-muted-foreground">{lastRan}</span>
      {' · '}
      <span className={autoRunReflect === 'on' && autoEnqueue ? 'text-success' : 'text-warn'}>
        {triggerLabel}
      </span>
      {needsManualTrigger && (
        <>
          {' '}
          {reflectCmd ? (
            <span className="inline-flex items-center gap-1.5 align-middle">
              Run manually:
              <CopyButton
                text={reflectCmd}
                label={reflectCmd}
                aria-label={`Copy ${reflectCmd}`}
                className="rounded border border-primary/30 px-1.5 py-0.5 font-mono text-micro text-primary/70 hover:bg-primary/10 hover:text-primary"
              />
            </span>
          ) : (
            <>
              Enable it with <code>mars operator set auto-reflect on</code>.
            </>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

interface ReflectionRowProps {
  report: DeepReflectionSummary
}

const statusClass = (status: string): string => {
  if (status === 'complete') return 'text-success'
  if (status === 'pending') return 'text-warn'
  return 'text-error'
}

const statusLabel = (status: string): string => {
  if (status === 'complete') return 'Complete'
  if (status === 'pending') return 'Pending'
  if (!status || status === 'unknown' || status === 'UNKNOWN') return 'In progress'
  // Capitalise and replace underscores/hyphens with spaces
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/[_-]/g, ' ')
}

const ReflectionRow = ({ report }: ReflectionRowProps) => (
  <a
    href={reflectionDetailHash(report.originId, report.recordedAt)}
    data-testid={`reflection-row-${report.originId}`}
    className="flex flex-col gap-1 border border-primary/20 bg-card p-3 hover:border-primary/50 hover:bg-card/80 transition-colors"
  >
    <div className="flex items-center gap-2">
      <span className="font-mono text-label text-foreground truncate flex-1">
        {formatAbsoluteDateTime(report.recordedAt)}
      </span>
      <span className={`font-mono text-micro ${statusClass(report.status)}`}>
        {statusLabel(report.status)}
      </span>
    </div>
    <div className="flex items-center gap-4 font-mono text-micro text-muted-foreground">
      <span>{report.originId}</span>
      {report.dissonantCallCount > 0 && (
        <span className="text-error">{report.dissonantCallCount} dissonant</span>
      )}
      {report.verifyMismatchCount > 0 && (
        <span className="text-warn">{report.verifyMismatchCount} verify mismatch{report.verifyMismatchCount !== 1 ? 'es' : ''}</span>
      )}
      {report.thrashingPatternCount > 0 && (
        <span>{report.thrashingPatternCount} thrashing</span>
      )}
      <span>{report.totalToolCalls.toLocaleString()} tool call{report.totalToolCalls !== 1 ? 's' : ''}</span>
      {report.verdictResult.saved > 0 && (
        <span className="text-primary">{report.verdictResult.saved} saved</span>
      )}
    </div>
  </a>
)

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

interface DissonantCallCardProps {
  call: ReflectionDissonantCall
  index: number
}

const DissonantCallCard = ({ call, index }: DissonantCallCardProps) => (
  <div
    data-testid={`dissonant-call-${index}`}
    className="border border-primary/20 bg-card p-3 font-mono text-label"
  >
    <div className="flex items-center gap-2 mb-1">
      <span className={`uppercase font-semibold ${severityClass(call.severity)}`}>
        {severityLabel(call.severity)}
      </span>
      <span className="text-muted-foreground">·</span>
      <span className="text-primary">{call.tool}</span>
      {call.taskId && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">task {call.taskId} · event #{call.eventIndex}</span>
        </>
      )}
    </div>
    <div className="grid grid-cols-2 gap-2 mt-2">
      <div>
        <div className="text-micro uppercase tracking-wide text-muted-foreground mb-1">Stated intent</div>
        <div className="text-foreground">{call.statedIntent}</div>
      </div>
      <div>
        <div className="text-micro uppercase tracking-wide text-muted-foreground mb-1">Actual outcome</div>
        <div className="text-foreground">{call.actualOutcome}</div>
      </div>
    </div>
    {call.evidence && (
      <div className="mt-2 text-micro text-muted-foreground border-t border-primary/10 pt-2">
        <span className="uppercase tracking-wide">Evidence:</span>{' '}
        {call.evidence}
      </div>
    )}
  </div>
)

export interface ReflectionDetailViewProps {
  detail: DeepReflectionDetail
}

export const ReflectionDetailView = ({ detail }: ReflectionDetailViewProps) => {
  const sortedCalls = detail.report ? sortBySeverity(detail.report.dissonantCalls) : []
  const byNameEntries: Array<[string, number]> = detail.report
    ? (Object.entries(detail.report.toolCallStats.byName) as Array<[string, number]>)
        .sort(([, a], [, b]) => b - a)
    : []

  // Saved proposals with a proposal link — shown in "Proposals Filed" for non-lever suggestions.
  const savedSuggestions = detail.report?.suggestions.filter(
    (s) => s.verdict === 'save' && s.targetId && s.outcome?.type !== 'lever',
  ) ?? []

  // Lever bindings — rendered regardless of targetId; targetId only adds a proposal link.
  const leverBindings = (detail.report?.suggestions ?? [])
    .filter((s): s is typeof s & { outcome: NonNullable<typeof s.outcome> & { type: 'lever' } } =>
      s.outcome != null && s.outcome.type === 'lever'
    )

  // Aggregate lever gaps across all suggestions in this arc (not just saved ones).
  const leverGaps = (detail.report?.suggestions ?? [])
    .filter((s): s is typeof s & { outcome: NonNullable<typeof s.outcome> & { type: 'leverGap' } } =>
      s.outcome != null && s.outcome.type === 'leverGap'
    )
    .map((s) => (s.outcome as { type: 'leverGap'; leverGap: { proposedLeverId: string; family: string; whatItWouldControl: string } }).leverGap)

  // ── Per-lever apply state ────────────────────────────────────────────────
  // One entry per leverBinding index. Start idle. State persists across renders
  // but is scoped to this detail view instance (fresh on each navigation).
  const [applyStates, setApplyStates] = useState<LeverApplyState[]>(
    () => leverBindings.map(() => ({ status: 'idle' as const })),
  )
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null)

  const setApplyState = (idx: number, state: LeverApplyState) => {
    setApplyStates((prev) => {
      const next = [...prev]
      next[idx] = state
      return next
    })
  }

  const handleApply = (idx: number, lever: LeverData, findingId: string | null) => {
    setApplyState(idx, { status: 'applying' })
    setConfirmIndex(null)
    applyLever(lever.id, lever.proposedValue, findingId ?? undefined)
      .then((result) => {
        setApplyState(idx, {
          status: 'applied',
          appliedAt: result.appliedAt,
          appliedValue: result.appliedValue,
        })
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setApplyState(idx, { status: 'error', error: msg })
      })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header: run state */}
      <RunStateBanner
        autoRunReflect={detail.autoRunReflect}
        autoEnqueue={detail.autoEnqueue}
        lastReflectedAt={detail.recordedAt}
        originId={detail.originId}
      />

      {/* Origin and metadata */}
      <div className="border border-primary/20 bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-micro uppercase tracking-wide text-muted-foreground mb-1">Arc</div>
            <div className="font-mono text-body text-foreground break-all">{detail.originId}</div>
          </div>
          <div className="text-right shrink-0">
            <div className={`font-mono text-label font-semibold ${statusClass(detail.status)}`}>
              {statusLabel(detail.status)}
            </div>
            <div className="font-mono text-micro text-muted-foreground">{formatAbsoluteDateTime(detail.recordedAt)}</div>
          </div>
        </div>
        {detail.status !== 'complete' && (
          <div
            data-testid="non-complete-notice"
            className="mt-3 border border-warn/30 bg-warn/5 p-2 font-mono text-label text-warn"
          >
            This report has status <strong>{statusLabel(detail.status)}</strong> — the full report body is not yet available.
          </div>
        )}
      </div>

      {detail.report !== null ? (
        <>
          {/* Summary + root cause — the headline, not buried */}
          <section>
            <div className="mb-2"><SectionLabel>Summary</SectionLabel></div>
            <p className="font-mono text-body text-foreground leading-relaxed border border-primary/20 bg-card p-3">
              {detail.report.summary}
            </p>
          </section>

          <section>
            <div className="mb-2"><SectionLabel>Root Cause</SectionLabel></div>
            <p className="font-mono text-label text-primary border border-primary/30 bg-primary/5 p-3 leading-relaxed">
              {detail.report.rootCause}
            </p>
          </section>

          {/* Dissonant calls — ordered by severity, intent vs outcome side-by-side */}
          {sortedCalls.length > 0 && (
            <section>
              <div className="mb-2"><SectionLabel>Dissonant Calls ({sortedCalls.length})</SectionLabel></div>
              <div className="flex flex-col gap-2">
                {sortedCalls.map((call, i) => (
                  <DissonantCallCard key={i} call={call} index={i} />
                ))}
              </div>
            </section>
          )}

          {/* Verify mismatches */}
          {detail.report.verifyMismatches.length > 0 && (
            <section>
              <div className="mb-2"><SectionLabel>Verify Mismatches ({detail.report.verifyMismatches.length})</SectionLabel></div>
              <div className="flex flex-col gap-2">
                {detail.report.verifyMismatches.map((mm, i) => (
                  <div
                    key={i}
                    data-testid={`verify-mismatch-${i}`}
                    className="border border-warn/30 bg-warn/5 p-3 font-mono text-label"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`uppercase font-semibold ${severityClass(mm.severity)}`}>
                        {severityLabel(mm.severity)}
                      </span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">task {mm.taskId}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      <div>
                        <div className="text-micro uppercase tracking-wide text-muted-foreground mb-1">Claimed</div>
                        <div className="text-foreground">{mm.claimed}</div>
                      </div>
                      <div>
                        <div className="text-micro uppercase tracking-wide text-muted-foreground mb-1">Actual</div>
                        <div className="text-foreground">{mm.actual}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Thrashing patterns */}
          {detail.report.thrashingPatterns.length > 0 && (
            <section>
              <div className="mb-2"><SectionLabel>Thrashing Patterns ({detail.report.thrashingPatterns.length})</SectionLabel></div>
              <div className="flex flex-col gap-2">
                {detail.report.thrashingPatterns.map((p, i) => (
                  <div
                    key={i}
                    data-testid={`thrashing-pattern-${i}`}
                    className="border border-primary/20 bg-card p-3 font-mono text-label"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-foreground">{p.pattern}</span>
                      <span className="text-muted-foreground shrink-0">× {p.occurrences}</span>
                    </div>
                    <div className="text-micro text-muted-foreground">{p.evidence}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Tool call statistics — compact breakdown, not a raw object dump */}
          <section>
            <div className="mb-2"><SectionLabel>Tool Calls ({detail.report.toolCallStats.total.toLocaleString()} total)</SectionLabel></div>
            <div className="flex flex-wrap gap-2">
              {byNameEntries.map(([tool, count]) => (
                <div
                  key={tool}
                  className="border border-primary/20 bg-card px-2 py-1 font-mono text-label"
                >
                  <span className="text-primary">{tool}</span>
                  <span className="text-muted-foreground"> {count}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Filed proposals — link arc → proposals, with lever binding */}
          {savedSuggestions.length > 0 && (
            <section>
              <div className="mb-2"><SectionLabel>Proposals Filed ({savedSuggestions.length})</SectionLabel></div>
              <div className="flex flex-col gap-2">
                {savedSuggestions.map((s, i) => (
                  <div
                    key={i}
                    data-testid={`filed-proposal-${i}`}
                    className="border border-primary/20 bg-card p-2 font-mono text-label"
                  >
                    <a
                      href={proposalHash(s.targetId!, 'reflections')}
                      className="flex items-center gap-2 hover:text-primary transition-colors"
                    >
                      <span className="text-primary flex-1">{s.title}</span>
                      <span className="text-muted-foreground text-micro">→ proposal {s.targetId}</span>
                    </a>
                    <OutcomeTag outcome={s.outcome as SuggestionOutcome} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Lever Changes — knobs you can tune right now */}
          {leverBindings.length > 0 && (
            <section data-testid="lever-changes-section">
              <div className="mb-2"><SectionLabel>Lever Changes — what you can tune now ({leverBindings.length})</SectionLabel></div>
              <div className="flex flex-col gap-2">
                {leverBindings.map((s, i) => {
                  const lever = (s.outcome as { type: 'lever'; lever: LeverData }).lever
                  return (
                    <LeverChangeCard
                      key={i}
                      index={i}
                      lever={lever}
                      applyState={applyStates[i] ?? { status: 'idle' }}
                      showConfirm={confirmIndex === i}
                      inFlightCount={0}
                      proposalTargetId={s.targetId}
                      onApply={() => handleApply(i, lever, s.targetId ?? null)}
                      onRequestConfirm={() => setConfirmIndex(i)}
                      onCancelConfirm={() => setConfirmIndex(null)}
                    />
                  )
                })}
              </div>
            </section>
          )}

          {/* Lever Gaps — knobs Mars wishes it had */}
          {leverGaps.length > 0 && (
            <section data-testid="lever-gaps-section">
              <div className="mb-2"><SectionLabel>Lever Gaps — knobs Mars wishes it had ({leverGaps.length})</SectionLabel></div>
              <div className="flex flex-col gap-2">
                {leverGaps.map((gap, i) => (
                  <LeverGapCard key={i} gap={gap} index={i} />
                ))}
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const useDeepReflections = (projectId: string | null): {
  data: DeepReflectionsListResponse | undefined
  isLoading: boolean
  error: Error | null
} => {
  // Option (a) fallback: fire without project when registry is empty.
  const query = useQuery({
    queryKey: ['deep-reflections', projectId],
    queryFn: () => fetchDeepReflections(projectId ?? undefined),
    // Always enabled — renders on cold load, no click or SSE required.
    enabled: true,
  })
  return { data: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

const useDeepReflection = (originId: string | null, recordedAt: string | null, projectId: string | null): {
  data: DeepReflectionDetail | undefined
  isLoading: boolean
  error: Error | null
} => {
  const query = useQuery({
    queryKey: ['deep-reflection', originId, recordedAt, projectId],
    queryFn: () => fetchDeepReflection(originId!, recordedAt!, projectId ?? undefined),
    enabled: originId !== null && recordedAt !== null,
  })
  return { data: query.data, isLoading: query.isLoading, error: query.error as Error | null }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Reflection page — list view at #/reflections, detail view at
 * #/reflections/<originId>.
 *
 * The list loads on cold render with no user interaction required.
 */
export const ReflectionsPage = () => {
  const hash = useHashRoute()
  const { focusedProjectId: projectId, projectsSettled, projectsError, projects } = useFocusedProject()
  // Fire without ?project= when the registry is empty (no multi-project setup).
  const projectsEmpty = projectsSettled && projectsError === null && projects.length === 0
  const resolvedProjectId = projectId ?? (projectsEmpty ? undefined : null)

  const detailRoute = parseReflectionDetailRoute(hash)
  const isDetail = detailRoute !== null
  const originId = detailRoute?.originId ?? null
  const recordedAt = detailRoute?.recordedAt ?? null

  const { data: listData, isLoading: listLoading, error: listError } = useDeepReflections(resolvedProjectId ?? null)
  const { data: detailData, isLoading: detailLoading, error: detailError } = useDeepReflection(
    originId,
    recordedAt,
    resolvedProjectId ?? null,
  )

  if (listError) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background" data-testid="reflections-page">
        <FallbackSurface error={listError} of="reflections" variant="pane" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" data-testid="reflections-page">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {isDetail ? (
          // ── Detail view ──
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <a
                href="#/reflections"
                className="font-mono text-label text-primary hover:text-foreground"
              >
                ← Reflections
              </a>
            </div>

            {detailError ? (
              <FallbackSurface error={detailError} of="reflection detail" variant="inline" />
            ) : detailLoading || detailData === undefined ? (
              <div data-testid="detail-loading">
                <SkeletonList rows={3} rowClassName="h-16 w-full mb-3" label="Loading reflection detail" />
              </div>
            ) : (
              <ReflectionDetailView detail={detailData} />
            )}
          </div>
        ) : (
          // ── List view ──
          <div className="flex flex-col gap-3">
            <PageHeader
              title="Reflections"
              right={
                listData ? (
                  <span className="font-mono text-micro text-muted-foreground" data-testid="report-count">
                    {listData.totalDiscovered > listData.reports.length
                      ? `${listData.reports.length} of ${listData.totalDiscovered} reports`
                      : `${listData.reports.length} report${listData.reports.length !== 1 ? 's' : ''}`}
                    {listData.unreadableCount > 0 && (
                      <span className="ml-2 text-warn">
                        ({listData.unreadableCount} unreadable)
                      </span>
                    )}
                  </span>
                ) : undefined
              }
            />

            {listData && (
              <RunStateBanner
                autoRunReflect={listData.autoRunReflect}
                autoEnqueue={listData.autoEnqueue}
                lastReflectedAt={listData.lastReflectedAt}
              />
            )}

            {listLoading && listData === undefined ? (
              <div data-testid="list-loading">
                <SkeletonList rows={4} rowClassName="h-14 w-full mb-2" label="Loading reflections" />
              </div>
            ) : listData?.reports.length === 0 ? (
              <div
                data-testid="empty-state"
                className="font-mono text-label text-muted-foreground border border-primary/20 bg-card p-4 text-center"
              >
                No reports
              </div>
            ) : (
              <div className="flex flex-col gap-2" data-testid="reflection-list">
                {(listData?.reports ?? []).map((report) => (
                  <ReflectionRow key={`${report.originId}:${report.recordedAt}`} report={report} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
