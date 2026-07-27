import type { ActionQueueItem } from '@/shared/schemas'
import { kindBadgeLabel } from '@/shared/actionQueueDetail'

interface Props {
  rows: ActionQueueItem[]
  onPick: (row: ActionQueueItem) => void
}

export const OpeningNextMoves = ({ rows, onPick }: Props) => {
  if (rows.length === 0) return null
  return (
    <div
      data-testid="opening-next-moves"
      className="mt-3 flex flex-wrap gap-2"
      aria-label="Suggested next moves"
    >
      {rows.map((row) => (
        <button
          key={row.id}
          role="chip"
          type="button"
          data-testid="next-move-chip"
          className="flex items-center gap-1.5 rounded-full border border-primary/25 px-3 py-1.5 font-mono text-[11px] text-primary transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-foreground active:scale-[0.98]"
          onClick={() => onPick(row)}
        >
          <span className="max-w-[200px] truncate">{row.title || kindBadgeLabel(row.kind)}</span>
        </button>
      ))}
    </div>
  )
}
