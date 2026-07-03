import { memo } from 'react'
import type { DraftFeature } from '@/shared/schemas'

interface Props {
  proposal: DraftFeature
}

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s

export const ProposalCard = memo(({ proposal }: Props) => {
  const openDrawer = () => {
    window.location.hash = `#/proposal/${encodeURIComponent(proposal.id)}`
  }

  return (
    <article
      tabIndex={0}
      role="button"
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 cursor-pointer transition-[transform,background-color] duration-150 ease-out hover:bg-panel active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flame"
      onClick={(e) => {
        // Let inner anchors (e.g. the id link) handle their own navigation
        if ((e.target as HTMLElement).closest('a') !== null) return
        openDrawer()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        if ((e.target as HTMLElement).closest('a') !== null) return
        e.preventDefault()
        openDrawer()
      }}
    >
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
        {truncate(proposal.title, 120)}
      </div>
      <div className="font-mono text-[11px] text-muted">{proposal.source}</div>
    </article>
  )
})
