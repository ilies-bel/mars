/**
 * TriagePage — "Needs you" ranked triage view.
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
 * Badge = count of RENDERED rows (clusters count as 1), so it reflects real
 * operator decisions rather than raw row count.
 *
 * Empty state: "All quiet — N running, N done today".
 */

import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { sortItems, buildRenderedRows } from '@/entities/actionQueue/clusterRows'
import { useProgress } from '@/hooks/useProgress'
import { useProposals } from '@/entities/proposals/useProposals'
import { postDecision } from '@/shared/api'
import { relativeTime } from '@/shared/time'
import { dispatchAlertVerb } from '@/widgets/chat/alertVerbs'
import { deriveCause } from '@/shared/alertCause'
import type { ActionQueueItem } from '@/shared/schemas'
import type { Decision } from '@/shared/schemas'

// ── Kind display ──────────────────────────────────────────────────────────────

const KIND_ICON: Record<string, string> = {
  failed: '⚠',
  'daemon-killed': '⛔',
  'stale-queued': '⏳',
  'stale-worktree': '🗑',
  'draft-proposal': '💡',
  'awaiting-validation': '🔍',
  'arc-failed': '⛓',
  'awaiting-human': '👤',
  'coder-question': '❓',
  'diagnose-inconclusive': '🔬',
  'reflect-recommended': '✦',
  'scorer-suggested': '◈',
}

const KIND_LABEL: Record<string, string> = {
  failed: 'failed',
  'daemon-killed': 'killed',
  'stale-queued': 'stale',
  'stale-worktree': 'worktree',
  'draft-proposal': 'proposal',
  'awaiting-validation': 'validate',
  'arc-failed': 'arc failed',
  'awaiting-human': 'awaiting',
  'coder-question': 'question',
  'diagnose-inconclusive': 'inconclusive',
  'reflect-recommended': 'reflect',
  'scorer-suggested': 'scorer',
}

/** Left accent bar color per kind. */
const KIND_ACCENT: Record<string, string> = {
  failed: 'border-l-error',
  'daemon-killed': 'border-l-error',
  'arc-failed': 'border-l-error',
  'stale-queued': 'border-l-warn',
  'stale-worktree': 'border-l-warn',
  'awaiting-validation': 'border-l-trace-mars',
  'draft-proposal': 'border-l-success',
  'awaiting-human': 'border-l-primary',
}

/** Badge text + border tint per kind. */
const KIND_CHIP_CLASS: Record<string, string> = {
  failed: 'text-error border-error/40',
  'daemon-killed': 'text-error border-error/40',
  'arc-failed': 'text-error border-error/40',
  'stale-queued': 'text-warn border-warn/40',
  'stale-worktree': 'text-warn border-warn/40',
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
  const kindLabel = KIND_LABEL[kind] ?? kind
  const kindIcon = KIND_ICON[kind] ?? '•'
  const chipClass = KIND_CHIP_CLASS[kind] ?? 'text-muted-foreground border-border'
  const accentClass = KIND_ACCENT[kind] ?? 'border-l-muted'
  const isDraftProposal = kind === 'draft-proposal'

  return (
    <div
      className={[
        'mars-card relative border-l-2 px-4 py-3',
        accentClass,
      ].join(' ')}
    >
      {/* Top row: kind chip + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={[
            'rounded border px-1.5 py-0.5 font-mono text-micro leading-none',
            chipClass,
          ].join(' ')}
        >
          {kindIcon} {kindLabel}
        </span>
        <span className="ml-auto font-mono text-micro text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Cluster headline */}
      <p className="mb-1 text-body font-medium leading-snug text-foreground">
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
}

const TriageRow = ({ item }: TriageRowProps) => {
  const qc = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resolved, setResolved] = useState(false)

  // Use relativeTime so timestamps are handled via the existing helper
  // (avoids hand-dividing epoch-ms values which can silently land at 1970).
  const age = relativeTime(item.at)
  // Narrative hierarchy matching AlertCard: when arcGoal (prompt excerpt) is
  // present it becomes the primary headline; humanSummary is demoted to
  // secondary/muted text so the operator sees WHAT the task was trying to do.
  const goal = item.arcGoal ?? null
  const cause = goal ? deriveCause(item.humanDetail) : undefined
  const headline = !goal ? (item.humanSummary || item.title) : null
  const accentClass = KIND_ACCENT[item.kind] ?? 'border-l-muted'
  const kindLabel = KIND_LABEL[item.kind] ?? item.kind
  const kindIcon = KIND_ICON[item.kind] ?? '•'
  const chipClass =
    KIND_CHIP_CLASS[item.kind] ?? 'text-muted-foreground border-border'
  const isChatOnly = CHAT_ONLY_KINDS.has(item.kind)
  const isTaskRecovery = TASK_RECOVERY_KINDS.has(item.kind)
  const verbs = item.verbs ?? []

  const handleDecision = useCallback(
    async (d: Decision) => {
      if (pending !== null) return
      setPending(d.label)
      setError(null)
      try {
        const res = await postDecision(d)
        if (!res.ok) throw new Error(`request failed (${res.status})`)
        setResolved(true)
        void qc.invalidateQueries({ queryKey: ['action-queue'] })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(null)
      }
    },
    [pending, qc],
  )

  const handleVerb = useCallback(
    async (op: string) => {
      if (pending !== null) return
      setPending(op)
      setError(null)
      try {
        await dispatchAlertVerb(item.id, item.entityId, op)
        setResolved(true)
        void qc.invalidateQueries({ queryKey: ['action-queue'] })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setPending(null)
      }
    },
    [pending, qc, item.id, item.entityId],
  )

  if (resolved) return null

  return (
    <div
      className={[
        'mars-card relative border-l-2 px-4 py-3 transition-opacity',
        accentClass,
      ].join(' ')}
    >
      {/* Top row: kind chip + priority badge + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={[
            'rounded border px-1.5 py-0.5 font-mono text-micro leading-none',
            chipClass,
          ].join(' ')}
        >
          {kindIcon} {kindLabel}
        </span>
        {item.priority === 'high' && (
          <span className="rounded bg-error/10 px-1.5 py-0.5 font-mono text-micro leading-none text-error">
            high
          </span>
        )}
        <span className="ml-auto font-mono text-micro text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Headline — narrative treatment mirrors AlertCard:
           - When goal (prompt excerpt) is present: goal is primary, cause + humanSummary secondary.
           - Otherwise: humanSummary || title is the headline. */}
      {goal ? (
        <>
          <p className="mb-0.5 text-body font-medium leading-snug text-foreground line-clamp-2">
            {goal.split('\n')[0]?.trim()}
          </p>
          {cause && (
            <p className="font-mono text-micro text-muted-foreground">{cause}</p>
          )}
          {item.humanSummary && (
            <p className="font-mono text-micro text-muted-dark line-clamp-1">{item.humanSummary}</p>
          )}
        </>
      ) : (
        headline && (
          <p className="mb-0.5 text-body font-medium leading-snug text-foreground">
            {headline}
          </p>
        )
      )}

      {/* Entity ID */}
      <p className="mb-2 font-mono text-micro text-muted-dark">
        {item.entityId}
      </p>

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-2">
        {!isChatOnly && (
          <>
            {/* Server-defined decision buttons (recipe-derived per failure kind) */}
            {item.decisions.slice(0, 3).map((d) => (
              <button
                key={d.label}
                disabled={pending !== null}
                onClick={() => void handleDecision(d)}
                className="rounded border border-primary/40 px-2 py-1 font-mono text-micro text-foreground transition-colors hover:bg-primary/20 disabled:opacity-50"
                data-testid={`triage-decision-${d.label}`}
              >
                {pending === d.label ? '…' : d.label}
              </button>
            ))}

            {/* Recipe verb buttons (e.g. "Restart daemon" for daemon-code-drift).
                Styled per verb.style so destructive ops are visually distinct. */}
            {verbs.map((verb) => (
              <button
                key={verb.op}
                disabled={pending !== null}
                onClick={() => void handleVerb(verb.op)}
                className={
                  verb.style === 'destructive'
                    ? 'rounded border border-error/40 px-2 py-1 font-mono text-micro text-error transition-colors hover:bg-error/10 disabled:opacity-50'
                    : 'rounded border border-primary/40 px-2 py-1 font-mono text-micro text-foreground transition-colors hover:bg-primary/20 disabled:opacity-50'
                }
                data-testid={`triage-verb-${verb.op}`}
              >
                {pending === verb.op ? '…' : verb.label}
              </button>
            ))}

            {/* Continue / Restart inline actions — only for task-recovery kinds.
                daemon-code-drift, gate-enrichment, and other system-level kinds
                use server-side verbs/decisions above instead. */}
            {isTaskRecovery && (
              <>
                <button
                  disabled={pending !== null}
                  onClick={() => void handleVerb('continue')}
                  className="rounded border border-primary/40 px-2 py-1 font-mono text-micro text-foreground transition-colors hover:bg-primary/20 disabled:opacity-50"
                  data-testid="triage-continue"
                >
                  {pending === 'continue' ? '…' : 'Continue'}
                </button>
                <button
                  disabled={pending !== null}
                  onClick={() => void handleVerb('restart')}
                  className="rounded border border-error/40 px-2 py-1 font-mono text-micro text-error transition-colors hover:bg-error/10 disabled:opacity-50"
                  data-testid="triage-restart"
                >
                  {pending === 'restart' ? '…' : 'Restart'}
                </button>
              </>
            )}
          </>
        )}

        <a
          href="#/chat"
          className="ml-auto font-mono text-micro text-muted-foreground transition-colors hover:text-foreground"
        >
          Chat →
        </a>
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
    </div>
  )
}

// ── FeedErrorCard ─────────────────────────────────────────────────────────────

interface FeedErrorCardProps {
  label: string
}

/**
 * Inline error card shown when a single data feed fails to load.
 * Keeps the rest of the triage page visible — a single failed feed
 * must never blank the whole view.
 */
const FeedErrorCard = ({ label }: FeedErrorCardProps) => (
  <div
    className="mars-card border-l-2 border-l-error px-4 py-3"
    data-testid={`triage-feed-error-${label.replace(/\s+/g, '-')}`}
    role="alert"
  >
    <p className="font-mono text-label text-error">
      Failed to load {label} — try refreshing or restarting the daemon
    </p>
  </div>
)

// ── EmptyState ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  running: number
  doneToday: number
}

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
  const { items, error: queueError } = useActionQueue()
  const { byCluster, aggregates } = useProgress()
  // Proposals is a third independent feed. Its error is surfaced as an inline
  // card so a schema-validation failure or network blip never blanks the page.
  const { error: proposalsError } = useProposals()

  const running = byCluster['In progress'].length
  const doneToday = aggregates.doneToday

  const sorted = sortItems(items)
  const renderedRows = buildRenderedRows(sorted)

  // Only show the empty state when every feed succeeded AND there is genuinely
  // nothing to act on. A feed error is itself something to surface, so the
  // empty state must never hide it.
  const hasAnyError = queueError !== null || proposalsError !== null
  const hasContent = renderedRows.length > 0 || hasAnyError

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="flex shrink-0 items-center border-b border-border px-5 py-3">
        <h1 className="font-mono text-body font-semibold text-foreground">
          Needs you
        </h1>
        {renderedRows.length > 0 && (
          <span
            aria-label={`${renderedRows.length} items need attention`}
            className="ml-2 rounded-full bg-primary/20 px-2 py-0.5 font-mono text-micro leading-none text-primary"
          >
            {renderedRows.length}
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
        {!hasContent ? (
          <EmptyState running={running} doneToday={doneToday} />
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {/* Inline error cards — one per failing feed, never blanking the page */}
            {queueError && <FeedErrorCard label="action queue" />}
            {proposalsError && <FeedErrorCard label="proposals" />}
            {renderedRows.map((row) =>
              row.type === 'cluster' ? (
                <TriageClusterRow
                  key={`cluster:${row.kind}`}
                  kind={row.kind}
                  count={row.count}
                  latestAt={row.latestAt}
                />
              ) : (
                <TriageRow key={row.item.id} item={row.item} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  )
}
