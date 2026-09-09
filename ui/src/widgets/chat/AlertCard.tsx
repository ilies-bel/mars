/**
 * AlertCard — rich alert card shared between chat transcript alert segments
 * and action-queue row detail views.
 *
 * Design:
 *   - Headline: when `operatorGoal` (what the task was trying to achieve) is
 *     present it becomes the primary heading. The plain-language summary
 *     (humanSummary) sits below as a subhead. When no operatorGoal is provided
 *     the humanSummary is the primary headline.
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
import { Response } from '@/components/chat-primitives/response'
import { snoozeActionQueueItem, restoreSnoozedItem, postDecision } from '@/shared/api'
import { dispatchAlertVerb, verbButtonClass } from './alertVerbs'
import type { AlertHumanDetail, AlertVerb, Decision } from '@/shared/schemas'
import { taskHash, proposalHash } from '@/shared/routing'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KIND_ICON: Record<string, string> = {
  failed: '⚠',
  'daemon-killed': '⊘',
  'stale-queued': '◔',
  'stale-worktree': '⌧',
  'draft-proposal': '◇',
  'awaiting-validation': '◎',
  'arc-failed': '⊗',
}

export type SnoozePreset = '1h' | '4h' | 'tomorrow-morning' | 'next-week'

const SNOOZE_PRESETS: { value: SnoozePreset; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: 'tomorrow-morning', label: 'Tomorrow morning' },
  { value: 'next-week', label: 'Next week' },
]

// ---------------------------------------------------------------------------
// Signature family → plain phrase mapping (DEC-18: slugs stay behind disclosure)
// ---------------------------------------------------------------------------

/**
 * Map a failure signature (e.g. "merge:hard-timeout") to a plain English phrase
 * shown as the secondary headline on task-failure cards.
 * Exact match is tried first; on miss, only the family prefix before ":" is used.
 * Raw slugs must NEVER appear on the face of the card — only behind the
 * "Technical details" disclosure.
 */
const SIGNATURE_FAMILY_PHRASES: Record<string, string> = {
  'merge:hard-timeout': 'Could not be merged — the merge step timed out',
  'merge:conflict':     'Could not be merged — there were conflicts',
  'merge:dirty-main':   'Could not be merged — the integration branch was dirty',
  'merge:crashed':      'Merge failed inside Mars (internal error)',
  merge:               'Could not be merged',
  'verify:has-diff':   'Verification failed — the branch has uncommitted changes',
  'verify:dirty-main': 'Verification failed — integration branch was dirty',
  verify:             'Verification failed',
  'code:timeout':     'Coding step timed out',
  code:              'Coding step failed',
  'setup:':           'Setup step failed',
  setup:             'Setup step failed',
}

export const signatureFamilyPhrase = (sig: string | undefined): string | undefined => {
  if (!sig) return undefined
  if (SIGNATURE_FAMILY_PHRASES[sig]) return SIGNATURE_FAMILY_PHRASES[sig]
  // Signatures can carry an error-class suffix after '/' (e.g. 'merge:crashed/unclassified').
  // Strip the error-class first so 'merge:crashed' is matched before falling
  // back to the bare gate-family prefix before ':'.
  const step = sig.split('/')[0]!
  if (SIGNATURE_FAMILY_PHRASES[step]) return SIGNATURE_FAMILY_PHRASES[step]
  const gate = step.split(':')[0]!
  // Try the bare family name with and without the trailing ':' sentinel the
  // lookup table uses (e.g. 'verify:' matches 'verify' after stripping).
  return SIGNATURE_FAMILY_PHRASES[gate] ?? SIGNATURE_FAMILY_PHRASES[gate + ':']
}

// ---------------------------------------------------------------------------
// Verify output tail
// ---------------------------------------------------------------------------

/** Extract the last `n` non-empty lines from a multi-line string. */
const verifyTail = (text: string | undefined, n = 40): string | undefined => {
  if (!text?.trim()) return undefined
  const lines = text.trim().split('\n').filter((l) => l.trim())
  if (lines.length === 0) return undefined
  return lines.slice(-n).join('\n')
}

// ---------------------------------------------------------------------------
// Snooze helpers
// ---------------------------------------------------------------------------

/**
 * Compute a human-readable "reappears in X" string for an epoch-ms snoozeUntil.
 */
const reappearsIn = (snoozeUntilMs: number): string => {
  const ms = snoozeUntilMs - Date.now()
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
  /**
   * Epoch-millisecond timestamp of snooze expiry — when set to a future
   * instant the card starts in snoozed state. Epoch-ms, not an ISO string,
   * to match the store's `ActionQueueItem.snoozedUntil` encoding.
   */
  snoozeUntil?: number
  /**
   * The operator-facing goal — "what the task was trying to achieve".
   * When present it becomes the PRIMARY headline and the humanSummary is
   * rendered as a subhead beneath it.
   */
  operatorGoal?: string
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
  /**
   * When true the row is backed by a real task (dag !== null, entityId is a
   * real task id) and the entity-id metadata link is rendered.
   * When false or absent (the default) the entity-id is NOT rendered — the
   * kind badge already names the condition in plain language and a machine slug
   * (e.g. `daemon-code-drift`) on the card face would be DEC-18 jargon.
   *
   * Callers: ActionQueueRow passes `hasResolvableTask(item)`; chat-transcript
   * callers that always have a real task id should pass `true`.
   */
  isTaskBacked?: boolean
}

// ---------------------------------------------------------------------------
// OutputExpander — evidence disclosure for task-failure cards
//
// Shows failure_reason (the signature mapped to plain text), the last ~40 lines
// of captured verify/merge output, and branch + worktree paths. Renders a
// "No output was captured for this step." fallback when nothing is available.
// Raw signature slugs appear here — never on the face of the card (DEC-18).
// ---------------------------------------------------------------------------

interface OutputExpanderProps {
  /** Raw failure signature slug (e.g. "merge:hard-timeout"). Rendered verbatim inside this disclosure. */
  signature?: string
  branch?: string
  worktree?: string
  /** Tail-trimmed raw output from the failing step. */
  rawOutput?: string
  /** Backwards-compat: plain verify-output tail from non-failure cards (e.g. baseline-broken gate output). */
  tail?: string
}

const OutputExpander = ({ signature, branch, worktree, rawOutput, tail }: OutputExpanderProps) => {
  const [open, setOpen] = useState(false)

  // Build the structured preamble lines.
  const preamble: string[] = []
  if (signature) preamble.push(`failure_reason: ${signature}`)
  if (branch)    preamble.push(`branch: ${branch}`)
  if (worktree)  preamble.push(`worktree: ${worktree}`)

  const outputText = verifyTail(rawOutput) ?? tail
  const content = [
    ...preamble,
    ...(outputText ? [outputText] : []),
  ].join('\n').trim()

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="font-mono text-micro text-primary/60 hover:text-primary transition-colors select-none"
        data-testid="alert-output-toggle"
      >
        Output {open ? '▾' : '▸'}
      </button>
      {open && (
        <pre
          className="max-w-[68ch] mt-1 max-h-40 overflow-y-auto rounded bg-primary/10 p-1.5 text-micro text-primary/80 whitespace-pre-wrap leading-relaxed break-all"
          data-testid="alert-output-panel"
        >
          {content || 'No output was captured for this step.'}
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
        className="font-mono text-micro text-primary/60 hover:text-primary transition-colors select-none"
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
              <dt className="text-micro uppercase text-primary/40">Failure</dt>
              <dd className="font-mono text-micro text-primary">{detail.failureSignature}</dd>
            </div>
          )}
          {detail.branch && (
            <div>
              <dt className="font-mono text-micro uppercase text-primary/40">Branch</dt>
              <dd className="font-mono text-micro text-primary">{detail.branch}</dd>
            </div>
          )}
          {detail.worktree && (
            <div>
              <dt className="font-mono text-micro uppercase text-primary/40">Worktree</dt>
              <dd className="font-mono text-micro text-primary break-all">{detail.worktree}</dd>
            </div>
          )}
          {detail.rawError && (
            <div>
              <dt className="font-mono text-micro uppercase text-primary/40">Error</dt>
              <dd>
                <pre
                  className="max-w-[68ch] mt-0.5 max-h-32 overflow-y-auto rounded bg-primary/10 p-1.5 text-micro text-primary/80 whitespace-pre-wrap leading-relaxed break-all"
                  data-testid="alert-detail-raw-error"
                >
                  {detail.rawError}
                </pre>
              </dd>
            </div>
          )}
          {detail.changelog && (
            <div>
              <dt className="text-micro uppercase text-primary/40">Changelog</dt>
              <dd className="mt-0.5 chat-markdown prose prose-sm prose-invert max-w-none text-label">
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
    className="absolute z-10 mt-1 rounded border border-border bg-card shadow-lg"
    data-testid="snooze-menu"
  >
    {SNOOZE_PRESETS.map(({ value, label }) => (
      <button
        key={value}
        type="button"
        disabled={disabled}
        onClick={() => onSelect(value)}
        className="block w-full px-4 py-1.5 text-left font-mono text-label text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
        data-testid={`snooze-preset-${value}`}
      >
        {label}
      </button>
    ))}
    <button
      type="button"
      onClick={onClose}
      className="block w-full border-t border-border px-4 py-1.5 text-left text-micro text-primary/50 hover:bg-foreground/5 transition-colors"
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
  operatorGoal,
  detail,
  verbs,
  decisions = [],
  resolved = false,
  snoozeUntil: initialSnoozeUntil,
  bulkContinue,
  isTaskBacked = false,
}: AlertCardProps) => {
  const [pendingOp, setPendingOp] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [resolvedOp, setResolvedOp] = useState<string | null>(null)
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(
    initialSnoozeUntil ?? null,
  )
  const [teachPrompt, setTeachPrompt] = useState<{
    signature: string
    op: string
  } | null>(null)
  const [teachPending, setTeachPending] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)

  const isSnoozed = snoozedUntil !== null && snoozedUntil > Date.now()

  // Derive output section props.
  // - For task-failure cards (operatorGoal present): full OutputExpander with
  //   signature, branch, worktree, and last ~40 lines of error output.
  // - For baseline-broken / gate cards: show gate output tail (backwards compat).
  const showTaskOutput = Boolean(operatorGoal)
  const gateOutputTail = !showTaskOutput ? (detail?.gateOutput?.trim() || undefined) : undefined

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
      setSnoozedUntil(now + durations[preset])
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

  const entityHash =
    kind === 'draft-proposal'
      ? proposalHash(entityId, 'chat')
      : taskHash(entityId, 'chat')

  // Verb separation: when there is at least one primary verb, move
  // destructive/default verbs into the overflow menu so the action row stays
  // focused and the dangerous verbs require a deliberate second click.
  const hasPrimaryVerb = verbs.some((v) => v.style === 'primary')
  const mainVerbs = hasPrimaryVerb
    ? verbs.filter((v) => v.style === 'primary' || v.style === 'snooze' || v.op === 'copy')
    : verbs
  const overflowVerbs = hasPrimaryVerb
    ? verbs.filter((v) => v.style !== 'primary' && v.style !== 'snooze' && v.op !== 'copy')
    : []
  const hasOverflow = overflowVerbs.length > 0 || isTaskBacked

  // Subhead phrase — for task-failure cards, map the raw signature to a plain
  // English phrase so no machine slug appears on the face of the card.
  const subheadPhrase = signatureFamilyPhrase(detail?.failureSignature) ?? summary

  if (isSnoozed) {
    return (
      <div
        className="mars-card my-2 rounded-lg bg-card p-3 text-body opacity-50"
        data-testid="alert-card-snoozed"
      >
        <div className="flex items-center gap-2">
          <span className="text-body" aria-hidden="true">{KIND_ICON[kind] ?? '•'}</span>
          <span className="flex-1 font-mono text-label text-primary/60 line-clamp-1">{operatorGoal ?? summary}</span>
          <span className="font-mono text-micro text-primary/40">
            reappears in {reappearsIn(snoozedUntil)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={pendingOp !== null}
            onClick={() => void handleRestore()}
            className="rounded border border-border px-2 py-0.5 font-mono text-micro text-primary hover:bg-primary/20 disabled:opacity-40 transition-colors"
            data-testid="alert-card-restore"
          >
            {pendingOp === 'restore' ? '…' : 'Restore'}
          </button>
          {actionError && (
            <span className="font-mono text-micro text-error">{actionError}</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={[
        'mars-card my-2 rounded-lg p-3 text-body',
        resolved
          ? 'bg-card opacity-60'
          : 'bg-card',
      ].join(' ')}
      data-testid="alert-card"
    >
      {/* Header: icon + headline + resolved badge */}
      <div className="mb-1 flex items-start gap-2">
        <span className="text-body shrink-0 mt-0.5" aria-hidden="true">{KIND_ICON[kind] ?? '•'}</span>
        <div className="flex-1 min-w-0">
          {operatorGoal ? (
            <>
              {/* Primary headline: operator-facing goal (what the task was trying to achieve).
                  No raw failure signature slug here — that stays behind the Output disclosure. */}
              <p
                className="font-mono text-label font-semibold text-foreground line-clamp-2"
                data-testid="alert-card-goal"
              >
                {operatorGoal}
              </p>
              {/* Subhead: plain-language cause phrase mapped from signature family.
                  Body font at readable size (not micro monospace). */}
              {subheadPhrase && (
                <p
                  className="mt-0.5 text-body text-muted-foreground"
                  data-testid="alert-card-summary"
                >
                  {subheadPhrase}
                </p>
              )}
            </>
          ) : (
            /* No operatorGoal: summary is the primary headline (backward compat) */
            <span
              className="font-mono text-label font-semibold text-foreground line-clamp-3"
              data-testid="alert-card-summary"
            >
              {summary}
            </span>
          )}
        </div>
        {resolved && (
          <span className="ml-auto shrink-0 rounded bg-primary/20 px-1.5 py-0.5 font-mono text-micro text-primary/60">
            Resolved
          </span>
        )}
      </div>

      {/* Entity id — metadata row: smaller, muted mono.
          Only rendered when the row is backed by a real task (isTaskBacked).
          Non-task-backed derived conditions (e.g. daemon-code-drift) carry the
          kind slug as entityId — showing it would be DEC-18 jargon on the face. */}
      {isTaskBacked && (
        <a
          href={entityHash}
          className="mb-1.5 block font-mono text-micro text-primary/40 truncate hover:text-primary/60 hover:underline transition-colors"
          data-testid="alert-card-entity-id"
          aria-label={`Open details for ${entityId}`}
        >
          {entityId}
        </a>
      )}

      {/* Resolution success message */}
      {resolvedOp !== null && (
        <p className="mb-2 text-micro text-success" data-testid="alert-card-resolved-state">
          ✓ {resolvedOp} completed
        </p>
      )}

      {/* Verb buttons (per-task) + overflow menu + optional secondary bulk action */}
      {!resolved && resolvedOp === null && (verbs.length > 0 || bulkContinue) && (
        <div className="relative flex flex-wrap gap-1.5 mb-2 items-center">
          {/* Primary per-task verbs */}
          {mainVerbs.map((verb) => (
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

          {/* Overflow menu — secondary verbs (destructive / default) + Open task.
              Requires a deliberate second click so dangerous verbs are never
              accidentally clicked during a failure storm.
              The menu div is always in the DOM (visibility:hidden + pointer-events:none
              when closed) so test queries still find its elements regardless of
              open state. */}
          {hasOverflow && (
            <div className="relative">
              <button
                type="button"
                aria-label="More actions"
                aria-expanded={overflowOpen}
                disabled={pendingOp !== null}
                onClick={() => setOverflowOpen((v) => !v)}
                className="rounded px-1.5 py-0.5 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                data-testid="alert-overflow-trigger"
              >
                …
              </button>
              <div
                role="menu"
                className={[
                  'absolute right-0 z-10 mt-1 min-w-36 rounded-lg border border-border bg-card py-1 shadow-lg',
                  overflowOpen ? '' : 'invisible pointer-events-none',
                ].join(' ')}
                data-testid="alert-overflow-menu"
              >
                {overflowVerbs.map((verb) => (
                  <button
                    key={verb.op}
                    type="button"
                    role="menuitem"
                    disabled={pendingOp !== null}
                    onClick={() => {
                      setOverflowOpen(false)
                      void handleAction(verb.op)
                    }}
                    className={[
                      'flex w-full items-center px-3 py-1.5 text-left font-mono text-micro transition-colors disabled:opacity-50',
                      verb.style === 'destructive'
                        ? 'text-error hover:bg-error/5'
                        : 'text-foreground hover:bg-border/40',
                    ].join(' ')}
                    data-testid={`alert-overflow-${verb.op}`}
                  >
                    {verb.label}
                  </button>
                ))}
                {isTaskBacked && (
                  <a
                    href={entityHash}
                    role="menuitem"
                    className="flex w-full items-center px-3 py-1.5 text-left font-mono text-micro text-foreground transition-colors hover:bg-border/40"
                    data-testid="alert-overflow-open-task"
                    onClick={() => setOverflowOpen(false)}
                  >
                    Open task
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Secondary bulk action — visually lighter than per-task buttons */}
          {bulkContinue && (
            <button
              type="button"
              className="rounded px-3 py-1 text-label border border-border text-primary/60 hover:bg-foreground/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
              className={verbButtonClass(d.style ?? 'default')}
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
          className="mb-2 rounded border border-border bg-primary/5 p-2"
          data-testid="teach-recipe-prompt"
        >
          <p className="text-label text-primary/80 mb-1.5">
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
        <p className="mb-2 text-micro text-error" data-testid="alert-card-error">
          {actionError}
        </p>
      )}

      {/* Output section — task-failure cards: signature, branch, worktree, captured output.
          Gate/baseline-broken cards: gate output tail (backwards compat). */}
      {showTaskOutput ? (
        <OutputExpander
          signature={detail?.failureSignature}
          branch={detail?.branch}
          worktree={detail?.worktree}
          rawOutput={detail?.errorExcerpt ?? detail?.rawError}
        />
      ) : gateOutputTail ? (
        <OutputExpander tail={gateOutputTail} />
      ) : null}

      {/* Detail expander — Technical details (raw signature, branch, changelog…) */}
      {detail && <DetailExpander detail={detail} />}

      {/* Footer: entity id chip — shown once, copyable, for task-backed rows.
          DEC-18: the id must not dominate the face of the card; a small chip in
          the footer provides a copy affordance without visual weight. */}
      {isTaskBacked && (
        <div className="mt-3 flex items-center justify-end">
          <button
            type="button"
            className="rounded bg-primary/5 px-1.5 py-0.5 font-mono text-micro text-primary/40 hover:text-primary/60 transition-colors select-all"
            title="Copy task id"
            onClick={() => void navigator.clipboard.writeText(entityId)}
            data-testid="alert-card-id-chip"
          >
            {entityId}
          </button>
        </div>
      )}
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
