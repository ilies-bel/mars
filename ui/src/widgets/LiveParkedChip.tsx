import { PauseCircle } from 'lucide-react'
/**
 * LiveParkedChip — counter chip for the Shell top bar.
 *
 * Shows how many action-queue rows have kind='awaiting-human' (live tasks
 * parked at a manual step, waiting for the operator). Hidden when the count
 * is zero. Clicking navigates to the Triage view pre-filtered to those rows
 * via AWAITING_HUMAN_HREF (the action-queue filter store).
 *
 * The count refreshes automatically whenever the React Query cache entry for
 * 'action-queue' is invalidated by the view-stream SSE channel — no separate
 * poll needed.
 *
 * The chip carries the word "parked", not just the glyph and the number. As
 * `◎ 1` it was unreadable: an unlabelled count in the corner of the top bar
 * tells you something is being counted but not what, and the aria-label that
 * explained it was only reachable by screen readers.
 */

import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { AWAITING_HUMAN_HREF } from '@/pages/ActionQueuePageFilters'

export const LiveParkedChip = () => {
  const { items } = useActionQueue()
  const count = items.filter((item) => item.kind === 'awaiting-human').length

  if (count === 0) return null

  return (
    <a
      href={AWAITING_HUMAN_HREF}
      data-testid="live-parked-chip"
      aria-label={`${count} live task${count === 1 ? '' : 's'} parked awaiting your input`}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-warn/15 px-2.5 text-micro font-medium text-warn transition-colors duration-[var(--dur-fast)] hover:bg-warn/25"
    >
      <PauseCircle size={12} strokeWidth={2} aria-hidden="true" />
      {count} parked
    </a>
  )
}
