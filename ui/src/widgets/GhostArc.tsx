import type { PurgeArchiveEntry } from '@/shared/types'

interface Props {
  entry: PurgeArchiveEntry
  compensationArcId: string
}

export const GhostArc = ({ entry, compensationArcId }: Props) => {
  const commitTip = entry.integratedCommits
    .slice(0, 3)
    .map((s: string) => s.slice(0, 7))
    .join(', ')

  return (
    <div
      data-arc-state="purged"
      data-arc-id={entry.id}
      data-compensation-target={compensationArcId}
      title={commitTip || undefined}
      className="flex items-center gap-1.5 rounded border border-dashed border-border/40 bg-card/50 px-3 py-2 font-mono text-[10px] text-muted-foreground/60"
    >
      <span className="truncate">{entry.id}</span>
      <span aria-hidden="true">·</span>
      <span>{entry.terminalStatus}</span>
      <span aria-hidden="true" className="ml-auto">
        ↦
      </span>
    </div>
  )
}
