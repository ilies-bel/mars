/**
 * Whether Mars is running, said one way.
 *
 * This one fact was written twice. The top stripe rendered a mono lowercase
 * `live` / `offline` / `paused · <reason>`; the Control Room rendered a sans
 * `Live` / `Connecting…` / `⏸ Paused · <reason>`. They disagreed on casing, on
 * type family, on the disconnected state's NAME, and on whether a pause gets a
 * glyph — and the stripe's indicator is a link straight to the Control Room,
 * so one click took you from "live" to "Live" and invited you to wonder what
 * the difference was.
 *
 * Two things fell out of unifying them:
 *
 *  - The stripe painted a paused dot with `bg-warning`. The token is
 *    `--color-warn`; `bg-warning` is not a utility and compiled to nothing, so
 *    the dot was transparent precisely in the state where it carries the most
 *    information. (Verified by computed style: `bg-warning` →
 *    `rgba(0, 0, 0, 0)`, `bg-warn` → `rgb(146, 64, 14)`.)
 *  - "⏸" is a text glyph. Like the "▸" this codebase already replaced, it
 *    renders at whatever metrics the font gives it and picks up emoji
 *    presentation in some. The dot beside the label already carries the tone.
 *
 * Ordered by what invalidates more of the screen: a dead daemon makes every
 * counter fictional, a pause makes them meaningless, a dropped socket only
 * makes them stale.
 */

export interface ConnectionCue {
  /** Tailwind background utility for the dot — a real token, checked. */
  tone: string
  label: string
  /** The `title` a reader gets on hover; carries the nuance the label drops. */
  title: string
}

export interface ConnectionStatusProps {
  connected: boolean
  paused: boolean
  /** Human phrase for WHY dispatch is paused, when it is. */
  pauseLabel?: string | null
  /** Longer explanation from the daemon, when it sent one. */
  pauseDetail?: string | null
  /** The daemon itself is unreachable — outranks everything below it. */
  daemonDown?: boolean
  className?: string
  'data-testid'?: string
}

export const connectionCue = ({
  connected,
  paused,
  pauseLabel,
  pauseDetail,
  daemonDown = false,
}: Omit<ConnectionStatusProps, 'className' | 'data-testid'>): ConnectionCue => {
  if (daemonDown) {
    return {
      tone: 'bg-error',
      label: 'Daemon down',
      title: 'The Mars daemon is not running — these counts are not current.',
    }
  }
  if (paused) {
    return {
      tone: 'bg-warn',
      label: pauseLabel != null && pauseLabel !== '' ? `Paused · ${pauseLabel}` : 'Paused',
      title: pauseDetail ?? 'Dispatch is paused — no new work is being dispatched.',
    }
  }
  if (connected) {
    return {
      tone: 'bg-success animate-mars-pulse',
      label: 'Live',
      title: 'Dispatch is running.',
    }
  }
  return {
    tone: 'bg-muted-foreground',
    label: 'Offline',
    title: 'Lost the event stream — what you see is the last thing we heard.',
  }
}

export const ConnectionStatus = ({
  className = '',
  'data-testid': testId,
  ...state
}: ConnectionStatusProps) => {
  const cue = connectionCue(state)
  return (
    <span
      className={`flex items-center gap-1.5 ${className}`}
      title={cue.title}
      data-testid={testId}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${cue.tone}`} aria-hidden="true" />
      <span className="text-label text-muted-foreground">{cue.label}</span>
    </span>
  )
}
