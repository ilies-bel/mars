import { Chip, type ChipTone } from '@/components/Chip'
import { ArrowRight, Search } from 'lucide-react'
import { ActionButton } from '@/components/ActionButton'
import { PageHeader } from '@/widgets/primitives/DensityPrimitives'
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

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { sortItems, buildRenderedRows, countNeedsYou, type RenderedRow } from '@/entities/actionQueue/clusterRows'
import { useProgress } from '@/hooks/useProgress'
import { useProposals } from '@/entities/proposals/useProposals'
import { useDaemonHealth } from '@/entities/daemon/useDaemonHealth'
import { DAEMON_DOWN_MESSAGE } from '@/widgets/DaemonDownBanner'
import { describeFeedFailure } from '@/shared/feedFailure'
import { postDecision, snoozeActionQueueItem } from '@/shared/api'
import { relativeTime } from '@/shared/time'
import { dispatchAlertVerb } from '@/widgets/chat/alertVerbs'
import { signatureFamilyPhrase } from '@/widgets/chat/AlertCard'
import { CollapsibleSection } from '@/components/CollapsibleSection'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { defaultAqUrlState, encodeAqState } from '@/shared/actionQueueUrlState'
import { taskHash } from '@/shared/routing'
import { hasResolvableTask, isConditionActionQueueKind } from '@/shared/schemas'
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
  'signature-wave': 'sig wave',
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
  'slicer-transport-outage': 'slicer outage',
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
  'worktree-hook-trust-request': 'hook trust',
  'phantom-merge': 'phantom merge',
  'phantom-merge-unknown': 'phantom merge?',
}

/** Semantic chip tone per kind — consumed by the shared <Chip> primitive. */
const KIND_TONE: Record<string, ChipTone> = {
  failed: 'error',
  'daemon-killed': 'error',
  'arc-failed': 'error',
  'baseline-broken': 'error',
  'stale-queued': 'warn',
  'stale-worktree': 'warn',
  'dirty-integration': 'warn',
  'daemon-code-drift': 'warn',
  'signature-storm': 'warn',
  'phantom-merge': 'warn',
  'phantom-merge-unknown': 'warn',
  'awaiting-validation': 'trace',
  'draft-proposal': 'success',
}

// ── Action kind sets ──────────────────────────────────────────────────────────

/**
 * Kinds where the entity is a failed task that can be continued / restarted.
 * All other task-failure kinds are system/daemon conditions whose recovery
 * verbs come from the server-side recipe (item.verbs / item.decisions).
 *
 * `done-with-unmerged-commits` is intentionally absent: that kind represents a
 * task whose status is `done`, so `mars continue` (which only works on `failed`
 * tasks) would be refused. Its recipe ships a `restart`/Re-attempt merge verb
 * that the server side handles; the UI renders it via the normal verb row.
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
])

/**
 * Phantom-merge condition kinds: task was marked done but no merge SHA was
 * recorded. These are derived conditions (no stored row). The operator should
 * remerge the branch or supersede the task to carry the work forward.
 * `mars continue` would be refused here — the underlying task is `done`,
 * not `failed` — so these kinds get a dedicated carry-forward panel instead.
 */
const PHANTOM_MERGE_KINDS = new Set(['phantom-merge', 'phantom-merge-unknown'])

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
  const kindTone = KIND_TONE[kind] ?? 'neutral'
  const isDraftProposal = kind === 'draft-proposal'

  return (
    <div
      className="mars-card relative rounded-lg bg-card px-4 py-3"
    >
      {/* Top row: kind chip + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <Chip tone={kindTone} icon={kindIcon}>
          {kindLabel}
        </Chip>
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
  // Controls the "⋯ More" disclosure that hides Restart (and copy verbs) so
  // they require a deliberate second click rather than sitting at the same
  // visual weight as Continue during a failure storm.
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

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

  // Close the "⋯ More" disclosure on click-outside or Escape so it never
  // traps keyboard focus.
  useEffect(() => {
    if (!moreOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    const onMouse = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onMouse)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onMouse)
    }
  }, [moreOpen])

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
  const kindLabel = KIND_LABEL[item.kind] ?? item.kind.replace(/-/g, ' ')
  const kindIcon = KIND_ICON[item.kind] ?? '•'
  const kindTone = KIND_TONE[item.kind] ?? 'neutral'
  const isChatOnly = CHAT_ONLY_KINDS.has(item.kind)
  const isTaskRecovery = TASK_RECOVERY_KINDS.has(item.kind)
  const isRecoveryExhausted = isTaskRecovery && item.recoveryExhausted
  // Phantom-merge: done task with no merge SHA on record. Neither Continue
  // (refused for non-failed tasks) nor Restart (destructive) is the right CTA.
  // A dedicated carry-forward panel offers Remerge (branch still has commits)
  // and Supersede (carry work forward from checkpoint ref).
  const isPhantomMerge = PHANTOM_MERGE_KINDS.has(item.kind)
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
  // For task-recovery rows, copy verbs move into the "⋯ More" disclosure so
  // they don't clutter the primary action row. Non-copy verbs (purge, dismiss,
  // …) remain visible because they are the primary CTA for their recipe.
  const mainVerbs = isTaskRecovery ? verbs.filter((v) => v.op !== 'copy') : verbs
  const disclosureVerbs = isTaskRecovery ? verbs.filter((v) => v.op === 'copy') : []

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

  // Shareable href that carries this alert's identity — the ChatPage resolves
  // (or creates) the scoped thread on arrival so each alert opens its own
  // conversation.
  const chatHref = `#/chat${encodeAqState({
    ...defaultAqUrlState(),
    item: item.id,
    project: projectId ?? null,
  })}`

  if (resolved) return null

  return (
    <div
      className="mars-card relative rounded-lg bg-card px-4 py-3 transition-opacity"
    >
      {/* Top row: kind chip + priority badge + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <Chip tone={kindTone} icon={kindIcon}>
          {kindLabel}
        </Chip>
        {item.priority === 'high' && <Chip tone="error">high</Chip>}
        {item.priority === 'normal' && <Chip tone="neutral">normal</Chip>}
        <span className="ml-auto text-micro tabular-nums text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Other condition rows collapsed into this card (entity grouping —
          see clusterRows.ts). Read-only labels, no buttons: exactly one verb
          set is shown for this task, chosen by ENTITY_GROUP_KIND_RANK. */}
      {extraBadges && extraBadges.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1" data-testid="triage-entity-badges">
          <span className="text-micro text-muted-foreground">also</span>
          {extraBadges.map((badgeKind) => (
            <span
              key={badgeKind}
              className="rounded-full bg-foreground/6 px-1.5 py-0.5 text-micro font-medium leading-[1.4] text-muted-foreground"
              data-testid={`triage-entity-badge-${badgeKind}`}
            >
              {(KIND_LABEL as Record<string, string | undefined>)[badgeKind] ?? badgeKind.replace(/-/g, ' ')}
            </span>
          ))}
        </div>
      )}

      {/* Headline — §7 hierarchy:
           - When operatorGoal is present: goal is primary headline, the subhead
             is derived from the failure signature (plain English), falling back
             to item.title when no mapping exists. humanSummary is tertiary, raw
             error output hides behind "Output" disclosure.
           - Otherwise: humanSummary || title is the sole headline. */}
      {goal ? (
        <>
          <p
            className="mb-1 text-section font-semibold leading-snug text-foreground line-clamp-2"
            data-testid="triage-goal"
          >
            {goal.split('\n')[0]?.trim()}
          </p>
          <p
            className="text-label text-muted-foreground"
            data-testid="triage-title-subhead"
          >
            {signatureFamilyPhrase(item.humanDetail?.failureSignature) ?? item.title}
          </p>
          {item.humanSummary && (
            <p className="mt-1 text-label leading-relaxed text-muted-foreground/85 line-clamp-2">
              {item.humanSummary}
            </p>
          )}
          {(item.humanDetail?.errorExcerpt ?? item.humanDetail?.rawError ?? item.humanDetail?.failureSignature) != null && (
            <CollapsibleSection
              label="Output"
              className="mt-1.5"
              data-testid="triage-output-disclosure"
            >
              <pre className="max-h-28 overflow-y-auto rounded-md border border-border/60 bg-background p-2 font-mono text-micro leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
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
          <p className="mb-1 text-section font-semibold leading-snug text-foreground">
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
          className="mb-2 inline-flex w-fit items-center gap-1 rounded text-label font-medium text-primary transition-colors duration-[var(--dur-fast)] hover:text-foreground hover:underline"
          data-testid="triage-entity-link"
          title={item.entityId}
        >
          → task
        </a>
      )}

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-2">
        {!isChatOnly && (
          <>
            {/* Server-defined decision buttons (recipe-derived per failure kind) —
                Primary tier: filled background so these are the first thing the
                operator's eye lands on when scanning the actions row.
                Decision buttons are NEVER hidden behind disclosure — they are the
                primary CTA for their card type (Enable, Skip, Dismiss, …). */}
            {item.decisions.slice(0, 3).map((d) => (
              <ActionButton
                key={d.label}
                variant="primary"
                disabled={pending !== null}
                pending={pending === d.label}
                onClick={() => void handleDecision(d)}
                data-testid={`triage-decision-${d.label}`}
              >
                {d.label}
              </ActionButton>
            ))}

            {/* Recipe verb buttons. For task-recovery rows, copy verbs have
                moved into the "⋯ More" disclosure (mainVerbs excludes them);
                non-copy verbs (purge, dismiss, …) remain here as they are the
                primary CTA for their recipe, not secondary recovery verbs.
                Verbs whose label already appears in item.decisions are filtered
                out to prevent duplicate buttons (e.g. "Snooze Snooze" when the
                server emits snooze in both the decisions and verbs arrays). */}
            {mainVerbs
              .filter((v) => !item.decisions.some((d) => d.label === v.label))
              .map((verb) => (
              <ActionButton
                key={verb.op === 'copy' ? `copy-${verb.label}` : verb.op}
                disabled={pending !== null}
                pending={pending === verb.op}
                onClick={() => void handleVerb(verb.op, verb.hint)}
                size={verb.op === 'copy' ? 'sm' : 'md'}
                variant={
                  verb.style === 'destructive'
                    ? 'danger'
                    : verb.style === 'primary'
                      ? 'primary'
                      : verb.style === 'snooze' || verb.op === 'copy'
                        ? 'ghost'
                        : 'secondary'
                }
                data-testid={`triage-verb-${verb.op}`}
              >
                {verb.label}
              </ActionButton>
            ))}

            {/* Recovery-exhausted carry-forward panel — only for task-recovery
                kinds whose single recovery attempt has already been spent. */}
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
          </>
        )}

        {/* ── Phantom-merge carry-forward panel ───────────────────────────────
            The task is `done` but no merge SHA was recorded — mars continue
            would be refused (it only works on `failed` tasks). Instead offer
            Remerge (re-land the branch if it still holds commits) and Supersede
            (carry the work forward from the checkpoint ref). For the unknown
            variant (no surviving evidence) only Supersede is applicable. */}
        {isPhantomMerge && (
          <div
            className="mt-1 flex w-full flex-col gap-2 rounded border border-warn/30 bg-warn/5 px-3 py-2"
            data-testid="triage-phantom-merge-panel"
          >
            <p className="font-mono text-micro text-warn">
              {item.kind === 'phantom-merge'
                ? 'Marked done — no merge SHA on record. Carry the commits forward:'
                : 'No surviving evidence — verify manually, then carry forward:'}
            </p>
            {item.kind === 'phantom-merge' && (
              <div className="flex flex-wrap items-center gap-2">
                <code className="select-all font-mono text-micro text-warn/70">
                  mars remerge {item.entityId}
                </code>
                <button
                  disabled={pending !== null}
                  onClick={() => void handleVerb('remerge')}
                  className="rounded border border-warn/60 bg-warn/10 px-2 py-1 font-mono text-micro text-warn transition-colors hover:bg-warn/20 disabled:opacity-50"
                  data-testid="triage-remerge"
                >
                  {pending === 'remerge' ? '…' : 'Remerge — branch still has commits'}
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <code className="select-all font-mono text-micro text-warn/70">
                mars task add --supersede {item.entityId}
              </code>
              <button
                disabled={pending !== null}
                onClick={() => void handleVerb('supersede')}
                className="rounded border border-warn/40 px-2 py-1 font-mono text-micro text-warn transition-colors hover:bg-warn/10 disabled:opacity-50"
                data-testid="triage-supersede"
              >
                {pending === 'supersede' ? '…' : 'Supersede — run from checkpoint'}
              </button>
            </div>
          </div>
        )}

        {/* ── Task-recovery primary actions ────────────────────────────────────
            Continue is the sole visible primary CTA. Restart is hidden behind
            a "⋯" disclosure (two-click path) to prevent misclicks during
            failure storms. The disclosure dropdown is always rendered in the
            DOM (visibility:hidden, pointer-events:none when closed) so that
            [data-testid="triage-restart"] remains queryable in tests — jsdom
            does not honour CSS pointer-events, so .click() still fires.
            Chat is repositioned as an icon button immediately after Continue
            so it is discoverable without dominating the row. */}
        {!isChatOnly && isTaskRecovery && !isRecoveryExhausted && (
          <>
            {/* Continue — sole visible primary CTA */}
            <button
              disabled={pending !== null}
              onClick={() => void handleVerb('continue')}
              className="rounded-md border border-highlight/20 bg-highlight/10 px-3 py-1.5 text-label font-medium text-highlight transition-colors hover:bg-highlight/20 disabled:opacity-50"
              data-testid="triage-continue"
            >
              {pending === 'continue' ? '…' : 'Continue'}
            </button>

            {/* Chat — icon link, positioned after Continue */}
            <a
              href={chatHref}
              title="Open chat thread"
              aria-label="Open chat thread"
              className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
              data-testid="triage-chat"
            >
              ⊙
            </a>

            {/* More ⋯ — disclosure that hides Restart (and copy verbs) */}
            <div ref={moreRef} className="relative">
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
                aria-label="More actions"
                data-testid="triage-more-toggle"
                className="rounded px-1.5 py-1 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                ⋯
              </button>
              {/* Dropdown — always in the DOM; invisible+pointer-events-none
                  when closed so the DOM query in tests still finds elements. */}
              <div
                role="menu"
                className={[
                  'absolute right-0 z-10 mt-1 min-w-36 rounded-lg border border-border bg-card py-1 shadow-lg',
                  moreOpen ? '' : 'invisible pointer-events-none',
                ].join(' ')}
              >
                {/* Restart — error-tinted to signal its destructive nature */}
                <button
                  type="button"
                  role="menuitem"
                  disabled={pending !== null}
                  onClick={() => {
                    setConfirmRestart(true)
                    setMoreOpen(false)
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left font-mono text-micro text-error transition-colors hover:bg-error/5 disabled:opacity-50"
                  data-testid="triage-restart"
                >
                  Restart
                </button>
                {/* Copy verbs (if any) */}
                {disclosureVerbs.map((verb) => (
                  <button
                    key={`copy-${verb.label}`}
                    type="button"
                    role="menuitem"
                    disabled={pending !== null}
                    onClick={() => void handleVerb(verb.op, verb.hint)}
                    className="flex w-full items-center px-3 py-1.5 text-left font-mono text-micro text-muted-foreground transition-colors hover:bg-border/40 hover:text-foreground disabled:opacity-50"
                    data-testid={`triage-verb-${verb.op}`}
                  >
                    {pending === verb.op ? '…' : verb.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Confirm panel — full-width, wraps below the action row when
                Restart is clicked inside the disclosure. The `w-full` class
                forces it to its own flex line inside the gap-2 container. */}
            {confirmRestart && (
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
            )}
          </>
        )}

        {/* Chat → for chat-only rows, non-task-recovery rows, and recovery-
            exhausted rows. Stays at ml-auto (right-aligned) in these cases
            where there is no Continue button to anchor it after. */}
        {(isChatOnly || !isTaskRecovery || isRecoveryExhausted) && (
          <a
            href={chatHref}
            className="ml-auto font-mono text-micro text-muted-foreground transition-colors hover:text-foreground"
            data-testid="triage-chat"
          >
            Chat →
          </a>
        )}
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

// ── TriageCauseGroupRow ───────────────────────────────────────────────────────

/**
 * A collapsible card representing N items that share the same failure cause
 * (`failureReasonCode`). Collapsed by default; shows a count badge, cause
 * label, and a bulk action button. Expanding reveals individual `TriageRow`
 * cards for each member.
 *
 * Mirrors the CLI's cause-grouping model (orchestrator/src/cli/action-queue-group.ts)
 * so a 35-row wall reads as a handful of distinct causes to resolve (HR-3).
 */
export const TriageCauseGroupRow = ({
  group,
}: {
  group: Extract<RenderedRow, { type: 'causeGroup' }>
}) => {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const kindLabel =
    (KIND_LABEL as Record<string, string | undefined>)[group.kind] ??
    group.kind.replace(/-/g, ' ')
  const kindIcon = KIND_ICON[group.kind] ?? '•'
  const kindTone = KIND_TONE[group.kind] ?? 'neutral'

  // Cause label: prefer server-computed causeLabel (HR-3), then the local
  // signatureFamilyPhrase mapping, then fall back to the slug portion after
  // the first `/` (matches the CLI's causeLabel fallback).
  const label =
    group.causeLabel ??
    signatureFamilyPhrase(group.signature) ??
    (group.signature.includes('/')
      ? group.signature.split('/').slice(1).join('/')
      : group.signature)

  // Primary bulk verb: use the kind's recipe-declared bulkResolveVerb (HR-3).
  // A kind that declares none shows only Snooze — no invented action.
  const bulkVerb = group.bulkResolveVerb ?? null

  const handleBulkAction = useCallback(async () => {
    if (!bulkVerb || pending !== null) return
    const total = group.members.length
    setPending(bulkVerb.op)
    setProgress({ done: 0, total })
    setError(null)
    let failCount = 0
    await Promise.allSettled(
      group.members.map(async (member) => {
        try {
          await dispatchAlertVerb(member.id, member.entityId, bulkVerb.op)
        } catch {
          failCount++
        } finally {
          setProgress((p) => (p ? { ...p, done: p.done + 1 } : p))
        }
      }),
    )
    await qc.invalidateQueries({ queryKey: ['action-queue'] })
    setProgress(null)
    setPending(null)
    if (failCount > 0) {
      setError(`${failCount} of ${total} failed — the rest re-appear above`)
    }
  }, [bulkVerb, pending, group.members, qc])

  const handleSnoozeAll = useCallback(async () => {
    if (pending !== null) return
    setPending('snooze')
    setError(null)
    try {
      await Promise.all(
        group.members.map((member) => snoozeActionQueueItem(member.id, '1h')),
      )
      await qc.invalidateQueries({ queryKey: ['action-queue'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }, [pending, group.members, qc])

  return (
    <div
      className="mars-card rounded-lg bg-card px-4 py-3"
      data-testid="cause-group-row"
    >
      {/* Header: toggle + kind chip + count + cause label + bulk action */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground"
          data-testid="cause-group-toggle"
        >
          {expanded ? '▾' : '▸'}
        </button>
        <Chip tone={kindTone} icon={kindIcon}>
          {kindLabel}
        </Chip>
        <Chip tone="info" className="tabular-nums">
          {group.count}×
        </Chip>
        <span className="flex-1 text-label font-medium leading-snug text-foreground">
          {label}
        </span>
        {bulkVerb && (
          <button
            disabled={pending !== null}
            onClick={() => void handleBulkAction()}
            className="shrink-0 rounded border border-primary/30 bg-primary/10 px-2 py-1 font-mono text-micro font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            data-testid="cause-group-bulk-action"
          >
            {progress !== null
              ? `${progress.done} of ${progress.total}…`
              : `${bulkVerb.label} all ${group.count}`}
          </button>
        )}
        <button
          disabled={pending !== null}
          onClick={() => void handleSnoozeAll()}
          className="shrink-0 rounded border border-border px-2 py-1 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          data-testid="cause-group-snooze-all"
        >
          Snooze all
        </button>
      </div>

      {error && (
        <p
          className="mt-1 font-mono text-micro text-error"
          data-testid="cause-group-error"
        >
          {error}
        </p>
      )}

      {/* Expanded member list — individual TriageRow cards */}
      {expanded && (
        <div
          className="mt-3 flex flex-col gap-3"
          data-testid="cause-group-members"
        >
          {group.members.map((member) => (
            <TriageRow key={member.id} item={member} />
          ))}
        </div>
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
      className="mars-card rounded-lg bg-card px-4 py-3"
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
  const { items, serverGroups = [], error: queueError, isPending: queuePending } = useActionQueue()
  const { isDown } = useDaemonHealth()
  const { byCluster, aggregates } = useProgress()
  // Proposals is a third independent feed. Its error is surfaced as an inline
  // card so a schema-validation failure or network blip never blanks the page.
  const { error: proposalsError } = useProposals()
  const running = byCluster['In progress'].length
  const doneToday = aggregates.doneToday

  // ── Search + kind filter ──────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('')

  /**
   * Distinct kinds present in the current queue, alphabetically sorted.
   * Restricted to kinds known at build time (i.e. in KIND_LABEL) so the
   * select never emits raw machine slugs from daemon versions newer than
   * the build — consistent with the existing fallback contract elsewhere
   * in TriagePage where unknown kinds are humanised via .replace(/-/g, ' ').
   */
  const availableKinds = useMemo(() => {
    const kinds = new Set(items.map((i) => i.kind))
    return [...kinds].filter((k) => k in KIND_LABEL).sort()
  }, [items])

  const sorted = sortItems(items)

  /** Items after applying the search + kind filter, in priority-recency order. */
  const filteredSorted = useMemo(() => {
    let result = sorted
    if (kindFilter) result = result.filter((i) => i.kind === kindFilter)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (i) =>
          (i.title && i.title.toLowerCase().includes(q)) ||
          (i.humanSummary && i.humanSummary.toLowerCase().includes(q)) ||
          (i.operatorGoal && i.operatorGoal.toLowerCase().includes(q)) ||
          // entityTitle is the entity's real human name (e.g. the PRD title on
          // slice-failed rows) — preferred over the truncated entityId slug.
          (i.entityTitle && i.entityTitle.toLowerCase().includes(q)) ||
          (i.entityId && i.entityId.toLowerCase().includes(q)),
      )
    }
    return result
  }, [sorted, kindFilter, searchQuery])

  const renderedRows = buildRenderedRows(filteredSorted, serverGroups)
  const needsYouCount = countNeedsYou(items, serverGroups)

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
      <PageHeader
        title="Needs You"
        count={needsYouCount}
        countLabel={
          needsYouCount === 1
            ? '1 item needs attention'
            : `${needsYouCount} items need attention`
        }
        actions={
          <a
            href="#/chat"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-label text-muted-foreground transition-colors duration-[var(--dur-fast)] hover:bg-foreground/5 hover:text-foreground"
          >
            Open in Chat
            <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
          </a>
        }
        /* Search + kind filter — always visible so the operator can narrow a
           35-row wall without scrolling first. */
        toolbar={
          <>
            <div className="relative flex-1">
              <Search
                size={13}
                strokeWidth={1.75}
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                placeholder="Search the queue…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 w-full rounded-md border border-border bg-background pl-7.5 pr-2.5 text-label text-foreground shadow-[var(--shadow-e1)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-muted-foreground/70 focus:border-highlight/50 focus:outline-none focus:ring-2 focus:ring-highlight/15"
                data-testid="triage-search"
              />
            </div>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="h-7 shrink-0 rounded-md border border-border bg-surface px-2 text-label text-foreground shadow-[var(--shadow-e1)] transition-colors duration-[var(--dur-fast)] hover:bg-background focus:border-highlight/50 focus:outline-none focus:ring-2 focus:ring-highlight/15"
              data-testid="triage-kind-filter"
            >
              <option value="">All kinds</option>
              {availableKinds.map((k) => (
                <option key={k} value={k}>
                  {(KIND_LABEL as Record<string, string | undefined>)[k] ??
                    k.replace(/-/g, ' ')}
                </option>
              ))}
            </select>
          </>
        }
      />

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
              // Cause group: many different tasks sharing the same failure cause.
              // Collapsed by default; bulk action applies to all members.
              if (row.type === 'causeGroup') {
                return <TriageCauseGroupRow key={row.id} group={row} />
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
