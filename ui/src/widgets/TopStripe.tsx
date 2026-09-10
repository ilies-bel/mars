import { releaseNotesHash } from '@/shared/routing'
import { ConnectionStatus } from '@/components/ConnectionStatus'
import { pauseReasonLabel } from '@/entities/operator/useDispatchState'
import type { DispatchPauseState } from '@/shared/api'

interface Props {
  /**
   * Tasks completed in the last 24 hours (rolling window).
   *
   * The ONLY count this header carries, and deliberately so. It used to show
   * "In Progress · Done Today · Failed", two thirds of which the board's own
   * column headers already state — and state differently. The header read
   * "18 Failed" while the FAILED column 130px below read "19", because
   * `failedOpen` is `WHERE status='failed' AND fix_for_task_id IS NULL` (origin
   * failures only) and the column counts every card it renders (recovery tasks
   * included). Both defensible, neither labelled, same word twice on one
   * screen. A dashboard that miscounts its own headline number is not trusted
   * again, so the duplicated counts are gone and the columns are the single
   * source.
   *
   * Done survives because no column can carry it: the board's `done` rows are
   * done members of still-active arcs (a fully-completed arc is pruned), so
   * they are NOT the last-24h set — on measuring, the two sets of 8 overlapped
   * in 2. Rendering them as a "Done Today" column would have been a worse lie
   * than having no column.
   */
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
 * Health indicator — a link to the Control Room, which now states the same
 * fact in the same words. See components/ConnectionStatus.
 */
const HealthDot = ({
  connected,
  dispatch,
  daemonDown,
}: Pick<Props, 'connected' | 'dispatch' | 'daemonDown'>) => (
  <a
    href="#/control"
    data-testid="health-indicator"
    className="transition-opacity hover:opacity-80"
  >
    <ConnectionStatus
      connected={connected}
      paused={dispatch.paused}
      pauseLabel={dispatch.paused ? pauseReasonLabel(dispatch) : null}
      pauseDetail={dispatch.detail}
      daemonDown={daemonDown}
    />
  </a>
)

export const TopStripe = ({
  doneToday,
  connected,
  dispatch,
  daemonDown,
}: Props) => (
  <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-6 pb-3 pt-3.5">
    <div className="flex items-center gap-3">
      <h1 className="truncate text-heading font-semibold text-foreground">Progress</h1>
      <button
        type="button"
        onClick={() => {
          window.location.hash = releaseNotesHash()
        }}
        className="rounded-md border border-border bg-surface px-2 py-0.5 text-micro font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        Release Notes
      </button>
    </div>
    <div className="flex items-center gap-4">
      <div className="flex items-baseline gap-4">
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
          {/* "Today" was also wrong: the window is a rolling 24 hours, not a
              calendar day, so at 09:00 it still counts most of yesterday. */}
          <span className="text-micro text-muted-foreground">done · last 24h</span>
        </button>
      </div>
      <HealthDot connected={connected} dispatch={dispatch} daemonDown={daemonDown} />
    </div>
  </header>
)
