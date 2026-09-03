import { releaseNotesHash } from '@/shared/routing'
import { pauseReasonLabel } from '@/entities/operator/useDispatchState'
import type { DispatchPauseState } from '@/shared/api'

interface Props {
  inProgress: number
  failed: number
  /** Tasks completed in the last 24 hours (rolling window). */
  doneToday: number
  connected: boolean
  /**
   * Dispatch pause state. Distinct from `connected`, which is only the SSE
   * socket: a paused daemon is perfectly connected and perfectly idle, and
   * showing "live" for it reads as "healthy, nothing to do" when the truth is
   * "frozen, nothing will happen". Every zero on this header is explained by a
   * pause, so the pause has to win the indicator.
   */
  dispatch: DispatchPauseState
  /**
   * True when the daemon itself is not running. Outranks both of the above:
   * the SSE socket is served by the mars-ui server, so it stays happily
   * "connected" to a dead daemon, and dispatch state can only be read FROM the
   * daemon — so with the daemon down this header would otherwise show a
   * pulsing green "live" directly under a banner saying it is unreachable.
   */
  daemonDown: boolean
}

/**
 * Health indicator: daemon reachability, then dispatch state, then socket state.
 *
 * Ordered by what invalidates more of the screen. A dead daemon makes every
 * counter fictional; a pause makes them meaningless; a dropped socket only
 * makes them stale.
 */
const HealthDot = ({
  connected,
  dispatch,
  daemonDown,
}: Pick<Props, 'connected' | 'dispatch' | 'daemonDown'>) => {
  const { tone, label, title } = daemonDown
    ? {
        tone: 'bg-error',
        label: 'daemon down',
        title: 'The Mars daemon is not running — these counts are not current.',
      }
    : dispatch.paused
      ? {
          tone: 'bg-warning',
          label: `paused · ${pauseReasonLabel(dispatch)}`,
          title: dispatch.detail ?? 'Dispatch is paused — no new work is being dispatched.',
        }
      : connected
        ? { tone: 'bg-success animate-mars-pulse', label: 'live', title: 'Dispatch is running.' }
        : { tone: 'bg-muted-foreground', label: 'offline', title: 'Lost the event stream.' }

  return (
    <a
      href="#/control"
      title={title}
      data-testid="health-indicator"
      className="flex items-center gap-1.5 transition-opacity hover:opacity-80"
    >
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      <span className="font-mono text-body text-muted-foreground">{label}</span>
    </a>
  )
}

export const TopStripe = ({
  inProgress,
  failed,
  doneToday,
  connected,
  dispatch,
  daemonDown,
}: Props) => (
  <header className="flex h-12 items-center justify-between border-b border-border bg-background px-6">
    <div className="flex items-center gap-3">
      <h1 className="text-title font-semibold text-foreground">Tasks</h1>
      <button
        type="button"
        onClick={() => {
          window.location.hash = releaseNotesHash()
        }}
        className="rounded-full bg-surface px-2.5 py-0.5 text-micro text-muted-foreground transition-colors hover:text-foreground"
      >
        Release Notes
      </button>
    </div>
    <div className="flex items-center gap-4">
      <div className="flex items-baseline gap-4 font-mono">
        <div data-testid="stat-in-progress" className="flex items-baseline gap-1">
          <span className="tabular-nums text-title font-semibold text-status-running">{inProgress}</span>
          <span className="text-micro text-muted-foreground tracking-wide">IN PROGRESS</span>
        </div>
        <span className="text-muted-foreground/50">·</span>
        <button
          type="button"
          data-testid="stat-done"
          title="Tasks completed in the last 24 hours — click to view release notes"
          onClick={() => {
            window.location.hash = releaseNotesHash()
          }}
          className="flex cursor-pointer items-baseline gap-1 hover:opacity-80"
        >
          <span className={`tabular-nums text-title font-semibold ${doneToday > 0 ? 'text-status-done' : 'text-muted-foreground'}`}>{doneToday}</span>
          <span className="text-micro text-muted-foreground tracking-wide">DONE TODAY</span>
        </button>
        <span className="text-muted-foreground/50">·</span>
        <div data-testid="stat-failed" className="flex items-baseline gap-1">
          <span className={`tabular-nums text-title font-semibold ${failed > 0 ? 'text-status-failed' : 'text-muted-foreground'}`}>{failed}</span>
          <span className="text-micro text-muted-foreground tracking-wide">FAILED</span>
        </div>
      </div>
      <HealthDot connected={connected} dispatch={dispatch} daemonDown={daemonDown} />
    </div>
  </header>
)
