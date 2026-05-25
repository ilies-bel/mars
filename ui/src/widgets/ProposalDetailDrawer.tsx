import type { DraftFeature } from '@/shared/schemas'

interface ProposalDetailDrawerProps {
  /** Proposal sourced from the existing `/api/todo` drafts fetch. */
  proposal: DraftFeature
  /** Clears the `#/proposal/<id>` hash so the drawer closes. */
  onClose: () => void
}

/**
 * Status-badge colour pairs for the proposal lifecycle. The class shape
 * mirrors the task `StatusChip` legend (rounded, mono, uppercase) so the two
 * drawers read as one visual family. Unknown statuses fall back to the neutral
 * iron treatment rather than rendering nothing.
 */
const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-iron/10 text-iron',
  'prd-ready': 'bg-amber/15 text-ochre',
  sliced: 'bg-amber/15 text-ochre',
  dismissed: 'bg-iron/10 text-iron line-through',
}

const badgeClass = (status: string): string =>
  STATUS_BADGE[status] ?? 'bg-iron/10 text-iron'

/**
 * Slice 1 of the Proposal drawer: renders the proposal-specific header —
 * title, a status badge matching the Progress status legend, and the source
 * label (reflection / human / planner). Read-only; mutation surfaces and the
 * body sections land in later slices.
 */
export const ProposalDetailDrawer = ({
  proposal,
  onClose,
}: ProposalDetailDrawerProps) => {
  return (
    <aside
      role="dialog"
      aria-modal="true"
      aria-label="Proposal detail"
      data-testid="proposal-detail-drawer"
      className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-iron/40 bg-bg shadow-2xl"
    >
      <header className="flex items-start justify-between gap-3 border-b border-iron/40 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h2
            data-testid="proposal-detail-title"
            className="break-words font-mono text-sm text-fg"
          >
            {proposal.title}
          </h2>
          <div className="flex items-center gap-2">
            <span
              data-testid="proposal-detail-status"
              aria-label={`status ${proposal.status}`}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${badgeClass(
                proposal.status,
              )}`}
            >
              {proposal.status}
            </span>
            <span
              data-testid="proposal-detail-source"
              className="font-mono text-[9px] uppercase tracking-wide text-iron/80"
            >
              {proposal.source}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close proposal detail"
          data-testid="proposal-detail-close"
          className="shrink-0 rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
        >
          Close
        </button>
      </header>
    </aside>
  )
}
