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
 * Empty state: "No drafts — proposals appear here when agents or the slicer file them."
 */

import { useProposals } from '@/entities/proposals/useProposals'
import { proposalHash } from '@/shared/routing'
import { relativeTime } from '@/shared/time'
import { CopyButton } from '@/components/CopyButton'
import type { DraftFeature } from '@/shared/schemas'

// ── Source display ────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  reflection: 'reflection',
  'arc-verifier': 'arc-verifier',
  human: 'human',
  planner: 'planner',
  'skill-forge': 'skill-forge',
  'failure-reflector': 'failure-reflector',
}

const SOURCE_CHIP_CLASS: Record<string, string> = {
  human: 'text-primary border-primary/40',
  reflection: 'text-success border-success/40',
  'arc-verifier': 'text-warn border-warn/40',
  planner: 'text-warn border-warn/40',
  'skill-forge': 'text-trace-mars border-trace-mars/40',
  'failure-reflector': 'text-error border-error/40',
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
  // One-line problem preview — strip newlines and clamp with CSS
  const preview = draft.problem.split('\n')[0]?.trim() ?? ''
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

      {/* Title */}
      <a
        href={proposalHash(draft.id, 'proposals')}
        className="mb-1 block text-body font-medium leading-snug text-foreground hover:underline"
      >
        {draft.title}
      </a>

      {/* One-line problem preview */}
      {preview && (
        <p className="mb-2 font-mono text-micro text-muted-foreground line-clamp-1">
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

// ── ProposalsPage ─────────────────────────────────────────────────────────────

export const ProposalsPage = () => {
  const { proposals, isPending, error } = useProposals()

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-label text-error">
          Failed to load proposals
        </p>
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
          Proposals
        </h1>
        {!isPending && sorted.length > 0 && (
          <span
            aria-label={`${sorted.length} draft proposals`}
            className="ml-2 rounded-full bg-success/20 px-2 py-0.5 font-mono text-micro leading-none text-success"
          >
            {sorted.length}
          </span>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {isPending ? (
          <div className="flex h-full items-center justify-center">
            <p className="font-mono text-label text-muted-foreground">Loading…</p>
          </div>
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
