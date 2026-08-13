import type { GreetingCounts } from './openWork'

const linkClass =
  'text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:text-foreground'

/**
 * Main-thread opening message: at most two lines, no ranked alert list.
 *
 * Line 1 — aggregate status: "N running · N recovering · N need you · N done today"
 *   Zero-segments are omitted. When all counts are zero: "All quiet."
 * Line 2 — only when at least one item needs the operator: "Open the board" link
 *   navigating to #/progress. No per-alert titles, no "Start with X".
 */
export const ChatGreeting = ({ running, recovering, needYou, doneToday }: GreetingCounts) => {
  const segments: string[] = []
  if (running > 0) segments.push(`${running} running`)
  if (recovering > 0) segments.push(`${recovering} recovering`)
  if (needYou > 0) segments.push(`${needYou} need you`)
  if (doneToday > 0) segments.push(`${doneToday} done today`)

  const statusLine = segments.length === 0 ? 'All quiet.' : segments.join(' · ')

  return (
    <div data-testid="chat-greeting">
      <p className="font-mono text-[14px] leading-relaxed text-foreground">{statusLine}</p>
      {needYou > 0 && (
        <p className="font-mono text-[14px] leading-relaxed text-foreground">
          <a href="#/progress" className={linkClass} data-testid="chat-greeting-board-link">
            Open the board
          </a>
        </p>
      )}
    </div>
  )
}
