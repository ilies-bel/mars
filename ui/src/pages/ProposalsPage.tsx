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

import { useProposals } from '@/entities/proposals/useProposals'
import { proposalHash } from '@/shared/routing'
import { relativeTime } from '@/shared/time'
import { CopyButton } from '@/components/CopyButton'
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
  human: 'text-primary border-primary/40',
  reflection: 'text-success border-success/40',
  'arc-verifier': 'text-warn border-warn/40',
  planner: 'text-warn border-warn/40',
  'skill-forge': 'text-trace-mars border-trace-mars/40',
  'failure-reflector': 'text-error border-error/40',
  slicer: 'text-warn border-warn/40',
}

// ── ProposalRow ───────────────────────────────────────────────────────────────

interface ProposalRowProps {
  draft: DraftFeature
}

const ProposalRow = ({ draft }: ProposalRowProps) => {
  const age = relativeTime(draft.createdAt)
  const sourceLabel = SOURCE_LABEL[draft.source] ?? draft.source
  const chipClass =
    SOURCE_CHIP_CLASS[draft.source] ?? 'text-muted-foreground border-border'
  // Body preview — collapse newlines to spaces and clamp with CSS. Legacy
  // (pre-split) rows may still carry a multi-paragraph `problem`; collapsing
  // newlines keeps the preview readable instead of jamming lines together.
  const preview = draft.problem.replace(/\s*\n\s*/g, ' ').trim()
  const grillCmd = `/mars:grill ${draft.id}`

  return (
    <div className="mars-card relative border-l-2 border-l-success px-4 py-3">
      {/* Top row: source chip + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={[
            'rounded border px-1.5 py-0.5 font-mono text-micro leading-none',
            chipClass,
          ].join(' ')}
        >
          💡 {sourceLabel}
        </span>
        <span className="ml-auto font-mono text-micro text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Title — clamped to 2 lines so a long legacy (pre-split) title can
          never take over the card; the clamp is the durable guard,
          independent of whether the backfill has run. */}
      <a
        href={proposalHash(draft.id, 'proposals')}
        className="mb-1 block line-clamp-2 text-body font-medium leading-snug text-foreground hover:underline"
      >
        {draft.title}
      </a>

      {/* Body preview — subordinate to the title, 3 lines max */}
      {preview && (
        <p className="mb-2 line-clamp-3 font-mono text-micro text-muted-foreground">
          {preview}
        </p>
      )}

      {/* Footer: open drawer link + grill command copy */}
      <div className="flex items-center gap-3">
        <a
          href={proposalHash(draft.id, 'proposals')}
          className="font-mono text-micro text-primary transition-colors hover:text-foreground"
        >
          Review →
        </a>
        <CopyButton
          text={grillCmd}
          label={grillCmd}
          aria-label={`Copy /mars:grill ${draft.id}`}
          className="rounded border border-primary/30 px-1.5 py-0.5 font-mono text-micro text-primary/70 hover:bg-primary/10 hover:text-primary"
        />
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

  if (error) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center border-b border-border px-5 py-3">
          <h1 className="font-mono text-body font-semibold text-foreground">Draft proposals</h1>
        </div>
        <ErrorState error={error} of="proposals" onRetry={() => refetch()} />
      </div>
    )
  }

  // Newest first
  const sorted = [...proposals].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="flex shrink-0 items-center border-b border-border px-5 py-3">
        <h1 className="font-mono text-body font-semibold text-foreground">
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
            className="ml-2 rounded-full bg-success/20 px-2 py-0.5 font-mono text-micro leading-none text-success"
          >
            {total}
          </span>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isPending ? (
          <ProposalsSkeleton />
        ) : sorted.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {sorted.map((draft) => (
              <ProposalRow key={draft.id} draft={draft} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
