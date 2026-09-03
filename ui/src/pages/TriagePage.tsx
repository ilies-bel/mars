/**
 * TriagePage — "Action Queue" ranked triage view.
 *
 * Answers "what needs me right now" with a single ranked list of every open
 * action-queue item, ordered by priority then recency. Each row shows the
 * plain-language headline, kind chip, age, and inline resolution actions.
 *
 * High-cardinality decision kinds (e.g. draft-proposal, which can reach 900+
 * rows) are collapsed into ONE cluster row per kind, linking to the relevant
 * surface. Condition kinds (failed, stale-queued, …) always appear as
 * individual rows since each represents a distinct entity needing attention.
 *
 * Badge = the number of distinct SUBJECTS needing attention (see
 * `countNeedsYou` in clusterRows.ts) — the SAME cross-surface definition the
 * sidebar badge, the chat greeting, and the chat situation card all use.
 * Kind-clustering (draft-proposal, or any other kind past CLUSTER_THRESHOLD)
 * never changes the count — those are many different subjects sharing a
 * kind. Entity grouping DOES change the count — several condition kinds
 * (failed, recovery-abandoned, gate-broken, …) can derive independently for
 * the SAME task (ADR-0057 kinds never reconcile with each other), and a task
 * shown on three rows is one subject, not three. See `buildRenderedRows` in
 * clusterRows.ts for how the two are told apart.
 *
 * Empty state: "All quiet — N running, N done today". Shown ONLY when the
 * daemon actually answered and had nothing to report; when it is unreachable
 * the page says so instead (see UnreachableState).
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { sortItems, buildRenderedRows, countNeedsYou } from '@/entities/actionQueue/clusterRows'
import { useProgress } from '@/hooks/useProgress'
import { useProposals } from '@/entities/proposals/useProposals'
import { useDaemonHealth } from '@/entities/daemon/useDaemonHealth'
import { DAEMON_DOWN_MESSAGE } from '@/widgets/DaemonDownBanner'
import { describeFeedFailure } from '@/shared/feedFailure'
import { postDecision, snoozeActionQueueItem } from '@/shared/api'
import { relativeTime } from '@/shared/time'
import { dispatchAlertVerb, resolveThreadForItem } from '@/widgets/chat/alertVerbs'
import { CollapsibleSection } from '@/components/CollapsibleSection'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { defaultAqUrlState, encodeAqState } from '@/shared/actionQueueUrlState'
import { taskHash } from '@/shared/routing'
import { hasResolvableTask, isConditionActionQueueKind } from '@/shared/schemas'
import { useSseConnected } from '@/shared/sseStatus'
import type { ActionQueueItem, ActionQueueKind } from '@/shared/schemas'
import type { Decision } from '@/shared/schemas'

// ── Kind display ──────────────────────────────────────────────────────────────

const KIND_ICON: Record<string, string> = {
  failed: '⚠',
  'daemon-killed': '⊘',
  'stale-queued': '◔',
  'stale-worktree': '⌧',
  'draft-proposal': '◇',
  'awaiting-validation': '◎',
  'arc-failed': '⊗',
  'awaiting-human': '▸',
  'coder-question': '?',
  'diagnose-inconclusive': '◌',
  'reflect-recommended': '✦',
  'scorer-suggested': '◈',
  'gate-broken': '⊘',
  'recovery-abandoned': '↩',
  'baseline-broken': '⊘',
  'daemon-code-drift': '↻',
  'signature-storm': '⚡',
  'dirty-integration': '⊘',
}

/**
 * Human-readable chip label for every action-queue kind.
 *
 * Typed as `Record<ActionQueueKind, string>` so TypeScript raises a compile
 * error when a new kind is added to the schema without a corresponding label
 * here — omitting a kind would silently emit the raw machine slug on the card
 * face (DEC-18). The three `?? kind.replace(/-/g, ' ')` fallbacks at the
 * render sites are defence-in-depth for kinds that arrive from the daemon at
 * runtime after the build was cut.
 */
const KIND_LABEL: Record<ActionQueueKind, string> = {
  // ── condition kinds ──────────────────────────────────────────────────────
  failed: 'failed',
  'stale-queued': 'stale',
  'stale-queued-summary': 'stale summary',
  'gate-broken': 'gate broken',
  'subscriber-stalled': 'stalled',
  'signature-storm': 'storm',
  'daemon-died': 'daemon died',
  'daemon-code-drift': 'daemon drift',
  'baseline-broken': 'baseline broken',
  'stale-worktree': 'worktree',
  'phantom-task': 'phantom',
  'worktree-ahead': 'ahead',
  'orphaned-origin': 'orphaned',
  'steward-repeat': 'steward',
  'e2e-tooling-missing': 'e2e tooling',
  // ── task-failure kinds ───────────────────────────────────────────────────
  'daemon-killed': 'killed',
  'cancelled-blocker-cascade': 'cascaded',
  'diagnose-inconclusive': 'inconclusive',
  'coder-question': 'question',
  'prerequisite-failed': 'prerequisite',
  'slices-dropped': 'slices dropped',
  'slice-failed': 'slice failed',
  'behaviour-unverified': 'unverified',
  'observability-store-oversize': 'store oversize',
  'outbox-lag': 'outbox lag',
  'recovery-abandoned': 'recovery abandoned',
  'done-with-unmerged-commits': 'unmerged',
  'api-outage': 'api outage',
  'workflow-install-drift': 'install drift',
  'provider-rate-limited': 'rate limited',
  'gate-enrichment': 'enrichment',
  'verify-uncovered': 'uncovered',
  'budget-window': 'budget',
  'budget-arc': 'arc budget',
  'promotion-decision': 'promotion',
  'arc-verification-failed': 'arc verify',
  'gate-enrichment-stale': 'stale enrichment',
  'env-incident': 'env incident',
  'dirty-integration': 'dirty integration',
  'fragmented-repo-layout': 'fragmented',
  'low-disk-space': 'low disk',
  // ── notice kinds ─────────────────────────────────────────────────────────
  'spend-control-notice': 'spend limit',
  'scheduling-decision': 'scheduled',
  'requeue-warning': 'requeue',
  'arc-superseded-on-main': 'superseded',
  'mockup-ready': 'mockup',
  'qa-step-list-opt-in': 'qa opt-in',
  'qa-step-list-promote': 'qa promote',
  // ── operator-decision kinds ───────────────────────────────────────────────
  'draft-proposal': 'proposal',
  'awaiting-validation': 'validate',
  'arc-failed': 'arc failed',
  'awaiting-human': 'awaiting',
  'reflect-recommended': 'reflect',
  'scorer-suggested': 'scorer',
}

/** Left accent bar color per kind. */
const KIND_ACCENT: Record<string, string> = {
  failed: 'border-l-error',
  'daemon-killed': 'border-l-error',
  'arc-failed': 'border-l-error',
  'baseline-broken': 'border-l-error',
  'stale-queued': 'border-l-warn',
  'stale-worktree': 'border-l-warn',
  'dirty-integration': 'border-l-warn',
  'daemon-code-drift': 'border-l-warn',
  'signature-storm': 'border-l-warn',
  'awaiting-validation': 'border-l-trace-mars',
  'draft-proposal': 'border-l-success',
  'awaiting-human': 'border-l-primary',
}

/** Badge text + border tint per kind. */
const KIND_CHIP_CLASS: Record<string, string> = {
  failed: 'text-error border-error/40',
  'daemon-killed': 'text-error border-error/40',
  'arc-failed': 'text-error border-error/40',
  'baseline-broken': 'text-error border-error/40',
  'stale-queued': 'text-warn border-warn/40',
  'stale-worktree': 'text-warn border-warn/40',
  'dirty-integration': 'text-warn border-warn/40',
  'daemon-code-drift': 'text-warn border-warn/40',
  'signature-storm': 'text-warn border-warn/40',
  'awaiting-validation': 'text-trace-mars border-trace-mars/40',
  'draft-proposal': 'text-success border-success/40',
}

// ── Action kind sets ──────────────────────────────────────────────────────────

/**
 * Kinds where the entity is a failed task that can be continued / restarted.
 * All other task-failure kinds are system/daemon conditions whose recovery
 * verbs come from the server-side recipe (item.verbs / item.decisions).
 */
const TASK_RECOVERY_KINDS = new Set([
  'failed',
  'daemon-killed',
  'coder-question',
  'diagnose-inconclusive',
  'steward-repeat',
  'cancelled-blocker-cascade',
  'worktree-ahead',
  'prerequisite-failed',
  'slices-dropped',
  'behaviour-unverified',
  'arc-verification-failed',
  'done-with-unmerged-commits',
])

/**
 * Kinds whose rows surface only the Chat → link and no action buttons.
 * The reflect and scorer flows are purely conversational — the operator
 * discusses proposals in chat rather than clicking a verb in this view.
 */
const CHAT_ONLY_KINDS = new Set(['reflect-recommended', 'scorer-suggested'])

// ── TriageClusterRow ──────────────────────────────────────────────────────────

interface TriageClusterRowProps {
  kind: string
  count: number
  latestAt: string
}

/**
 * A single collapsed row representing N items of the same kind.
 * Linking to the relevant surface instead of expanding inline keeps the triage
 * view actionable (the operator goes to the right page to process the batch).
 */
const TriageClusterRow = ({ kind, count, latestAt }: TriageClusterRowProps) => {
  const age = relativeTime(latestAt)
  const kindLabel = (KIND_LABEL as Record<string, string | undefined>)[kind] ?? kind.replace(/-/g, ' ')
  const kindIcon = KIND_ICON[kind] ?? '•'
  const chipClass = KIND_CHIP_CLASS[kind] ?? 'text-muted-foreground border-border'
  const accentClass = KIND_ACCENT[kind] ?? 'border-l-muted'
  const isDraftProposal = kind === 'draft-proposal'

  return (
    <div
      className={[
        'mars-card relative rounded-lg border-l-2 bg-card px-4 py-3',
        accentClass,
      ].join(' ')}
    >
      {/* Top row: kind chip + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={[
            'inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-micro leading-none',
            chipClass,
          ].join(' ')}
        >
          <span className="opacity-60">{kindIcon}</span>
          {kindLabel}
        </span>
        <span className="ml-auto font-mono text-micro text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Cluster headline */}
      <p className="mb-1 text-title font-medium leading-snug text-foreground">
        {isDraftProposal
          ? `${count} draft proposals await review`
          : `${count} ${kindLabel} items`}
      </p>

      {/* Navigation link to the relevant surface */}
      <a
        href={isDraftProposal ? '#/proposals' : '#/triage'}
        className="font-mono text-micro text-primary transition-colors hover:text-foreground"
        data-testid={isDraftProposal ? 'cluster-proposals-link' : 'cluster-view-link'}
      >
        {isDraftProposal ? 'Review proposals →' : `View all →`}
      </a>
    </div>
  )
}

// ── TriageRow ─────────────────────────────────────────────────────────────────

interface TriageRowProps {
  item: ActionQueueItem
  /**
   * Other condition kinds derived for the SAME task, collapsed into this row
   * by buildRenderedRows' entity grouping (see clusterRows.ts). Read-only —
   * the row exposes exactly one verb set (this item's), never a second
   * Continue/Restart affordance that could contradict the first.
   */
  extraBadges?: string[]
}

const TriageRow = ({ item, extraBadges }: TriageRowProps) => {
  const qc = useQueryClient()
  const projectId = useFocusedProjectId() ?? undefined
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState(false)
  // Restart is destructive (wipes worktree + branch, discarding commits) — it
  // requires an explicit in-app confirm step before dispatching, rather than
  // firing on first click like the reversible Continue verb.
  const [confirmRestart, setConfirmRestart] = useState(false)

  // True when this row's kind is a condition derived from live system state
  // (ADR-0094). Condition-kind rows MUST NOT be optimistically hidden on verb
  // success — whether the row survives depends entirely on whether the
  // underlying condition still holds after the verb, which only the refetched
  // feed can answer. Decision-kind rows MAY be hidden optimistically because
  // the mutation and the row's closure are one atomic transaction.
  const isCondition = isConditionActionQueueKind(item.kind)

  // Guards post-refetch setState calls when the row has already unmounted
  // (i.e. the condition resolved and the parent stopped rendering this row).
  const mounted = useRef(true)
  useEffect(() => {
    return () => {
      mounted.current = false
    }
  }, [])

  // True while the action-queue query is re-fetching after a condition-kind
  // verb success. Cleared once the refetch resolves (or the row unmounts).
  const [settling, setSettling] = useState(false)

  // Called after every successful verb. Decision-kind rows are hidden
  // immediately (their stored row is closed atomically by the mutation).
  // Condition-kind rows enter a brief settling state and disappear only when
  // the refetched feed no longer contains them.
  const handleSuccess = useCallback(() => {
    if (isCondition) {
      setSettling(true)
      void qc.invalidateQueries({ queryKey: ['action-queue'] }).then(() => {
        if (mounted.current) setSettling(false)
      })
    } else {
      setResolved(true)
      void qc.invalidateQueries({ queryKey: ['action-queue'] })
    }
  }, [isCondition, qc])

  // Use relativeTime so timestamps are handled via the existing helper
  // (avoids hand-dividing epoch-ms values which can silently land at 1970).
  const age = relativeTime(item.at)
  // Narrative hierarchy (§7): when operatorGoal is present it becomes the
  // primary headline so the operator sees WHAT the task was doing; item.title
  // (the daemon's plain-language cause phrase) is the subhead; the raw error
  // output moves behind an "Output" disclosure. When no goal is available the
  // humanSummary || title falls back to the sole headline.
  const goal = item.operatorGoal ?? null
  const headline = !goal ? (item.humanSummary || item.title) : null
  const accentClass = KIND_ACCENT[item.kind] ?? 'border-l-muted'
  const kindLabel = KIND_LABEL[item.kind] ?? item.kind.replace(/-/g, ' ')
  const kindIcon = KIND_ICON[item.kind] ?? '•'
  const chipClass =
    KIND_CHIP_CLASS[item.kind] ?? 'text-muted-foreground border-border'
  const isChatOnly = CHAT_ONLY_KINDS.has(item.kind)
  const isTaskRecovery = TASK_RECOVERY_KINDS.has(item.kind)
  const isRecoveryExhausted = isTaskRecovery && item.recoveryExhausted
  // A task-recovery row renders its own restart affordance below: guarded by a
  // confirm step that names the branch and says what is lost, or — once the
  // single recovery attempt is spent — deliberately withheld in favour of the
  // carry-forward verbs. The daemon ships a bare `restart` verb too, which
  // fires immediately with no confirmation. Rendering both put two Restart
  // buttons on every failed row, one of them destructive on first click, and
  // sat a live Restart beside a panel stating that Restart will not help.
  const verbs = (item.verbs ?? []).filter(
    (verb) => !(isTaskRecovery && verb.op === 'restart'),
  )

  const handleDecision = useCallback(
    async (d: Decision) => {
      if (pending !== null) return
      setPending(d.label)
      setError(null)
      try {
        const res = await postDecision(d)
        if (!res.ok) throw new Error(`request failed (${res.status})`)
        handleSuccess()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(null)
      }
    },
    [pending, handleSuccess],
  )

  const handleVerb = useCallback(
    async (op: string, hint?: string) => {
      if (pending !== null) return
      if (op === 'copy') {
        const text = hint || op
        void navigator.clipboard.writeText(text)
        setPending(op)
        setTimeout(() => setPending(null), 600)
        return
      }
      if (op === 'snooze') {
        setPending(op)
        setError(null)
        try {
          await snoozeActionQueueItem(item.id, '1h')
          handleSuccess()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setPending(null)
        }
        return
      }
      setPending(op)
      setError(null)
      try {
        await dispatchAlertVerb(item.id, item.entityId, op)
        handleSuccess()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(null)
      }
    },
    [pending, handleSuccess, item.id, item.entityId],
  )

  // Open (or reuse) a chat thread for this row and navigate to it — mirrors
  // ChatPage.handleOpenSubthread via the shared resolveThreadForItem helper
  // so both entry points open the same thread for the same row.
  const handleChat = useCallback(async () => {
    if (pending !== null) return
    setPending('chat')
    setError(null)
    try {
      const threadId = await resolveThreadForItem(item, projectId, qc)
      window.location.hash = `#/chat${encodeAqState({
        ...defaultAqUrlState(),
        thread: threadId,
        project: projectId ?? null,
      })}`
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }, [pending, item, projectId, qc])

  if (resolved) return null

  return (
    <div
      className={[
        'mars-card relative rounded-lg border-l-2 bg-card px-4 py-3 transition-opacity',
        accentClass,
      ].join(' ')}
    >
      {/* Top row: kind chip + priority badge + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={[
            'inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-micro leading-none',
            chipClass,
          ].join(' ')}
        >
          <span className="opacity-60">{kindIcon}</span>
          {kindLabel}
        </span>
        {item.priority === 'high' && (
          <span className="rounded bg-error/15 px-1.5 py-0.5 font-mono text-micro font-medium leading-none text-error">
            ↑ high
          </span>
        )}
        {item.priority === 'normal' && (
          <span className="rounded bg-warn/10 px-1.5 py-0.5 font-mono text-micro leading-none text-warn">
            normal
          </span>
        )}
        <span className="ml-auto font-mono text-micro text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Other condition rows collapsed into this card (entity grouping —
          see clusterRows.ts). Read-only labels, no buttons: exactly one verb
          set is shown for this task, chosen by ENTITY_GROUP_KIND_RANK. */}
      {extraBadges && extraBadges.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1" data-testid="triage-entity-badges">
          <span className="font-mono text-micro text-muted-foreground">also:</span>
          {extraBadges.map((badgeKind) => (
            <span
              key={badgeKind}
              className="rounded border border-border px-1.5 py-0.5 font-mono text-micro leading-none text-muted-foreground"
              data-testid={`triage-entity-badge-${badgeKind}`}
            >
              {(KIND_LABEL as Record<string, string | undefined>)[badgeKind] ?? badgeKind.replace(/-/g, ' ')}
            </span>
          ))}
        </div>
      )}

      {/* Headline — §7 hierarchy:
           - When operatorGoal is present: goal is primary headline, item.title
             is the subhead (daemon's plain-language cause phrase), humanSummary
             is tertiary, raw error output hides behind "Output" disclosure.
           - Otherwise: humanSummary || title is the sole headline. */}
      {goal ? (
        <>
          <p
            className="mb-0.5 text-title font-medium leading-snug text-foreground line-clamp-2"
            data-testid="triage-goal"
          >
            {goal.split('\n')[0]?.trim()}
          </p>
          <p
            className="font-mono text-micro text-muted-foreground"
            data-testid="triage-title-subhead"
          >
            {item.title}
          </p>
          {item.humanSummary && (
            <p className="mt-0.5 font-mono text-micro text-muted-foreground/70 line-clamp-1">
              {item.humanSummary}
            </p>
          )}
          {(item.humanDetail?.errorExcerpt ?? item.humanDetail?.rawError ?? item.humanDetail?.failureSignature) != null && (
            <CollapsibleSection
              label="Output"
              className="mt-1.5"
              data-testid="triage-output-disclosure"
            >
              <pre className="max-h-28 overflow-y-auto rounded bg-primary/10 p-1.5 font-mono text-micro text-primary/80 whitespace-pre-wrap break-all">
                {[
                  item.humanDetail?.failureSignature
                    ? `signature: ${item.humanDetail.failureSignature}`
                    : null,
                  item.humanDetail?.errorExcerpt ?? item.humanDetail?.rawError,
                ]
                  .filter(Boolean)
                  .join('\n')}
              </pre>
            </CollapsibleSection>
          )}
        </>
      ) : (
        headline && (
          <p className="mb-0.5 text-title font-medium leading-snug text-foreground">
            {headline}
          </p>
        )
      )}

      {/* Entity ID — links to the task detail drawer (prompt, failure signature,
          failure output, restart command) for task-backed rows so the operator
          can see the evidence without leaving the UI. Gated on hasResolvableTask
          (dag !== null), NOT on kind or TASK_RECOVERY_KINDS — some kinds (e.g.
          gate-broken) carry a task id on some rows and a non-task slug on
          others, so a kind-only check would either dead-link the non-task rows
          or (as TASK_RECOVERY_KINDS did) deny the link to valid task rows of
          kinds it doesn't enumerate. See hasResolvableTask's doc comment in
          shared/schemas.ts.
          Non-task-backed rows (entityId is a kind slug like "daemon-code-drift")
          render nothing — the kind badge above already names the condition in
          plain language and repeating the slug here is DEC-18 jargon. */}
      {hasResolvableTask(item) && (
        <a
          href={taskHash(item.entityId, 'triage')}
          className="mb-2 block font-mono text-micro text-primary transition-colors hover:text-foreground hover:underline"
          data-testid="triage-entity-link"
        >
          {item.entityId}
        </a>
      )}

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-2">
        {!isChatOnly && (
          <>
            {/* Server-defined decision buttons (recipe-derived per failure kind) —
                Primary tier: filled background so these are the first thing the
                operator's eye lands on when scanning the actions row. */}
            {item.decisions.slice(0, 3).map((d) => (
              <button
                key={d.label}
                disabled={pending !== null}
                onClick={() => void handleDecision(d)}
                className="rounded border border-primary/30 bg-primary/10 px-2 py-1 font-mono text-micro font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                data-testid={`triage-decision-${d.label}`}
              >
                {pending === d.label ? '…' : d.label}
              </button>
            ))}

            {/* Recipe verb buttons (e.g. "Restart daemon" for daemon-code-drift).
                Three-tier hierarchy:
                  primary  → highlight-filled (server marks these explicitly)
                  default  → secondary bordered (neutral — "do this if unsure")
                  snooze   → ghost (lowest commitment; tertiary)
                  copy     → subtle ghost-border (utility, not an action)
                  destructive → error-tinted (already handled) */}
            {verbs.map((verb) => (
              <button
                key={verb.op === 'copy' ? `copy-${verb.label}` : verb.op}
                disabled={pending !== null}
                onClick={() => void handleVerb(verb.op, verb.hint)}
                className={
                  verb.style === 'destructive'
                    ? 'rounded border border-error/40 bg-error/5 px-2 py-1 font-mono text-micro text-error transition-colors hover:bg-error/10 disabled:opacity-50'
                    : verb.style === 'primary'
                    ? 'rounded border border-highlight/60 bg-highlight/10 px-2 py-1 font-mono text-micro font-medium text-highlight transition-colors hover:bg-highlight/20 disabled:opacity-50'
                    : verb.op === 'copy'
                    ? 'rounded border border-border px-1.5 py-0.5 font-mono text-micro text-muted-foreground transition-colors hover:bg-border/40 hover:text-foreground disabled:opacity-50'
                    : verb.style === 'snooze'
                    ? 'rounded px-2 py-1 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50'
                    : 'rounded border border-border px-2 py-1 font-mono text-micro text-foreground transition-colors hover:bg-border/40 hover:text-foreground disabled:opacity-50'
                }
                data-testid={`triage-verb-${verb.op}`}
              >
                {pending === verb.op ? '…' : verb.label}
              </button>
            ))}

            {/* Continue / Restart inline actions — only for task-recovery kinds.
                daemon-code-drift, gate-enrichment, and other system-level kinds
                use server-side verbs/decisions above instead. A task whose
                single recovery attempt is already spent gets carry-forward CLI
                hints instead (Continue/Restart would just error). */}
            {isTaskRecovery && isRecoveryExhausted && (
              <div
                className="mt-1 flex w-full flex-col gap-2 rounded border border-warn/30 bg-warn/5 px-3 py-2"
                data-testid="triage-recovery-exhausted"
              >
                <p className="font-mono text-micro text-warn">
                  Recovery spent — carry the work forward:
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-micro text-warn/70 select-all">
                    mars remerge {item.entityId}
                  </code>
                  <button
                    disabled={pending !== null}
                    onClick={() => void handleVerb('remerge')}
                    className="rounded border border-warn/60 bg-warn/10 px-2 py-1 font-mono text-micro text-warn transition-colors hover:bg-warn/20 disabled:opacity-50"
                    data-testid="triage-remerge"
                  >
                    {pending === 'remerge' ? '…' : 'Remerge'}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-micro text-warn/70 select-all">
                    mars task add --supersede {item.entityId}
                  </code>
                  <button
                    disabled={pending !== null}
                    onClick={() => void handleVerb('supersede')}
                    className="rounded border border-warn/40 px-2 py-1 font-mono text-micro text-warn transition-colors hover:bg-warn/10 disabled:opacity-50"
                    data-testid="triage-supersede"
                  >
                    {pending === 'supersede' ? '…' : 'Supersede'}
                  </button>
                </div>
              </div>
            )}

            {isTaskRecovery && !isRecoveryExhausted && (
              <>
                {/* Continue is the documented default recovery verb (reuses the
                    existing worktree/branch) — it stays visually primary. */}
                <button
                  disabled={pending !== null}
                  onClick={() => void handleVerb('continue')}
                  className="rounded border border-highlight/60 bg-highlight/10 px-2.5 py-1 font-mono text-micro font-medium text-highlight transition-colors hover:bg-highlight/20 disabled:opacity-50"
                  data-testid="triage-continue"
                >
                  {pending === 'continue' ? '…' : 'Continue'}
                </button>

                {/* Restart discards worktree/branch commits — demoted to a
                    neutral affordance and gated behind an in-app confirm step
                    (never window.confirm, so it stays testable and non-blocking). */}
                {confirmRestart ? (
                  <span
                    className="flex w-full flex-wrap items-center gap-2 rounded border border-error/40 bg-error/5 px-2 py-1.5"
                    data-testid="triage-restart-confirm"
                  >
                    <span className="flex-1 font-mono text-micro text-error">
                      Discard {item.entityId}
                      {item.humanDetail?.branch ? ` (branch ${item.humanDetail.branch})` : ''} —
                      wipes the worktree and branch, losing any commits the worker
                      made. Continue reuses them instead. This can&rsquo;t be undone.
                    </span>
                    <button
                      disabled={pending !== null}
                      onClick={() => void handleVerb('restart')}
                      className="shrink-0 rounded border border-error/60 bg-error/10 px-2 py-1 font-mono text-micro text-error transition-colors hover:bg-error/20 disabled:opacity-50"
                      data-testid="triage-restart-confirm-yes"
                    >
                      {pending === 'restart' ? '…' : 'Yes, discard & restart'}
                    </button>
                    <button
                      disabled={pending !== null}
                      onClick={() => setConfirmRestart(false)}
                      className="shrink-0 rounded border border-border px-2 py-1 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      data-testid="triage-restart-cancel"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    disabled={pending !== null}
                    onClick={() => setConfirmRestart(true)}
                    className="rounded border border-border px-2 py-1 font-mono text-micro text-muted-foreground transition-colors hover:border-error/40 hover:text-error disabled:opacity-50"
                    data-testid="triage-restart"
                  >
                    Restart
                  </button>
                )}
              </>
            )}
          </>
        )}

        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void handleChat()}
          className="ml-auto font-mono text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          data-testid="triage-chat"
        >
          {pending === 'chat' ? '…' : 'Chat →'}
        </button>
      </div>

      {/* Error feedback — shown inline below the actions row */}
      {error && (
        <p
          className="mt-1 font-mono text-micro text-error"
          data-testid="triage-error"
        >
          {error}
        </p>
      )}

      {/* Settling indicator — shown while the action-queue feed re-fetches after
          a condition-kind verb. The row disappears on its own once the refetched
          feed no longer contains this item; while the condition still holds, the
          row returns to normal state so the operator can see it persists. */}
      {settling && (
        <p
          className="mt-1 font-mono text-micro text-muted-foreground"
          data-testid="triage-settling"
        >
          Checking…
        </p>
      )}
    </div>
  )
}

// ── FeedErrorCard ─────────────────────────────────────────────────────────────

interface FeedErrorCardProps {
  label: string
  error: Error
}

/**
 * Inline error card shown when a single data feed fails to load.
 * Keeps the rest of the triage page visible — a single failed feed
 * must never blank the whole view.
 *
 * The wording comes from `describeFeedFailure` so the card names the actual
 * failure and the exact command that fixes it, rather than the old catch-all
 * "try refreshing or restarting the daemon" (which was wrong advice whenever
 * the daemon was simply not running).
 */
const FeedErrorCard = ({ label, error }: FeedErrorCardProps) => {
  const { message, remedy } = describeFeedFailure(error, label)
  return (
    <div
      className="mars-card border-l-2 border-l-error px-4 py-3"
      data-testid={`triage-feed-error-${label.replace(/\s+/g, '-')}`}
      role="alert"
    >
      <p className="font-mono text-label text-error">
        {message} — {label} is unavailable
      </p>
      {remedy && (
        <p className="mt-1 font-mono text-micro text-muted-foreground">
          Fix it with{' '}
          <code className="rounded bg-error/10 px-1 py-0.5 text-error">
            {remedy}
          </code>
        </p>
      )}
    </div>
  )
}

// ── EmptyState ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  running: number
  doneToday: number
}

/**
 * Shown when the daemon is not running.
 *
 * An empty action queue and an action queue that could not be read look
 * identical once the error is dropped, and the old page rendered "All quiet —
 * nothing running" for both. Over a dead daemon that is the most misleading
 * thing this page could say: the operator's whole picture is missing at exactly
 * the moment it reassures them.
 */
const UnreachableState = () => (
  <div
    className="flex flex-col items-center justify-center py-24 text-center"
    data-testid="triage-unreachable"
    role="alert"
  >
    <span className="mb-3 text-4xl text-error opacity-40" aria-hidden="true">
      ⃠
    </span>
    <p className="mb-1 text-title font-medium text-foreground">
      {DAEMON_DOWN_MESSAGE}
    </p>
    <p className="font-mono text-label text-muted-foreground">
      Nothing here is current. Start it with{' '}
      <code className="rounded bg-error/10 px-1 py-0.5 text-error">
        mars daemon start
      </code>
    </p>
  </div>
)

/**
 * Shown for the brief window between mount and the first successful (or
 * failed) response. Without this, the page rendered `EmptyState` — "All
 * quiet" — while the request was still in flight, which is the same
 * false-empty failure mode as swallowing a fetch error: the operator reads
 * a transient loading frame as "nothing to do".
 */
const LoadingState = () => (
  <div
    className="flex flex-col items-center justify-center py-24 text-center"
    data-testid="triage-loading"
    aria-busy="true"
  >
    <span className="mb-3 text-4xl text-muted-foreground opacity-30" aria-hidden="true">
      ◌
    </span>
    <p className="font-mono text-label text-muted-foreground">Loading…</p>
  </div>
)

const EmptyState = ({ running, doneToday }: EmptyStateProps) => (
  <div className="flex flex-col items-center justify-center py-24 text-center">
    <span
      className="mb-3 text-4xl opacity-20"
      style={{ color: 'var(--color-amber)' }}
      aria-hidden="true"
    >
      ◆
    </span>
    <p className="mb-1 text-title font-medium text-foreground">All quiet</p>
    <p className="font-mono text-label text-muted-foreground">
      {running > 0 ? `${running} running` : 'nothing running'}
      {doneToday > 0 ? ` · ${doneToday} done today` : ''}
    </p>
  </div>
)

// ── TriagePage ────────────────────────────────────────────────────────────────

export const TriagePage = () => {
  const { items, error: queueError, isPending: queuePending } = useActionQueue()
  const { isDown } = useDaemonHealth()
  const { byCluster, aggregates } = useProgress()
  // Proposals is a third independent feed. Its error is surfaced as an inline
  // card so a schema-validation failure or network blip never blanks the page.
  const { error: proposalsError } = useProposals()
  const connected = useSseConnected()

  const running = byCluster['In progress'].length
  const doneToday = aggregates.doneToday

  const sorted = sortItems(items)
  const renderedRows = buildRenderedRows(sorted)
  const needsYouCount = countNeedsYou(items)

  // Surface the pending count in the browser tab so the queue is glanceable
  // from the tab bar without switching to it.  While the SSE stream is
  // disconnected the count is potentially stale, so we drop the "(n)" prefix
  // to avoid presenting a confident-but-wrong number in the tab bar.
  useEffect(() => {
    document.title =
      connected && needsYouCount > 0
        ? `(${needsYouCount}) Needs You — mars`
        : 'Needs You — mars'
  }, [needsYouCount, connected])

  // Only show the empty state when every feed succeeded AND there is genuinely
  // nothing to act on. A feed error is itself something to surface, so the
  // empty state must never hide it.
  //
  // `isDown` is checked independently of the feed errors because it is a
  // positive signal (see useDaemonHealth): /api/projects succeeds and reports
  // the daemon as down. Relying on the feed errors alone left a window where
  // the queries had not yet settled into an error state and the page cheerfully
  // announced "All quiet".
  const hasAnyError = queueError !== null || proposalsError !== null
  const hasContent = renderedRows.length > 0 || hasAnyError
  // The action-queue query's first fetch hasn't settled yet (no cached data,
  // no error). Without this check the page fell through to EmptyState during
  // that window and showed "All quiet" — indistinguishable from a genuinely
  // clear queue, the same false-empty failure this page exists to avoid.
  const isLoading = queuePending === true && !hasContent && !isDown

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="flex shrink-0 items-center border-b border-border px-5 py-3.5 shadow-sm">
        <h1 className="font-mono text-title font-semibold text-foreground">
          Needs You
        </h1>
        {needsYouCount > 0 && (
          <span
            aria-label={
              needsYouCount === 1
                ? '1 item needs attention'
                : `${needsYouCount} items need attention`
            }
            className="ml-2.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-primary/20 bg-primary/15 px-1.5 font-mono text-micro font-medium leading-none text-primary"
          >
            {needsYouCount}
          </span>
        )}
        <a
          href="#/chat"
          className="ml-auto font-mono text-micro text-muted-foreground transition-colors hover:text-foreground"
        >
          Chat →
        </a>
      </div>

      {/* Ranked list */}
      <div className="flex-1 overflow-y-auto">
        {isDown && renderedRows.length === 0 ? (
          <UnreachableState />
        ) : isLoading ? (
          <LoadingState />
        ) : !hasContent ? (
          <EmptyState running={running} doneToday={doneToday} />
        ) : (
          <div className="flex flex-col gap-4 p-4">
            {/* Inline error cards — one per failing feed, never blanking the page */}
            {queueError && <FeedErrorCard label="action queue" error={queueError} />}
            {proposalsError && <FeedErrorCard label="proposals" error={proposalsError} />}
            {renderedRows.map((row) => {
              if (row.type === 'cluster') {
                return (
                  <TriageClusterRow
                    key={`cluster:${row.kind}`}
                    kind={row.kind}
                    count={row.count}
                    latestAt={row.latestAt}
                  />
                )
              }
              // Entity group: several conditions derived for ONE task. Render
              // the precedence-chosen row and surface the rest as read-only
              // badges, so the card exposes exactly one verb set.
              if (row.type === 'entityGroup') {
                return (
                  <TriageRow
                    key={row.primary.id}
                    item={row.primary}
                    extraBadges={row.badgeKinds}
                  />
                )
              }
              return <TriageRow key={row.item.id} item={row.item} />
            })}
          </div>
        )}
      </div>
    </div>
  )
}
