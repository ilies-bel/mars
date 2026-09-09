import type { GreetingCounts, OpenWorkItem } from './openWork'

const linkClass =
  'text-left text-highlight text-label transition-colors hover:underline'

interface ChatGreetingProps extends GreetingCounts {
  /** The single most-urgent open-work item. When present, renders an
   *  actionable "chat-greeting-next-move" chip instead of the generic
   *  board link, so clicking it opens the item's subthread directly. */
  nextMove?: OpenWorkItem | null
  onNextMove?: (item: OpenWorkItem) => void
  /**
   * False while the counts are placeholders — the first fetch is in flight or
   * it failed. All four counts read zero in that state, which is
   * indistinguishable from a genuinely idle system, so the greeting must not
   * claim "All quiet." over it.
   */
  known?: boolean
}

/**
 * Main-thread opening message: at most two lines, no ranked alert list.
 *
 * Line 1 — aggregate status: "N running · N recovering · N need you · N done today"
 *   Zero-segments are omitted. When all counts are zero: "All quiet."
 * Line 2 — only when at least one item needs the operator:
 *   • If nextMove is provided: a button (chat-greeting-next-move) that opens
 *     the item's subthread via onNextMove.
 *   • Otherwise: an "Open the board" anchor navigating to #/progress.
 */
export const ChatGreeting = ({
  running,
  recovering,
  needYou,
  doneToday,
  nextMove,
  onNextMove,
  known = true,
}: ChatGreetingProps) => {
  const segments: string[] = []
  if (running > 0) segments.push(`${running} running`)
  if (recovering > 0) segments.push(`${recovering} recovering`)
  if (needYou > 0) segments.push(`${needYou} need you`)
  if (doneToday > 0) segments.push(`${doneToday} done today`)

  // "All quiet." is a claim about the system. Only make it when the counts are
  // a real answer — with the daemon unreachable every count is zero, and
  // reporting that as calm is the most damaging thing this line can do.
  const statusLine = !known
    ? "Can't reach Mars — status unknown."
    : segments.length === 0
      ? 'All quiet.'
      : segments.join(' · ')

  return (
    <div data-testid="chat-greeting" className="mb-4">
      <p className="text-body text-muted-foreground">{statusLine}</p>
      {nextMove != null && onNextMove != null ? (
        <p className="text-label mt-0.5">
          <button
            type="button"
            className={linkClass}
            data-testid="chat-greeting-next-move"
            onClick={() => onNextMove(nextMove)}
          >
            Open the board
          </button>
        </p>
      ) : needYou > 0 ? (
        <p className="text-label mt-0.5">
          <a href="#/progress" className={linkClass} data-testid="chat-greeting-board-link">
            Open the board
          </a>
        </p>
      ) : null}
    </div>
  )
}
