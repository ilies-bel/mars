import { useCounts } from '@/entities/counts/useCounts'
import { SelectField } from '@/components/SelectField'
import { Chip, type ChipTone } from '@/components/Chip'
import { AlertTriangle, Archive, ArrowRight, ChevronDown, ChevronRight, Circle, CircleDashed, Clock, FileText, Gauge, GitBranch, HelpCircle, MessageSquare, MoreHorizontal, PowerOff, RefreshCw, Search, SearchX, ShieldAlert, ShieldX, Sparkles, Undo2, UserCheck, XCircle, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ActionButton, ActionLink } from '@/components/ActionButton'
import { PAGE_MEASURE, PageHeader } from '@/widgets/primitives/DensityPrimitives'
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
import { sortItems, buildRenderedRows, type RenderedRow } from '@/entities/actionQueue/clusterRows'
import { filterQueue } from '@/entities/actionQueue/filterQueue'
import { useProgress } from '@/hooks/useProgress'
import { useProposals } from '@/entities/proposals/useProposals'
import { useDaemonHealth } from '@/entities/daemon/useDaemonHealth'
import { DAEMON_DOWN_MESSAGE } from '@/widgets/DaemonDownBanner'
import { describeFeedFailure } from '@/shared/feedFailure'
import { postDecision, snoozeActionQueueItem } from '@/shared/api'
import { relativeTime } from '@/shared/time'
import { dispatchAlertVerb } from '@/widgets/chat/alertVerbs'
import { signatureFamilyPhrase, causeGroupPhrase } from '@/shared/causePhrase'
import { CollapsibleSection } from '@/components/CollapsibleSection'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { defaultAqUrlState, encodeAqState } from '@/shared/actionQueueUrlState'
import { taskHash, parseTriageKind } from '@/shared/routing'
import { prdTitleFromBody } from '@/shared/memberName'
import { hasResolvableTask, isConditionActionQueueKind } from '@/shared/schemas'
import type { ActionQueueItem, ActionQueueKind } from '@/shared/schemas'
import type { Decision } from '@/shared/schemas'

// ── Kind display ──────────────────────────────────────────────────────────────

/**
 * One Lucide icon per action-queue kind.
 *
 * This was a map of Unicode dingbats — ◔ ⌧ ◌ ⊗ ⊘ ↩ ↻ ✦ ◈ — which share no
 * stroke weight, no optical size and no baseline, and which each platform
 * substitutes from a different fallback font. Three kinds all resolved to the
 * same ⊘, so "gate broken", "baseline broken" and "dirty integration" were
 * indistinguishable on the card face. Real icons are drawn on one grid.
 */
const KIND_ICON: Record<string, LucideIcon> = {
  failed: AlertTriangle,
  'daemon-killed': PowerOff,
  'stale-queued': Clock,
  'stale-worktree': Archive,
  'draft-proposal': FileText,
  'awaiting-validation': CircleDashed,
  'arc-failed': XCircle,
  'awaiting-human': UserCheck,
  'coder-question': HelpCircle,
  'diagnose-inconclusive': SearchX,
  'reflect-recommended': Sparkles,
  'scorer-suggested': Gauge,
  'gate-broken': ShieldAlert,
  'recovery-abandoned': Undo2,
  'baseline-broken': ShieldX,
  'daemon-code-drift': RefreshCw,
  'signature-storm': Zap,
  'dirty-integration': GitBranch,
}

/** Renders the kind's icon at chip scale; Circle is the unknown-kind fallback. */
const kindIconNode = (kind: string) => {
  const Icon = KIND_ICON[kind] ?? Circle
  return <Icon size={11} strokeWidth={2} aria-hidden="true" />
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
 *
 * A label here has to be readable by someone who has never read this file, and
 * it has to use the same word for a thing as the card body printed underneath
 * it. Four did neither and were changed:
 *
 *   'sig wave'     → 'shared cause'   the body says "a shared environmental cause"
 *   'storm'        → 'failure storm'  "storm" alone names no subject
 *   'daemon drift' → 'engine update'  the body says "an update is available for
 *                                     the background engine"
 *   'daemon died'  → 'engine crashed' same word for the same thing
 *
 * "daemon" is an implementation word that appears nowhere in the copy an
 * operator reads; the UI calls it the background engine everywhere else.
 */
const KIND_LABEL: Record<ActionQueueKind, string> = {
  // ── condition kinds ──────────────────────────────────────────────────────
  failed: 'failed',
  'stale-queued': 'stale',
  'stale-queued-summary': 'stale summary',
  'gate-broken': 'gate broken',
  'subscriber-stalled': 'stalled',
  'signature-storm': 'failure storm',
  'signature-wave': 'shared cause',
  'daemon-died': 'engine crashed',
  'daemon-code-drift': 'engine update',
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
  const kindIcon = kindIconNode(kind)
  const kindTone = KIND_TONE[kind] ?? 'neutral'
  const isDraftProposal = kind === 'draft-proposal'

  return (
    <div
      className="mars-card group/row relative rounded-lg bg-card px-4 py-3"
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
      <ActionLink
        href={isDraftProposal ? '#/proposals' : '#/triage'}
        variant="ghost"
        size="sm"
        data-testid={isDraftProposal ? 'cluster-proposals-link' : 'cluster-view-link'}
      >
        {isDraftProposal ? 'Review proposals' : 'View all'}
        <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
      </ActionLink>
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
  /**
   * Set when this row is a member of an expanded cause group: the sentence the
   * group header already stated once, on the reader's behalf.
   *
   * Expanding the "17 tasks · slice failed" cluster used to reveal seventeen
   * byte-identical cards — same chip, same `high`, same `1d ago`, same
   * sentence — four screens of them. The only reason to open a cluster is to
   * find out WHICH members are in it and whether they are really the same
   * thing, and the expansion answered neither. (Verified: 17 members, one
   * distinct rendering.)
   *
   * With this set the row drops what the group already said and leads with
   * what distinguishes it instead.
   *
   * It is an object rather than a bare string precisely so that "this row is
   * inside a group" and "the group has a shared sentence" stay separate
   * questions. Conflating them meant the 7-member `failed` group — whose
   * members carry different titles but the same kind and the same priority —
   * kept rendering seven `failed` chips and seven `high` chips.
   */
  groupContext?: {
    /**
     * What sets THIS member apart from its siblings, chosen by the group.
     *
     * The group decides, because only the group can see whether a field
     * actually varies. A row asked to pick for itself reached for its title,
     * which on the seventeen slice-failed members is the same sentence on all
     * of them — a distinguisher that distinguished nothing.
     */
    memberName: string | null
  }
}

const TriageRow = ({ item, extraBadges, groupContext }: TriageRowProps) => {
  const qc = useQueryClient()
  const projectId = useFocusedProjectId() ?? undefined
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState(false)
  /**
 * Does this action destroy work?
 *
 * Two reasons the client has to decide this itself rather than trust the row:
 *
 *  - `zDecision` is only { label, endpoint, payload } — the daemon sends no
 *    style hint at all for decisions.
 *  - For verbs it sends one, and it is wrong where it matters most: the
 *    `restart` verb arrives as `style: 'primary'`, so "Restart task" rendered
 *    in the same filled flame chrome as "Copy gate command". In Mars, restart
 *    is not a benign retry — it wipes the worktree and branch and discards the
 *    worker's commits. A UI must never dress that as the safe default, so this
 *    check OVERRIDES the server's style rather than deferring to it.
 *
 * The list is short and matches whole words only. A false positive just makes
 * a safe button quieter; a false negative is the failure that costs work.
 */
const isDestructiveAction = (label: string): boolean => {
  // `restart` means two different things and only one of them destroys work.
  // `restart-daemon` ("Restart engine") bounces the daemon process: in-flight
  // tasks re-queue and nothing is lost, and on the daemon-drift card it is the
  // RECOMMENDED action — the copy directly above the button says "you need to
  // restart the engine". Painting that in the stop colour makes the button
  // argue with the sentence. `restart` on a TASK is the destructive one.
  if (/\brestart[-_]?daemon\b|restart engine/i.test(label)) return false
  return /\b(restart|purge|drop|delete|retire|discard|wipe|remove|abort|reset)\b/i.test(label)
}

/**
 * Destructiveness of a server-sent decision.
 *
 * The daemon classifies verbs at source (`style: 'destructive'`). This ORs that
 * classification with the label heuristic rather than deferring to it, so the
 * two can only disagree in the safe direction: a decision either side flags as
 * destructive is painted as destructive. That preserves the bias documented
 * above — a false positive only makes a safe button quieter, while a false
 * negative dresses a work-destroying verb as the safe default.
 */
const isDestructiveDecision = (d: Decision): boolean =>
  d.style === 'destructive' || isDestructiveAction(d.label)

/**
 * Index of the row's single primary action, or -1 when every decision is
 * destructive.
 *
 * The ladder allows exactly ONE filled button per row, so "which decision is
 * the CTA" is a property of the row and has to be decided once for it, not
 * per button. The daemon may nominate one (`style: 'primary'`); absent a
 * nomination the first non-destructive decision wins by position. A
 * destructive decision is never the CTA, however it is styled at source —
 * the whole point of the ladder is that the safe path is the magnetic one.
 */
const leadDecisionIndex = (decisions: Decision[]): number => {
  const nominated = decisions.findIndex(
    (d) => !isDestructiveDecision(d) && d.style === 'primary',
  )
  return nominated !== -1
    ? nominated
    : decisions.findIndex((d) => !isDestructiveDecision(d))
}

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

  // ── Inside an expanded cause group ────────────────────────────────────────
  //
  // Members share `(kind, failureReasonCode)` BY CONSTRUCTION — that is what
  // put them in the group — so the kind chip, the priority chip, the cause
  // phrase and the recipe's advice for that cause are identical on every one
  // of them. The group header states each once, above. A member repeats none
  // of them, and leads instead with the name the group picked for it.
  //
  // This is a structural rule, not a string comparison. Comparing strings was
  // the first attempt and it failed on exactly the case it existed for: the
  // group header reads "Coding step failed — cause not identified" while each
  // member's subhead reads "Coding step failed", so seven members went on
  // restating the cause under a header that had just given it.
  const inGroup = groupContext !== undefined
  const memberName = groupContext?.memberName ?? null
  // An advisory is not a name, and the title slot is for names.
  //
  // Several kinds put a full recommendation in humanSummary — "N tasks all
  // failed the same way — this points to a shared environmental cause, not
  // individual task bugs. Fix the root cause to unblock all of them." Rendered
  // at 17px semibold that template became the loudest thing on the inbox, and
  // two sig-wave cards showed the SAME sentence twice, outranking every row
  // that had a real subject. So "what needs you" was answered by whichever row
  // shouted, and the shouting rows were boilerplate.
  //
  // Shape, not kind, is the reliable test: a title is a noun phrase, an
  // advisory is one or more sentences. This does not rewrite any copy — the
  // text is the daemon's — it just stops promoting prose into the name slot.
  const headlineIsAdvisory =
    headline !== null && (headline.length > 88 || /[.!?]\s/.test(headline))
  const kindLabel = KIND_LABEL[item.kind] ?? item.kind.replace(/-/g, ' ')
  const kindIcon = kindIconNode(item.kind)
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
      className="mars-card group/row relative rounded-lg bg-card px-4 py-3"
    >
      {/* Top row: kind chip + priority badge + age.
          Inside a group the kind and the priority are properties of the GROUP,
          identical on every member — seventeen `slice failed` chips and
          seventeen `high` chips said nothing seventeen times. The group header
          states both, once. */}
      <div className="mb-1.5 flex items-center gap-2">
        {!inGroup && (
          <>
            <Chip tone={kindTone} icon={kindIcon}>
              {kindLabel}
            </Chip>
            {item.priority === 'high' && <Chip tone="error">high</Chip>}
            {item.priority === 'normal' && <Chip tone="neutral">normal</Chip>}
          </>
        )}
        {inGroup && !goal && memberName !== null && (
          <span
            className="min-w-0 flex-1 truncate text-label font-medium text-foreground"
            data-testid="cause-group-member-name"
            title={memberName}
          >
            {memberName}
          </span>
        )}
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
          {/* A member sits one level below its group, so it is set one step
              down the scale (15px vs 17px). At 17px the members were louder
              than the group header that contains them, which inverts the
              nesting the expansion exists to express. */}
          <p
            className={`mb-1 font-semibold leading-snug text-foreground line-clamp-2 ${
              inGroup ? 'text-title' : 'text-section'
            }`}
            data-testid="triage-goal"
          >
            {goal.split('\n')[0]?.trim()}
          </p>
          {!inGroup && (
            <p
              className="text-label text-muted-foreground"
              data-testid="triage-title-subhead"
            >
              {signatureFamilyPhrase(item.humanDetail?.failureSignature) ?? item.title}
            </p>
          )}
          {item.humanSummary && !inGroup && (
            <p className="mt-1 text-label leading-relaxed text-muted-foreground line-clamp-2">
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
        // Inside a group, a headline the group header already stated is not
        // repeated — that repetition IS the wallpaper.
        headline &&
        !inGroup && (
          <p
            className={
              headlineIsAdvisory
                ? 'mb-1 text-body leading-relaxed text-foreground'
                : 'mb-1 text-section font-semibold leading-snug text-foreground'
            }
          >
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
          className="mb-2 -ml-1.5 inline-flex h-6 w-fit items-center gap-1 rounded-md px-1.5 text-label font-medium text-highlight transition-colors duration-[var(--dur-fast)] hover:bg-highlight/10 hover:text-foreground"
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
            {item.decisions.slice(0, 3).map((d, i) => {
              // A decision's destructiveness decides its rung. Every decision
              // used to render `variant="primary"`, so "Copy gate command" and
              // "Restart task" wore identical filled chrome — and in Mars,
              // restart WIPES the worktree and branch and discards the worker's
              // commits. A verb that destroys work must never look like the
              // safe default.
              const destructive = isDestructiveDecision(d)
              // The ladder allows exactly ONE primary per row (see
              // ActionButton); `slice(0, 3)` was rendering up to three. The
              // CTA is the daemon's nominee if it named one, else the first
              // non-destructive decision; the rest are real alternatives.
              const isLeadSafe =
                !destructive && leadDecisionIndex(item.decisions) === i
              return (
                <ActionButton
                  key={d.label}
                  variant={destructive ? 'danger' : isLeadSafe ? 'primary' : 'secondary'}
                  disabled={pending !== null}
                  pending={pending === d.label}
                  onClick={() => void handleDecision(d)}
                  data-testid={`triage-decision-${d.label}`}
                >
                  {d.label}
                </ActionButton>
              )
            })}

            {/* Recipe verb buttons. For task-recovery rows, copy verbs have
                moved into the "⋯ More" disclosure (mainVerbs excludes them);
                non-copy verbs (purge, dismiss, …) remain here as they are the
                primary CTA for their recipe, not secondary recovery verbs.
                Verbs whose label already appears in item.decisions are filtered
                out to prevent duplicate buttons (e.g. "Snooze Snooze" when the
                server emits snooze in both the decisions and verbs arrays). */}
            {mainVerbs
              .filter((v) => !item.decisions.some((d) => d.label === v.label))
              .map((verb, vi, shown) => {
              const destructive =
                verb.style === 'destructive' ||
                isDestructiveAction(verb.op) ||
                isDestructiveAction(verb.label)
              // ONE filled primary per card (the ladder's own rule). The
              // daemon marks several verbs `primary` on the same row — a
              // gate-broken card arrived with "Copy gate command", "Add
              // proposed gate" and "No gate needed" all filled, which is three
              // focal points and therefore none. The first one keeps the fill;
              // the rest drop to secondary, which is what they are.
              // A clipboard copy is never the call to action, whatever the
              // daemon says: "Copy gate command" arrived as `primary` and so
              // took the filled slot away from "Add proposed gate", which is
              // the verb that actually changes something.
              const eligible = (v: typeof verb) =>
                v.style === 'primary' &&
                v.op !== 'copy' &&
                !(isDestructiveAction(v.op) || isDestructiveAction(v.label))
              const leadPrimary = shown.findIndex(eligible) === vi
              return (
              <ActionButton
                key={verb.op === 'copy' ? `copy-${verb.label}` : verb.op}
                disabled={pending !== null}
                pending={pending === verb.op}
                onClick={() => void handleVerb(verb.op, verb.hint)}
                size={verb.op === 'copy' ? 'sm' : 'md'}
                variant={
                  // The destructive check comes FIRST and outranks the
                  // server-sent style — see isDestructiveAction.
                  destructive
                    ? 'danger'
                    : verb.style === 'primary' && verb.op !== 'copy' && leadPrimary
                      ? 'primary'
                      : verb.style === 'snooze' || verb.op === 'copy'
                        ? 'ghost'
                        : 'secondary'
                }
                data-testid={`triage-verb-${verb.op}`}
              >
                {verb.label}
              </ActionButton>
              )
            })}

            {/* Recovery-exhausted carry-forward panel — only for task-recovery
                kinds whose single recovery attempt has already been spent. */}
            {isTaskRecovery && isRecoveryExhausted && (
              <div
                className="mt-1 flex w-full flex-col gap-2 rounded border border-warn/30 bg-warn/5 px-3 py-2"
                data-testid="triage-recovery-exhausted"
              >
                <p className="text-micro text-warn">
                  Recovery spent — carry the work forward:
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-micro text-warn/70 select-all">
                    mars remerge {item.entityId}
                  </code>
                  <button
                    disabled={pending !== null}
                    onClick={() => void handleVerb('remerge')}
                    className="rounded border border-warn/60 bg-warn/10 px-2 py-1 text-micro text-warn transition-colors hover:bg-warn/20 disabled:opacity-50"
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
                    className="rounded border border-warn/40 px-2 py-1 text-micro text-warn transition-colors hover:bg-warn/10 disabled:opacity-50"
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
                className="rounded border border-warn/40 px-2 py-1 text-micro text-warn transition-colors hover:bg-warn/10 disabled:opacity-50"
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
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              data-testid="triage-chat"
            >
              <MessageSquare size={13} strokeWidth={2} aria-hidden="true" />
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
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
              >
                <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
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
                  className="shrink-0 rounded border border-error/60 bg-error/10 px-2 py-1 text-micro text-error transition-colors hover:bg-error/20 disabled:opacity-50"
                  data-testid="triage-restart-confirm-yes"
                >
                  {pending === 'restart' ? '…' : 'Yes, discard & restart'}
                </button>
                <button
                  disabled={pending !== null}
                  onClick={() => setConfirmRestart(false)}
                  className="shrink-0 rounded border border-border px-2 py-1 text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
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
          <ActionLink
            href={chatHref}
            variant="ghost"
            size="sm"
            className="ml-auto"
            data-testid="triage-chat"
          >
            Chat
            <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
          </ActionLink>
        )}
      </div>

      {/* Error feedback — shown inline below the actions row */}
      {error && (
        <p
          className="mt-1 text-micro text-error"
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
          className="mt-1 text-micro text-muted-foreground"
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
  const kindIcon = kindIconNode(group.kind)
  const kindTone = KIND_TONE[group.kind] ?? 'neutral'

  // Cause sentence for the face of the row. See causeGroupPhrase: the mapped
  // phrase wins over the daemon's `causeLabel`, which is usually the raw
  // failure slug, and anything left over is de-slugified rather than printed
  // verbatim. This row was the last surface still putting `unclassified` and
  // `done-with-unverifiable-merge` in front of an operator.
  const label = causeGroupPhrase(group.signature, group.causeLabel)

  /**
   * Which field to name each member by — decided here, where every member is
   * in view, because only from here is it knowable whether a field varies.
   *
   * Tried in descending order of how much it tells a reader; the first one
   * that is genuinely distinct across the whole group wins.
   *
   * `entityId` is the last resort and it is a slug, which this UI otherwise
   * keeps off the face of a card. It earns the exception in the one case where
   * it is not decoration: when every other field is identical, the id is the
   * ONLY fact separating one row from the next, and it is what the operator
   * pastes into a command to act on it. Seventeen identical sentences would be
   * strictly less honest.
   *
   * Slice-failed rows arrive with operatorGoal null, but the PRD's real title
   * is present in the body, inside a sentence the daemon writes from a fixed
   * template. `prdTitleFromBody` reads it from there anchored on the row's own
   * id, so it recovers a real name without scraping prose for anything that
   * merely looks like one. The upstream fix — sending the title as a field —
   * is still the right end state and is filed separately.
   */
  const nameOf = ((): ((m: (typeof group.members)[number]) => string | null) => {
    const candidates: Array<(m: (typeof group.members)[number]) => string | null> = [
      // The PRD's real title, read out of the daemon's own sentence about
      // this row. Tried first because it is the only candidate written for a
      // person to read; see prdTitleFromBody for why it cannot match loosely.
      (m) => prdTitleFromBody(m.body ?? null, m.entityId ?? null),
      (m) => m.operatorGoal ?? null,
      (m) => m.arcGoal ?? null,
      (m) => m.title ?? null,
    ]
    for (const get of candidates) {
      const values = group.members
        .map(get)
        .filter((v): v is string => v != null && v !== '')
      if (values.length === group.members.length && new Set(values).size === values.length) {
        return get
      }
    }
    return (m) => m.entityId ?? null
  })()

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
      {/* Header: toggle + blast radius + kind chip + cause sentence + bulk action.
          The count leads and is set in the row's largest type. One cause
          holding seventeen tasks used to render as a `17×` info chip on the
          thinnest row on the page, while a single failed task got a card ten
          times its height — visual weight ran exactly opposite to blast
          radius, so the most consequential row was the easiest to skip. */}
      <div className="flex items-center gap-2.5">
        {/* The whole left-hand run of the header is the toggle, not just the
            chevron. A 24x24 chevron was 1.1% of a 1080px row, so the row that
            stands for the most tasks was also the hardest thing on the page to
            hit; the summary a person actually reads is now the thing they
            click. Bulk actions stay outside it — nesting them would make one
            button contain another. */}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-2.5 rounded px-1 py-1 text-left transition-colors duration-[var(--dur-fast)] hover:bg-foreground/5"
          data-testid="cause-group-toggle"
        >
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
            {expanded ? (
              <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
            )}
          </span>
          <span
            className="flex shrink-0 items-baseline gap-1"
            data-testid="cause-group-count"
          >
            <span className="text-base font-semibold tabular-nums leading-none text-foreground">
              {group.count}
            </span>
            <span className="text-micro text-muted-foreground">
              {group.count === 1 ? 'task' : 'tasks'}
            </span>
          </span>
          <Chip tone={kindTone} icon={kindIcon}>
            {kindLabel}
          </Chip>
          {/* Type scales with blast radius. A cause holding five or more tasks
              is the biggest single thing an operator can resolve in one go, so
              it is set at the same size as a page's own section heading rather
              than in the 12px label type every other row shares. */}
          <span
            className={[
              'min-w-0 flex-1 truncate font-semibold leading-snug text-foreground',
              group.count >= 5 ? 'text-section' : 'text-title',
            ].join(' ')}
            title={label}
          >
            {label}
          </span>
        </button>
        {bulkVerb && (
          <button
            disabled={pending !== null}
            onClick={() => void handleBulkAction()}
            className="shrink-0 rounded border border-border bg-primary/10 px-2 py-1 text-micro font-medium text-muted-foreground transition-colors hover:bg-primary/20 disabled:opacity-50"
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
          className="shrink-0 rounded border border-border px-2 py-1 text-micro text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          data-testid="cause-group-snooze-all"
        >
          Snooze all
        </button>
      </div>

      {error && (
        <p
          className="mt-1 text-micro text-error"
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
            <TriageRow
              key={member.id}
              item={member}
              groupContext={{ memberName: nameOf(member) }}
            />
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
      <p className="text-label text-error">
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
    <p className="text-label text-muted-foreground">Loading…</p>
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
    <p className="text-label text-muted-foreground">
      {running > 0 ? `${running} running` : 'nothing running'}
      {doneToday > 0 ? ` · ${doneToday} done today` : ''}
    </p>
  </div>
)



/**
 * Shown when the filters matched nothing — which is a different fact from an
 * empty queue and has to read as one.
 *
 * It names what was searched (the reader may have typed into a field that had
 * scrolled out of view, or left a kind filter set from an earlier visit), says
 * how much is still behind the filter, and offers the one move that fixes it.
 * An empty page with no explanation makes the reader doubt the queue rather
 * than the query.
 */
const NoMatchesState = ({
  query,
  kind,
  total,
  onClear,
}: {
  query: string
  kind: string
  total: number
  onClear: () => void
}) => {
  const kindLabel = kind
    ? ((KIND_LABEL as Record<string, string | undefined>)[kind] ?? kind.replace(/-/g, ' '))
    : null
  return (
    <div
      className="flex flex-col items-center justify-center py-24 text-center"
      data-testid="triage-no-matches"
    >
      <p className="mb-1 text-title font-medium text-foreground">No matches</p>
      <p className="max-w-[420px] text-label text-muted-foreground">
        {query.trim() !== '' && (
          <>
            Nothing in the queue mentions <span className="text-foreground">{query.trim()}</span>
            {kindLabel ? ' ' : '. '}
          </>
        )}
        {kindLabel && (
          <>
            {query.trim() !== '' ? 'among ' : 'No '}
            <span className="text-foreground">{kindLabel}</span> rows.{' '}
          </>
        )}
        {total > 0 && `All ${total} items are still there.`}
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 rounded-md border border-border px-2.5 py-1 text-label text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        data-testid="triage-clear-filters"
      >
        Clear filters
      </button>
    </div>
  )
}

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
  // The URL owns the kind filter, so the header's parked-task chip
  // (`#/triage?kind=awaiting-human`) lands on a page that is already narrowed,
  // and a filtered view can be linked to and shared.
  const [kindFilter, setKindFilter] = useState(
    () => parseTriageKind(window.location.hash) ?? '',
  )

  // The chip is reachable while Triage is already open, in which case this
  // component never remounts and the initialiser above never runs again.
  // Follow the hash so the filter tracks the URL from either direction.
  useEffect(() => {
    const sync = () => setKindFilter(parseTriageKind(window.location.hash) ?? '')
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  // Choosing a kind by hand writes it back to the URL, so the address bar
  // always describes what is on screen. `replaceState` rather than assigning
  // `location.hash`: flipping through a dropdown should not fill the back
  // button with a dozen entries the operator has to walk out of.
  const selectKind = useCallback((next: string) => {
    setKindFilter(next)
    const url = next === '' ? '#/triage' : `#/triage?kind=${encodeURIComponent(next)}`
    window.history.replaceState(null, '', url)
  }, [])

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

  /**
   * The queue after both controls, in priority-recency order.
   *
   * Both shapes are filtered — loose items AND the daemon's pre-grouped cause
   * rows. Passing `serverGroups` through unfiltered is what made the search
   * box return three confident-looking rows for a gibberish query; see
   * filterQueue.ts.
   */
  const filtered = useMemo(
    () => filterQueue(sorted, serverGroups, { kind: kindFilter, query: searchQuery }),
    [sorted, serverGroups, kindFilter, searchQuery],
  )

  const renderedRows = buildRenderedRows(filtered.items, filtered.groups)
  // The single source of truth for this number — the same value the sidebar
  // badge and the bell render. It used to be recomputed here from the fetched
  // page of action-queue items, which is why one screen could show 29 in the
  // nav, 12 on the bell and 13 in this header at the same moment. See the
  // "Numbers" section of ui/README.md: never add a per-widget count.
  const { needsYou: needsYouCount } = useCounts()

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
  // A filter that matched nothing is not an empty queue. Without this the page
  // answered a gibberish search with "All quiet." while 38 items sat behind
  // the filter — the exact false-empty this page exists to avoid, reached by
  // a different door.
  const filteredToNothing = filtered.active && renderedRows.length === 0 && !hasAnyError
  const hasContent = renderedRows.length > 0 || hasAnyError || filteredToNothing
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
        /* The chip keeps reporting the queue; the subtitle reports the view.
           Both are true and they answer different questions — "how much is
           wrong" and "how much of it am I looking at". With a filter running
           and only the chip on screen, the header claimed 38 while three rows
           were visible. */
        subtitle={
          filtered.active
            ? `showing ${renderedRows.length} of ${needsYouCount}`
            : undefined
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
          <div className={`flex w-full items-center gap-2 ${PAGE_MEASURE}`}>
            <div className="relative flex-1">
              <Search
                size={13}
                strokeWidth={1.75}
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                /* A placeholder is not an accessible name: it is announced as a
                   hint on some engines, not at all on others, and it vanishes
                   the moment anything is typed. This field had no name at all
                   (WCAG 4.1.2, Level A) — a screen reader announced "edit
                   text, blank". */
                aria-label="Search the queue"
                placeholder="Search the queue…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 w-full rounded-md border border-border bg-background pl-7.5 pr-2.5 text-label text-foreground shadow-[var(--shadow-e1)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-muted-foreground focus:border-highlight/50"
                data-testid="triage-search"
              />
            </div>
            <SelectField
              /* Without this the select's accessible name is the concatenation
                 of every option — "All kinds awaiting engine update
                 proposal…" — which is what an unlabelled <select> falls back
                 to and is worse than silence. */
              aria-label="Filter by kind"
              value={kindFilter}
              onChange={(e) => selectKind(e.target.value)}
              data-testid="triage-kind-filter"
            >
              <option value="">All kinds</option>
              {availableKinds.map((k) => (
                <option key={k} value={k}>
                  {(KIND_LABEL as Record<string, string | undefined>)[k] ??
                    k.replace(/-/g, ' ')}
                </option>
              ))}
            </SelectField>
          </div>
        }
      />

      {/* Ranked list. `px-6` is the page gutter — the same one PageHeader
          applies — so it is owned once here and inherited by every state
          below rather than re-declared per branch. */}
      <div className="flex-1 overflow-y-auto px-6">
        {isDown && renderedRows.length === 0 ? (
          <UnreachableState />
        ) : isLoading ? (
          <LoadingState />
        ) : filteredToNothing ? (
          <NoMatchesState
            query={searchQuery}
            kind={kindFilter}
            total={needsYouCount}
            onClear={() => {
              setSearchQuery('')
              selectKind('')
            }}
          />
        ) : !hasContent ? (
          <EmptyState running={running} doneToday={doneToday} />
        ) : (
          <div
            /* A reading column, sharing its left edge with the header above.
               It used to centre itself inside the pane while the header sat at
               the page gutter: measured at 1512px, the h1 and the search field
               started at x=248 and every card started at x=344 and ran to
               1392, so the list was inset 96px from its own header on the left
               and overhung it 53px on the right — aligned to nothing. At
               1024px the inset inverted (card 240 vs h1 248), which is why it
               only showed up once the window was wide, which is where this
               page is looked at.

               PAGE_MEASURE is the shared column, applied here and to the
               toolbar, so the two cannot drift apart again — and shared with
               Draft proposals, which had the identical defect. The cap itself
               earns its keep: at 1680px a queue card put its headline on the
               left, its timestamp 1500px away on the right, and nothing in
               between. The gutter belongs to the scroll container above, the
               same way PageHeader owns its own. */
            className={`flex w-full flex-col gap-3 py-4 ${PAGE_MEASURE}`}
          >
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
