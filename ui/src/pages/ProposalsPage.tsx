import { ArrowRight, Check, ChevronDown, ChevronUp, Search } from 'lucide-react'
import { splitDeferredProblem, provenanceLabel } from '@/shared/proposalPreview'
import { ActionButton, ActionLink } from '@/components/ActionButton'
import { PageHeader, PAGE_MEASURE } from '@/widgets/primitives/DensityPrimitives'
/**
 * ProposalsPage — operator-facing draft proposal triage surface.
 *
 * Renders the full list of draft proposals from GET /api/proposals?status=draft.
 * Each row shows title, source badge, age, and a one-line problem preview.
 * Clicking a row opens ProposalDetailDrawer via #/proposal/<id>?from=proposals,
 * so closing the drawer returns here.
 *
 * Actions (Promote, Dismiss, Grill) live inside ProposalDetailDrawer —
 * ProposalsPage is pure navigation.
 *
 * The header is labelled "Draft proposals" (not the bare "Proposals" the
 * Progress board column uses) because the two surfaces count different
 * populations: this page counts proposals with status='draft' awaiting a
 * decision, while the Progress board's "Proposals" column counts every
 * proposal that has spawned at least one in-scope task, regardless of
 * status. Same word, different population — the label says which.
 *
 * Empty state: "No drafts — proposals appear here when agents or the slicer file them."
 */

import { useState, useRef } from 'react'
import { useProposals } from '@/entities/proposals/useProposals'
import { proposalHash, taskHash } from '@/shared/routing'
import { relativeTime } from '@/shared/time'
import { invokeAction } from '@/shared/api'
import { ErrorState } from '@/components/ErrorState'
import { SkeletonBlock } from '@/components/Skeleton'
import type { DraftFeature } from '@/shared/schemas'
import { stripMarkdown } from '@/shared/stripMarkdown'

/** Round floats with more than 2 decimal digits to 2 d.p. (display only). */
const tidyFloats = (s: string): string =>
  s.replace(/\d+\.\d{3,}/g, (m) => parseFloat(m).toFixed(2))

// ── Source display ────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  reflection: 'reflection',
  'arc-verifier': 'arc-verifier',
  human: 'human',
  planner: 'planner',
  'skill-forge': 'skill-forge',
  'failure-reflector': 'failure-reflector',
  slicer: 'slicer',
}

const SOURCE_CHIP_CLASS: Record<string, string> = {
  human: 'bg-primary/10 text-muted-foreground border-border',
  reflection: 'bg-status-verifying/10 text-status-verifying border-status-verifying/20',
  'arc-verifier': 'bg-warn/10 text-warn border-warn/20',
  planner: 'bg-warn/10 text-warn border-warn/20',
  'skill-forge': 'bg-trace-mars/10 text-trace-mars border-trace-mars/20',
  'failure-reflector': 'bg-error/10 text-error border-error/20',
  slicer: 'bg-highlight/10 text-highlight border-highlight/20',
  growth: 'bg-success/10 text-success border-success/20',
}

// ── Inline API helpers ────────────────────────────────────────────────────────
// These will move to @/shared/api once Slice 1 lands; for now they are
// inlined here to avoid depending on an unmerged change.

const BASE_URL = typeof import.meta !== 'undefined' && import.meta.env
  ? (import.meta.env.VITE_API_BASE ?? '')
  : ''

async function postAction(op: string, entityId: string): Promise<{ taskIds?: string[] }> {
  const r = await fetch(`${BASE_URL}/api/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, entityId }),
  })
  if (!r.ok) {
    let message = `POST /api/actions → ${r.status}`
    try {
      const body = await r.json() as { error?: string }
      if (typeof body.error === 'string' && body.error.length > 0) message = body.error
    } catch { /* ignore JSON parse errors */ }
    throw new Error(message)
  }
  return r.json() as Promise<{ taskIds?: string[] }>
}

async function startThreadFromProposal(proposalId: string): Promise<{ threadId: string }> {
  const r = await fetch(`${BASE_URL}/api/proposals/${encodeURIComponent(proposalId)}/thread`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`POST /api/proposals/${proposalId}/thread → ${r.status}`)
  return r.json() as Promise<{ threadId: string }>
}

// ── ProposalRow ───────────────────────────────────────────────────────────────

interface ProposalRowProps {
  draft: DraftFeature
  onDismiss: () => void
}

const ProposalRow = ({ draft, onDismiss }: ProposalRowProps) => {
  const [expanded, setExpanded] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const age = relativeTime(draft.createdAt)
  const sourceLabel = SOURCE_LABEL[draft.source] ?? draft.source
  const chipClass =
    SOURCE_CHIP_CLASS[draft.source] ?? 'text-muted-foreground border-border'
  // Title — strip markdown tokens (backticks, headings) and round raw floats.
  const cleanTitle = tidyFloats(stripMarkdown(draft.title))
  // Body preview — strip markdown and collapse newlines to spaces for the
  // clamped view. Legacy (pre-split) rows may still carry a multi-paragraph
  // `problem`; collapsing newlines keeps the preview readable. When expanded,
  // still show markdown-stripped text with whitespace preserved.
  // Deferred proposals all open with the same three lines naming the PRD they
  // came from, so previewing the head of `problem` previewed the provenance and
  // stacked siblings rendered as identical paragraphs. Lead with the part that
  // is this proposal's own; the provenance survives as a quiet line below.
  const { provenance, lead } = splitDeferredProblem(draft.problem)
  const strippedProblem = tidyFloats(stripMarkdown(lead))
  const preview = strippedProblem.replace(/\s*\n\s*/g, ' ').trim()

  const [grillState, setGrillState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const [promoteState, setPromoteState] = useState<
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'done'; taskId?: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const handleDismiss = () => {
    void invokeAction('dismiss', draft.id).then(onDismiss)
  }

  const handleToggleExpand = () => {
    const nextExpanded = !expanded
    setExpanded(nextExpanded)
    if (nextExpanded) {
      // Give React a tick to update the DOM before scrolling, so the
      // expanded card's full height is already in layout.
      requestAnimationFrame(() => {
        cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }
  }

  const handleGrill = async () => {
    if (grillState.kind === 'pending') return
    setGrillState({ kind: 'pending' })
    try {
      const { threadId } = await startThreadFromProposal(draft.id)
      window.location.hash = `#/chat?thread=${encodeURIComponent(threadId)}`
      setGrillState({ kind: 'done' })
    } catch (err) {
      setGrillState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to start grill session',
      })
    }
  }

  const handlePromote = async () => {
    if (promoteState.kind === 'pending') return
    setPromoteState({ kind: 'pending' })
    try {
      const result = await postAction('promote', draft.id)
      setPromoteState({ kind: 'done', taskId: result.taskIds?.[0] })
    } catch (err) {
      setPromoteState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to promote proposal',
      })
    }
  }

  return (
    <div ref={cardRef} className="mars-card relative rounded-lg bg-card px-4 py-3">
      {/* Top row: source chip + age */}
      <div className="mb-2 flex items-center gap-2">
        <span
          className={[
            'rounded-full border px-2.5 py-0.5 text-micro font-medium leading-none',
            chipClass,
          ].join(' ')}
        >
          {sourceLabel}
        </span>
        <span className="ml-auto text-label text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Title — clamped to 2 lines so a long legacy (pre-split) title can
          never take over the card; the clamp is the durable guard,
          independent of whether the backfill has run. */}
      <a
        href={proposalHash(draft.id, 'proposals')}
        className="mb-1 block line-clamp-2 text-title font-semibold leading-snug text-foreground hover:underline"
      >
        {cleanTitle}
      </a>

      {/* Body preview — 3 lines max when collapsed; full text when expanded */}
      {preview && (
        <div className="mb-2">
          <p
            className={[
              'max-w-prose text-body text-muted-foreground leading-relaxed',
              expanded ? 'whitespace-pre-wrap' : 'line-clamp-3',
            ].join(' ')}
          >
            {expanded ? strippedProblem.trim() : preview}
          </p>
          {provenance !== null && (
            /* Provenance is real information and worth keeping — it is just
               not what tells two siblings apart, so it reads as a caption
               rather than as the paragraph. */
            <p
              className="mt-1 text-micro text-muted-foreground"
              title={provenance.prdTitle ?? undefined}
              data-testid="proposal-provenance"
            >
              {provenanceLabel(provenance)}
            </p>
          )}
          {draft.problem.trim().length > 0 && (
            <button
              type="button"
              onClick={handleToggleExpand}
              className="mt-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-label font-medium text-highlight transition-colors duration-[var(--dur-fast)] hover:bg-highlight/10"
              aria-expanded={expanded}
            >
              {expanded ? 'Show less' : 'Show more'}
              {expanded ? (
                <ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
              ) : (
                <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      )}

      {/* Footer: Review · Grill · Promote — Dismiss sits apart on the right.
          The drawer follows THIS order, not the other way round: escalating
          commitment (look, then shape, then accept) is a better reason than
          the drawer's had, which was none. Review has no counterpart in the
          drawer for the obvious reason — it is the way in. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ActionLink href={proposalHash(draft.id, 'proposals')} variant="primary">
          Review
          <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
        </ActionLink>
        <ActionButton
          onClick={() => { void handleGrill() }}
          pending={grillState.kind === 'pending'}
          aria-label={`Grill proposal ${draft.id}`}
        >
          Grill
        </ActionButton>
        {promoteState.kind === 'done' && promoteState.taskId ? (
          <a
            href={taskHash(promoteState.taskId)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-label font-medium text-success hover:underline"
          >
            <Check size={13} strokeWidth={2} aria-hidden="true" />
            Task {promoteState.taskId}
          </a>
        ) : (
          <ActionButton
            onClick={() => { void handlePromote() }}
            pending={promoteState.kind === 'pending'}
            aria-label={`Promote proposal ${draft.id}`}
          >
            Promote
          </ActionButton>
        )}
        <ActionButton
          variant="secondary"
          onClick={handleDismiss}
          className="ml-auto"
        >
          Dismiss
        </ActionButton>
        {grillState.kind === 'error' && (
          <span className="text-label text-error">{grillState.message}</span>
        )}
        {promoteState.kind === 'error' && (
          <span className="text-label text-error">{promoteState.message}</span>
        )}
      </div>
    </div>
  )
}

// ── EmptyState ────────────────────────────────────────────────────────────────

const EmptyState = () => (
  <div className="flex flex-col items-center justify-center py-24 text-center">
    <span
      className="mb-3 text-4xl opacity-20"
      style={{ color: 'var(--color-amber)' }}
      aria-hidden="true"
    >
      ◇
    </span>
    <p className="mb-1 text-title font-medium text-foreground">No drafts</p>
  </div>
)

// ── ProposalsSkeleton ─────────────────────────────────────────────────────────

/** Card-shaped shimmer placeholder shown while the proposals list is loading. */
const ProposalsSkeleton = () => (
  <div aria-busy="true" aria-label="Loading proposals" className="flex flex-col gap-2 p-4">
    {Array.from({ length: 4 }, (_, i) => (
      <div
        key={i}
        className="mars-card rounded-lg bg-card px-4 py-3 flex flex-col gap-2"
      >
        <div className="flex items-center gap-2 mb-1">
          <SkeletonBlock className="h-4 w-20" />
          <SkeletonBlock className="ml-auto h-3 w-14" />
        </div>
        <SkeletonBlock className="h-4 w-3/4" />
        <SkeletonBlock className="h-3 w-1/2" />
      </div>
    ))}
  </div>
)

// ── ProposalsPage ─────────────────────────────────────────────────────────────

export const ProposalsPage = () => {
  const { proposals, total, isPending, error, refetch } = useProposals()
  const [searchQuery, setSearchQuery] = useState('')
  // Empty set = no source filter (all shown). Non-empty = only matching sources shown.
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set())

  if (error) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background" data-testid="proposals-page">
        <div className="flex shrink-0 items-center border-b border-border px-5 py-3">
          <h1 className="text-heading font-semibold text-foreground">Draft proposals</h1>
        </div>
        <ErrorState error={error} of="proposals" onRetry={() => refetch()} />
      </div>
    )
  }

  // Newest first
  const sorted = [...proposals].sort((a, b) => b.createdAt - a.createdAt)

  // Unique sources from the full sorted list, in appearance order
  const uniqueSources = Array.from(new Set(sorted.map((d) => d.source)))

  // Client-side filtering: search query (title + problem) and source chips
  const q = searchQuery.trim().toLowerCase()
  const filtered = sorted.filter((draft) => {
    if (activeSources.size > 0 && !activeSources.has(draft.source)) return false
    if (q) {
      const haystack = `${draft.title} ${draft.problem}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  const toggleSource = (source: string) => {
    setActiveSources((prev) => {
      const next = new Set(prev)
      if (next.has(source)) {
        next.delete(source)
      } else {
        next.add(source)
      }
      return next
    })
  }

  const showingCount = filtered.length
  const totalCount = sorted.length
  const isFiltered = q.length > 0 || activeSources.size > 0

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background" data-testid="proposals-page">
      {/* Count = `total` (all matching drafts, before pagination), NOT
          `sorted.length` (this page only, capped at the fetch limit). The list
          below is paginated; the badge is a population count and must match
          the triage page's `draft-proposal` cluster row, which counts the same
          population. */}
      <PageHeader
        title="Draft proposals"
        count={!isPending ? total : null}
        countLabel={`${total} draft proposals awaiting review`}
        subtitle={
          !isPending && isFiltered && totalCount > 0
            ? `Showing ${showingCount} of ${totalCount}`
            : undefined
        }
      />

      {/* Search + source chips */}
      {/* px-6 is the page gutter PageHeader uses; this band used px-4, so the
          search field started 8px left of the h1 above it. */}
      {!isPending && sorted.length > 0 && (
        <div className="shrink-0 border-b border-border bg-background px-6 py-2">
          <div className={`flex w-full flex-col gap-2 ${PAGE_MEASURE}`}>
          {/* Search input */}
          <div className="relative min-w-0">
            <Search
              size={13}
              strokeWidth={1.75}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              aria-label="Search proposals"
              placeholder="Search proposals..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 w-full rounded-md border border-border bg-background pl-7.5 pr-2.5 text-label text-foreground shadow-[var(--shadow-e1)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-muted-foreground focus:border-highlight/50"
            />
          </div>
          {/* Source filter chips */}
          {uniqueSources.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by source">
              {uniqueSources.map((source) => {
                const isActive = activeSources.has(source)
                const label = SOURCE_LABEL[source] ?? source
                const colorClass =
                  SOURCE_CHIP_CLASS[source] ?? 'text-muted-foreground border-border'
                return (
                  <button
                    key={source}
                    type="button"
                    onClick={() => toggleSource(source)}
                    aria-pressed={isActive}
                    className={[
                      'inline-flex h-6 items-center rounded-md border px-2 text-micro font-medium transition-[background-color,border-color,color] duration-[var(--dur-fast)]',
                      isActive
                        ? colorClass
                        : 'border-transparent bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/8 hover:text-foreground',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}
          </div>
        </div>
      )}

      {/* List. `px-6` is the page gutter — the same one PageHeader and the
          toolbar band apply — owned once here and inherited by every state
          below rather than re-declared per branch. */}
      <div className="flex-1 overflow-y-auto px-6">
        {/* A reading column, not the full viewport: these cards are prose, and
            prose that runs to 1680px is unreadable no matter how it is set.
            PAGE_MEASURE, shared with Needs You, so the two list pages cannot
            drift apart again. */}
        {isPending ? (
          <ProposalsSkeleton />
        ) : sorted.length === 0 ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-title font-medium text-foreground">No matches</p>
            <p className="mt-1 text-label text-muted-foreground">
              Try a different search or clear the source filter.
            </p>
          </div>
        ) : (
          <div className={`flex w-full flex-col gap-3 py-4 ${PAGE_MEASURE}`}>
            {filtered.map((draft) => (
              <ProposalRow key={draft.id} draft={draft} onDismiss={() => { void refetch() }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
