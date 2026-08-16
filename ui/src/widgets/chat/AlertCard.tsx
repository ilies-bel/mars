/**
 * AlertCard — rich alert card shared between chat transcript alert segments
 * and action-queue row detail views.
 *
 * Design:
 *   - Headline: when `goal` (prompt excerpt) is present it becomes the primary
 *     heading so the operator sees WHAT the task was doing. A plain-language
 *     cause line (derived from the failure signature + error excerpt) sits below.
 *     When no goal is provided the humanSummary falls back to the headline.
 *   - entityId shown small/monospace as metadata beneath the headline.
 *   - "Details ▸" expander revealing humanDetail as labeled fields.
 *   - "Output ▸" expander showing the last ~3 lines of verify output when
 *     errorExcerpt is present — enough context to make a decision in place.
 *   - Verb buttons from the recipe (styles respected).
 *   - Per-task primary action (e.g. Continue); optional secondary bulk action
 *     ("Continue all N") rendered as visually secondary when provided.
 *   - Snooze verb opens a preset menu (1 h / 4 h / tomorrow / next week).
 *   - Snoozed cards render dimmed with "reappears in …" and a Restore option.
 *   - Resolution state shown inline after a verb succeeds.
 *   - NO Discuss button — the composer is the discussion path.
 */

import { useState } from 'react'
import { Response } from '@/components/ai-elements/response'
import { snoozeActionQueueItem, restoreSnoozedItem, postDecision } from '@/shared/api'
import { dispatchAlertVerb, verbButtonClass } from './alertVerbs'
import type { AlertHumanDetail, AlertVerb, Decision } from '@/shared/schemas'
import { taskHash, proposalHash } from '@/shared/routing'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND_ICON: Record<string, string> = {
  failed: '⚠️',
  'daemon-killed': '⛔',
  'stale-queued': '⏳',
  'stale-worktree': '🗑️',
  'draft-proposal': '💡',
  'awaiting-validation': '🔍',
  'arc-failed': '⛓️',
}

/** Left accent-bar + border tint per kind. */
const KIND_ACCENT: Record<string, string> = {
  failed: 'border-l-error',
  'daemon-killed': 'border-l-error',
  'stale-queued': 'border-l-warn',
  'arc-failed': 'border-l-error',
  'stale-worktree': 'border-l-warn',
  'awaiting-validation': 'border-l-trace-mars',
  'draft-proposal': 'border-l-success',
}

export type SnoozePreset = '1h' | '4h' | 'tomorrow-morning' | 'next-week'

const SNOOZE_PRESETS: { value: SnoozePreset; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: 'tomorrow-morning', label: 'Tomorrow morning' },
  { value: 'next-week', label: 'Next week' },
]

// ---------------------------------------------------------------------------
// Cause derivation
// ---------------------------------------------------------------------------

/** Step-prefix → human-readable phrase. */
const STEP_PHRASE: Record<string, string> = {
  verify: 'verify failed',
  code: 'coder failed',
  setup: 'setup failed',
  merge: 'merge failed',
  'behaviour-verify': 'behaviour check failed',
}

/**
 * Derive a plain-language cause string from the failure signature and error
 * excerpt.  Returns undefined when neither is available.
 *
 * Format: "verify failed: <last meaningful error line>" when an excerpt is
 * present, or "verify failed (verify/unclassified)" as a fallback.
 */
const deriveCause = (detail: AlertHumanDetail | undefined): string | undefined => {
  const sig = detail?.failureSignature
  if (!sig) return undefined
  const step = sig.split('/')[0] ?? ''
  const phrase = STEP_PHRASE[step] ?? (step ? `${step} failed` : 'failed')

  const excerpt = detail?.errorExcerpt ?? detail?.rawError
  if (excerpt) {
    const lastLine = excerpt
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .at(-1)
      ?.trim()
    if (lastLine && lastLine.length < 120) {
      return `${phrase}: ${lastLine}`
    }
  }

  // Fall back to the signature string
  return `${phrase} (${sig})`
}

// ---------------------------------------------------------------------------
// Verify output tail
// ---------------------------------------------------------------------------

/** Extract the last `n` non-empty lines from a multi-line string. */
const verifyTail = (text: string | undefined, n = 3): string | undefined => {
  if (!text?.trim()) return undefined
  const lines = text.trim().split('\n').filter((l) => l.trim())
  if (lines.length === 0) return undefined
  return lines.slice(-n).join('\n')
}

// ---------------------------------------------------------------------------
// Snooze helpers
// ---------------------------------------------------------------------------

/** Compute a human-readable "reappears in X" string for an ISO snoozeUntil. */
const reappearsIn = (snoozeUntilIso: string): string => {
  const ms = new Date(snoozeUntilIso).getTime() - Date.now()
  if (ms <= 0) return 'soon'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d} day${d === 1 ? '' : 's'}`
  }
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

// ---------------------------------------------------------------------------
// AlertCard props
// ---------------------------------------------------------------------------

export interface AlertCardProps {
  /**
   * Opaque action-queue row id used for snooze API calls (e.g. "abc123").
   * Pass the chat segment's entityId when the row id is unavailable — the server
   * will infer it.
   */
  itemId: string
  /** Entity id shown small/monospace as metadata beneath the headline. */
  entityId: string
  /** Kind key — drives the icon and accent color. */
  kind: string
  /**
   * Plain-language headline (humanSummary from the recipe). Used as the
   * primary headline when `goal` is absent; demoted to secondary/muted text
   * when `goal` (prompt excerpt) is present.
   */
  summary: string
  /** Structured detail fields revealed by the "Details ▸" expander. */
  detail?: AlertHumanDetail
  /** Ordered verb buttons from the per-kind recipe. */
  verbs: AlertVerb[]
  /** True once the underlying item is resolved/superseded. */
  resolved?: boolean
  /** ISO timestamp of snooze expiry — when set the card starts in snoozed state. */
  snoozeUntil?: string
  /**
   * The task's main goal / prompt excerpt — "what it was trying to achieve".
   * When present it becomes the PRIMARY headline and the humanSummary is
   * demoted to secondary text. Only the first line of the value is shown.
   */
  goal?: string
  /**
   * Server-defined decision buttons. One button is rendered per entry;
   * clicking POSTs the Decision's payload to its endpoint.
   * No client-side switch on failure kind needed — the server controls
   * which buttons appear.
   */
  decisions?: Decision[]
  /**
   * Secondary bulk action shown alongside the per-task verb buttons.
   * When provided a visually secondary button is rendered (e.g. "Continue all 5")
   * so the operator can act on a whole batch with one click.
   */
  bulkContinue?: {
    /** Button label — e.g. "Continue all 5". */
    label: string
    onAction: () => void
  }
}

// ---------------------------------------------------------------------------
// VerifyExcerpt — last lines of verify output in a collapsible section
// ---------------------------------------------------------------------------

const VerifyExcerpt = ({ tail }: { tail: string }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-[10px] text-primary/60 hover:text-primary transition-colors select-none"
        data-testid="alert-verify-output-toggle"
      >
        Output {open ? '▾' : '▸'}
      </button>
      {open && (
        <pre
          className="mt-1 max-h-28 overflow-y-auto rounded bg-primary/10 p-1.5 font-mono text-[10px] text-primary/80 whitespace-pre-wrap break-all"
          data-testid="alert-verify-output-panel"
        >
          {tail}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DetailExpander — the "Details ▸" collapsible section
// ---------------------------------------------------------------------------

const DetailExpander = ({ detail }: { detail: AlertHumanDetail }) => {
  const [open, setOpen] = useState(false)

  const hasContent =
    detail.failureSignature ??
    detail.branch ??
    detail.worktree ??
    detail.rawError ??
    detail.changelog

  if (!hasContent) return null

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-[10px] text-primary/60 hover:text-primary transition-colors select-none"
        data-testid="alert-detail-toggle"
      >
        Details {open ? '▾' : '▸'}
      </button>

      {open && (
        <dl
          className="mt-1.5 space-y-1"
          data-testid="alert-detail-panel"
        >
          {detail.failureSignature && (
            <div>
              <dt className="font-mono text-[9px] uppercase text-primary/40">Failure</dt>
              <dd className="font-mono text-[10px] text-primary">{detail.failureSignature}</dd>
            </div>
          )}
          {detail.branch && (
            <div>
              <dt className="font-mono text-[9px] uppercase text-primary/40">Branch</dt>
              <dd className="font-mono text-[10px] text-primary">{detail.branch}</dd>
            </div>
          )}
          {detail.worktree && (
            <div>
              <dt className="font-mono text-[9px] uppercase text-primary/40">Worktree</dt>
              <dd className="font-mono text-[10px] text-primary break-all">{detail.worktree}</dd>
            </div>
          )}
          {detail.rawError && (
            <div>
              <dt className="font-mono text-[9px] uppercase text-primary/40">Error</dt>
              <dd>
                <pre
                  className="mt-0.5 max-h-32 overflow-y-auto rounded bg-primary/10 p-1.5 font-mono text-[10px] text-primary/80 whitespace-pre-wrap break-all"
                  data-testid="alert-detail-raw-error"
                >
                  {detail.rawError}
                </pre>
              </dd>
            </div>
          )}
          {detail.changelog && (
            <div>
              <dt className="font-mono text-[9px] uppercase text-primary/40">Changelog</dt>
              <dd className="mt-0.5 chat-markdown prose prose-sm prose-invert max-w-none text-[11px]">
                <Response>{detail.changelog}</Response>
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SnoozeMenu — preset picker that drops down from the Snooze verb button
// ---------------------------------------------------------------------------

interface SnoozeMenuProps {
  onSelect: (preset: SnoozePreset) => void
  onClose: () => void
  disabled: boolean
}

const SnoozeMenu = ({ onSelect, onClose, disabled }: SnoozeMenuProps) => (
  <div
    className="absolute z-10 mt-1 rounded border border-primary/30 bg-card shadow-lg"
    data-testid="snooze-menu"
  >
    {SNOOZE_PRESETS.map(({ value, label }) => (
      <button
        key={value}
        type="button"
        disabled={disabled}
        onClick={() => onSelect(value)}
        className="block w-full px-4 py-1.5 text-left font-mono text-[11px] text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
        data-testid={`snooze-preset-${value}`}
      >
        {label}
      </button>
    ))}
    <button
      type="button"
      onClick={onClose}
      className="block w-full border-t border-primary/20 px-4 py-1.5 text-left font-mono text-[10px] text-primary/50 hover:bg-primary/10 transition-colors"
    >
      Cancel
    </button>
  </div>
)

// ---------------------------------------------------------------------------
// AlertCard
// ---------------------------------------------------------------------------

export const AlertCard = ({
  itemId,
  entityId,
  kind,
  summary,
  goal,
  detail,
  verbs,
  decisions = [],
  resolved = false,
  snoozeUntil: initialSnoozeUntil,
  bulkContinue,
}: AlertCardProps) => {
  const [pendingOp, setPendingOp] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [resolvedOp, setResolvedOp] = useState<string | null>(null)
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const [snoozedUntil, setSnoozedUntil] = useState<string | null>(
    initialSnoozeUntil ?? null,
  )
  const [teachPrompt, setTeachPrompt] = useState<{
    signature: string
    op: string
  } | null>(null)
  const [teachPending, setTeachPending] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)

  const isSnoozed = snoozedUntil !== null && new Date(snoozedUntil) > new Date()

  // Derive cause from detail when goal is present (task failure card).
  const cause = goal ? deriveCause(detail) : undefined

  // Derive verify output tail for the expandable section.
  const verifyOutputTail = goal
    ? verifyTail(detail?.errorExcerpt ?? detail?.rawError)
    : undefined

  const handleAction = async (op: string) => {
    if (pendingOp !== null) return
    setPendingOp(op)
    setActionError(null)
    try {
      await dispatchAlertVerb(itemId, entityId, op)
      setResolvedOp(op)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingOp(null)
    }
  }

  const handleSnoozeSelect = async (preset: SnoozePreset) => {
    setSnoozeMenuOpen(false)
    if (pendingOp !== null) return
    setPendingOp('snooze')
    setActionError(null)
    try {
      await snoozeActionQueueItem(itemId, preset)
      // Compute optimistic expiry for the dimmed state display.
      const now = Date.now()
      const durations: Record<SnoozePreset, number> = {
        '1h': 3_600_000,
        '4h': 14_400_000,
        'tomorrow-morning': msUntilTomorrowMorning(now),
        'next-week': msUntilNextWeekMonday(now),
      }
      setSnoozedUntil(new Date(now + durations[preset]).toISOString())
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingOp(null)
    }
  }

  const handleRestore = async () => {
    if (pendingOp !== null) return
    setPendingOp('restore')
    setActionError(null)
    try {
      await restoreSnoozedItem(itemId)
      setSnoozedUntil(null)
    } catch (err) {
      // If restore fails, still clear local snooze state so the card is usable.
      setSnoozedUntil(null)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingOp(null)
    }
  }

  const handleBulkContinue = async () => {
    if (bulkPending) return
    setBulkPending(true)
    try {
      await bulkContinue!.onAction()
    } finally {
      setBulkPending(false)
    }
  }

  const accentClass = KIND_ACCENT[kind] ?? 'border-l-iron'

  const entityHash =
    kind === 'draft-proposal'
      ? proposalHash(entityId, 'chat')
      : taskHash(entityId, 'chat')

  if (isSnoozed) {
    return (
      <div
        className={`my-2 rounded-lg border border-primary/20 border-l-4 ${accentClass} bg-card p-3 text-[12px] opacity-50`}
        data-testid="alert-card-snoozed"
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px]" aria-hidden="true">{KIND_ICON[kind] ?? '🔔'}</span>
          <span className="flex-1 font-mono text-[11px] text-primary/60 line-clamp-1">{goal?.split('\n')[0] ?? summary}</span>
          <span className="font-mono text-[10px] text-primary/40">
            reappears in {reappearsIn(snoozedUntil)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={pendingOp !== null}
            onClick={() => void handleRestore()}
            className="rounded border border-primary/30 px-2 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
            data-testid="alert-card-restore"
          >
            {pendingOp === 'restore' ? '…' : 'Restore'}
          </button>
          {actionError && (
            <span className="font-mono text-[10px] text-error">{actionError}</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={[
        'my-2 rounded-lg border border-l-4 p-3 text-[12px]',
        accentClass,
        resolved
          ? 'border-primary/20 bg-card opacity-60'
          : 'border-accent/30 bg-accent/5',
      ].join(' ')}
      data-testid="alert-card"
    >
      {/* Header: icon + headline + resolved badge */}
      <div className="mb-1 flex items-start gap-2">
        <span className="text-[13px] shrink-0 mt-0.5" aria-hidden="true">{KIND_ICON[kind] ?? '🔔'}</span>
        <div className="flex-1 min-w-0">
          {goal ? (
            <>
              {/* Primary headline: prompt excerpt (what the task was doing) */}
              <p
                className="font-mono text-[11px] font-semibold text-foreground line-clamp-2"
                data-testid="alert-card-goal"
              >
                {goal.split('\n')[0]?.trim()}
              </p>
              {/* Cause: plain-language failure reason */}
              {cause && (
                <p className="mt-0.5 font-mono text-[10px] text-primary/70" data-testid="alert-card-cause">
                  {cause}
                </p>
              )}
              {/* humanSummary demoted to secondary/muted text */}
              {summary && (
                <p
                  className="mt-0.5 font-mono text-[10px] text-primary/50 line-clamp-1"
                  data-testid="alert-card-summary"
                >
                  {summary}
                </p>
              )}
            </>
          ) : (
            /* No goal: summary is the primary headline (backward compat) */
            <span
              className="font-mono text-[11px] font-semibold text-foreground line-clamp-3"
              data-testid="alert-card-summary"
            >
              {summary}
            </span>
          )}
        </div>
        {resolved && (
          <span className="ml-auto shrink-0 rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] text-primary/60">
            Resolved
          </span>
        )}
      </div>

      {/* Entity id — metadata row: smaller, muted mono */}
      <a
        href={entityHash}
        className="mb-1.5 block font-mono text-[9px] text-primary/40 truncate hover:text-primary/60 hover:underline transition-colors"
        data-testid="alert-card-entity-id"
        aria-label={`Open details for ${entityId}`}
      >
        {entityId}
      </a>

      {/* Resolution success message */}
      {resolvedOp !== null && (
        <p className="mb-2 font-mono text-[10px] text-success" data-testid="alert-card-resolved-state">
          ✓ {resolvedOp} completed
        </p>
      )}

      {/* Verb buttons (per-task) + optional secondary bulk action */}
      {!resolved && resolvedOp === null && (verbs.length > 0 || bulkContinue) && (
        <div className="relative flex flex-wrap gap-1.5 mb-2 items-center">
          {/* Per-task verbs (primary actions) */}
          {verbs.map((verb) => (
            verb.op === 'copy' ? (
              <button
                key={verb.op}
                type="button"
                className={verbButtonClass('default')}
                title={verb.hint ?? verb.label}
                onClick={() => void navigator.clipboard.writeText(verb.hint ?? verb.label)}
                data-testid={`alert-card-verb-${verb.op}`}
              >
                {verb.label}
              </button>
            ) : verb.style === 'snooze' ? (
              <div key={verb.op} className="relative">
                <button
                  type="button"
                  className={verbButtonClass(verb.style)}
                  disabled={pendingOp !== null}
                  onClick={() => setSnoozeMenuOpen((v) => !v)}
                  data-testid="alert-card-snooze-trigger"
                >
                  {pendingOp === 'snooze' ? '…' : verb.label}
                </button>
                {snoozeMenuOpen && (
                  <SnoozeMenu
                    disabled={pendingOp !== null}
                    onSelect={(preset) => void handleSnoozeSelect(preset)}
                    onClose={() => setSnoozeMenuOpen(false)}
                  />
                )}
              </div>
            ) : (
              <button
                key={verb.op}
                type="button"
                className={verbButtonClass(verb.style)}
                title={verb.op}
                disabled={pendingOp !== null}
                onClick={() => void handleAction(verb.op)}
                data-testid={`alert-card-verb-${verb.op}`}
              >
                {pendingOp === verb.op ? '…' : verb.label}
              </button>
            )
          ))}

          {/* Secondary bulk action — visually lighter than per-task buttons */}
          {bulkContinue && (
            <button
              type="button"
              className="rounded px-3 py-1 font-mono text-[11px] border border-primary/20 text-primary/60 hover:bg-primary/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={bulkPending || pendingOp !== null}
              onClick={() => void handleBulkContinue()}
              data-testid="alert-card-bulk-continue"
            >
              {bulkPending ? '…' : bulkContinue.label}
            </button>
          )}
        </div>
      )}

      {/* Decision buttons — one per server-defined Decision */}
      {decisions.length > 0 && !resolvedOp && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {decisions.map((d) => (
            <button
              key={d.label}
              type="button"
              className={verbButtonClass('default')}
              disabled={pendingOp !== null}
              onClick={() => {
                setPendingOp(d.label)
                setActionError(null)
                postDecision(d)
                  .then((res) => {
                    if (!res.ok) throw new Error(`Decision failed: ${res.status}`)
                    setResolvedOp(d.label)
                    if (d.secondary?.kind === 'teach-recipe' && d.payload.op) {
                      setTeachPrompt({
                        signature: kind,
                        op: String(d.payload.op),
                      })
                    }
                  })
                  .catch((err) =>
                    setActionError(
                      err instanceof Error ? err.message : String(err),
                    ),
                  )
                  .finally(() => setPendingOp(null))
              }}
              data-testid={`alert-card-decision-${d.label}`}
            >
              {pendingOp === d.label ? '…' : d.label}
            </button>
          ))}
        </div>
      )}

      {/* Secondary teach-recipe prompt */}
      {teachPrompt && !teachPending && (
        <div
          className="mb-2 rounded border border-primary/20 bg-primary/5 p-2"
          data-testid="teach-recipe-prompt"
        >
          <p className="font-mono text-[11px] text-primary/80 mb-1.5">
            Apply this automatically next time?
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              className={verbButtonClass('primary')}
              onClick={() => {
                setTeachPending(true)
                fetch(
                  `/api/failure-kinds/${encodeURIComponent(teachPrompt.signature)}/recipe`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ op: teachPrompt.op }),
                  },
                )
                  .then(() => setTeachPrompt(null))
                  .catch(() => setTeachPrompt(null))
                  .finally(() => setTeachPending(false))
              }}
              data-testid="teach-recipe-yes"
            >
              Yes
            </button>
            <button
              type="button"
              className={verbButtonClass('default')}
              onClick={() => setTeachPrompt(null)}
              data-testid="teach-recipe-no"
            >
              No
            </button>
          </div>
        </div>
      )}

      {/* Action error */}
      {actionError && (
        <p className="mb-2 font-mono text-[10px] text-error" data-testid="alert-card-error">
          {actionError}
        </p>
      )}

      {/* Verify output excerpt — last ~3 lines so the decision can be made in place */}
      {verifyOutputTail && <VerifyExcerpt tail={verifyOutputTail} />}

      {/* Detail expander */}
      {detail && <DetailExpander detail={detail} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Duration helpers (no Date.now() in workflow scripts, but fine in React components)
// ---------------------------------------------------------------------------

function msUntilTomorrowMorning(nowMs: number): number {
  const d = new Date(nowMs)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.getTime() - nowMs
}

function msUntilNextWeekMonday(nowMs: number): number {
  const d = new Date(nowMs)
  const dayOfWeek = d.getDay() // 0=Sun, 1=Mon, …
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek
  d.setDate(d.getDate() + daysUntilMonday)
  d.setHours(9, 0, 0, 0)
  return d.getTime() - nowMs
}
