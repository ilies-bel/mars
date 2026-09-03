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
import { proposalHash } from '@/shared/routing'
import { relativeTime } from '@/shared/time'
import { invokeAction } from '@/shared/api'
import { ErrorState } from '@/components/ErrorState'
import { SkeletonBlock } from '@/components/Skeleton'
import type { DraftFeature } from '@/shared/schemas'

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
  human: 'bg-primary/10 text-primary border-primary/20',
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
  // Body preview — collapse newlines to spaces for the clamped view. Legacy
  // (pre-split) rows may still carry a multi-paragraph `problem`; collapsing
  // newlines keeps the preview readable instead of jamming lines together.
  // When expanded, show the original text with whitespace preserved.
  const preview = draft.problem.replace(/\s*\n\s*/g, ' ').trim()

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
    <div ref={cardRef} className="mars-card relative border-l-2 border-l-success px-4 py-3">
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
        <span className="ml-auto text-label text-muted-foreground/60">
          {age}
        </span>
      </div>

      {/* Title — clamped to 2 lines so a long legacy (pre-split) title can
          never take over the card; the clamp is the durable guard,
          independent of whether the backfill has run. */}
      <a
        href={proposalHash(draft.id, 'proposals')}
        className="mb-1 block line-clamp-2 font-mono text-title font-semibold leading-snug text-foreground hover:underline"
      >
        {draft.title}
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
            {expanded ? draft.problem.trim() : preview}
          </p>
          {draft.problem.trim().length > 0 && (
            <button
              type="button"
              onClick={handleToggleExpand}
              className="mt-0.5 text-label text-highlight hover:text-foreground focus:outline-none"
              aria-expanded={expanded}
            >
              {expanded ? 'less ↑' : 'more ↓'}
            </button>
          )}
        </div>
      )}

      {/* Footer: Dismiss · Review → · Grill · Promote */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleDismiss}
          className="text-label text-muted-foreground hover:text-foreground focus:outline-none"
        >
          Dismiss
        </button>
        <a
          href={proposalHash(draft.id, 'proposals')}
          className="rounded-md border border-highlight/20 bg-highlight/10 px-3 py-1 text-label font-medium text-highlight transition-colors hover:bg-highlight/20"
        >
          Review →
        </a>
        <button
          type="button"
          onClick={() => { void handleGrill() }}
          disabled={grillState.kind === 'pending'}
          aria-label={`Grill proposal ${draft.id}`}
          className="text-label text-muted-foreground hover:text-foreground focus:outline-none disabled:opacity-50"
        >
          {grillState.kind === 'pending' ? 'Opening…' : 'Grill'}
        </button>
        {promoteState.kind === 'done' && promoteState.taskId ? (
          <a
            href={`#/task/${promoteState.taskId}`}
            className="text-label text-success hover:underline"
          >
            ✓ Task {promoteState.taskId}
          </a>
        ) : (
          <button
            type="button"
            onClick={() => { void handlePromote() }}
            disabled={promoteState.kind === 'pending'}
            aria-label={`Promote proposal ${draft.id}`}
            className="text-label text-muted-foreground hover:text-foreground focus:outline-none disabled:opacity-50"
          >
            {promoteState.kind === 'pending' ? 'Promoting…' : 'Promote'}
          </button>
        )}
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
      💡
    </span>
    <p className="mb-1 text-title font-medium text-foreground">No drafts</p>
    <p className="font-mono text-label text-muted-foreground">
      Proposals appear here when agents or the slicer file them.
    </p>
  </div>
)

// ── ProposalsSkeleton ─────────────────────────────────────────────────────────

/** Card-shaped shimmer placeholder shown while the proposals list is loading. */
const ProposalsSkeleton = () => (
  <div aria-busy="true" aria-label="Loading proposals" className="flex flex-col gap-2 p-4">
    {Array.from({ length: 4 }, (_, i) => (
      <div
        key={i}
        className="mars-card border-l-2 border-l-primary/20 px-4 py-3 flex flex-col gap-2"
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
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center border-b border-border px-5 py-3">
          <h1 className="font-mono text-title font-semibold text-foreground">Draft proposals</h1>
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
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="flex shrink-0 items-center border-b border-border px-5 py-3">
        <h1 className="font-mono text-title font-semibold text-foreground">
          Draft proposals
        </h1>
        {/* Count = `total` (all matching drafts, before pagination), NOT
            `sorted.length` (this page only, capped at the fetch limit). The
            list below is paginated; the badge is a population count and must
            match the triage page's `draft-proposal` cluster row, which counts
            the same population. */}
        {!isPending && total > 0 && (
          <span
            aria-label={`${total} draft proposals awaiting review`}
            className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 font-mono text-micro font-medium leading-none text-primary"
          >
            {total}
          </span>
        )}
        {/* Filtered count — shown when a filter is active */}
        {!isPending && isFiltered && totalCount > 0 && (
          <span className="ml-3 text-label text-muted-foreground">
            Showing {showingCount} of {totalCount}
          </span>
        )}
      </div>

      {/* Search + source chips */}
      {!isPending && sorted.length > 0 && (
        <div className="shrink-0 border-b border-border bg-background px-4 py-2 flex flex-col gap-2">
          {/* Search input */}
          <div className="relative min-w-0">
            <span
              className="pointer-events-none absolute inset-y-0 left-2 flex select-none items-center text-muted-foreground/60"
              aria-hidden="true"
            >
              ⌕
            </span>
            <input
              type="text"
              aria-label="Search proposals"
              placeholder="Search proposals..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-border bg-card py-0.5 pl-6 pr-2 font-mono text-label text-foreground placeholder:text-muted-foreground/60 focus:border-highlight/40 focus:outline-none"
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
                      'rounded-full border px-2.5 py-0.5 text-micro font-medium leading-none transition-opacity focus:outline-none',
                      colorClass,
                      isActive ? 'opacity-100' : 'opacity-40 hover:opacity-70',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isPending ? (
          <ProposalsSkeleton />
        ) : sorted.length === 0 ? (
          <EmptyState />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-title font-medium text-foreground">No matches</p>
            <p className="mt-1 font-mono text-label text-muted-foreground">
              Try a different search or clear the source filter.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4">
            {filtered.map((draft) => (
              <ProposalRow key={draft.id} draft={draft} onDismiss={() => { void refetch() }} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
