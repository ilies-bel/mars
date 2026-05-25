import type { DraftFeature } from '@/shared/schemas'

interface Props {
  proposal: DraftFeature
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

export const ProposalCard = ({ proposal }: Props) => (
  <article className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
    <div className="flex items-start justify-between gap-2">
      <a
        href={`#/proposal/${encodeURIComponent(proposal.id)}`}
        className="break-all font-mono text-[11px] text-muted hover:text-fg hover:underline"
      >
        {proposal.id}
      </a>
      <span className="shrink-0 rounded bg-iron/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-iron">
        {proposal.status}
      </span>
    </div>
    <div className="text-[14px] font-medium leading-snug text-fg">
      {truncate(proposal.goal, 120)}
    </div>
    <div className="font-mono text-[11px] text-muted">{proposal.source}</div>
  </article>
)
