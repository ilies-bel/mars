import { memo, useEffect, useState } from 'react'
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

  // Probe for a generated mockup file so the card can show a chip when one exists.
  const [mockupExists, setMockupExists] = useState(false)
  const mockupUrl = `/mockups/${encodeURIComponent(proposal.id)}.html`
  useEffect(() => {
    let cancelled = false
    fetch(mockupUrl, { method: 'HEAD' })
      .then((r) => { if (!cancelled) setMockupExists(r.ok) })
      .catch(() => { /* file does not exist yet */ })
    return () => { cancelled = true }
  }, [mockupUrl])

  return (
    <article
      tabIndex={0}
      role="button"
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 cursor-pointer transition-[transform,background-color] duration-150 ease-out hover:bg-secondary active:scale-[0.99] motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          className="break-all font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          {proposal.id}
        </a>
        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
          {proposal.status}
        </span>
      </div>
      <div className="text-[14px] font-medium leading-snug text-foreground">
        {truncate(proposal.title, 120)}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{proposal.source}</span>
        {mockupExists && (
          <a
            href={mockupUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="proposal-card-mockup-chip"
            onClick={(e) => e.stopPropagation()}
            className="rounded border border-primary/40 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10"
          >
            mockup ready ↗
          </a>
        )}
      </div>
    </article>
  )
})
