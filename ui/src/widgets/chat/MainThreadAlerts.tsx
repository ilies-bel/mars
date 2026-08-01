import type { Alert } from '@/entities/alerts'
import { groupAlerts } from './alertRuns'
import { AlertEventTimeline } from './AlertEventTimeline'

export interface MainThreadAlertsProps {
  alerts: Alert[]
  /** Spawn a subthread scoped to one alert. */
  onDiscuss: (arcId: string) => void
  /** True while a spawn is in flight. */
  pending?: boolean
}

/**
 * Alert notifications, rendered inside the main thread.
 *
 * Before this, alerts lived only in the top-bar Bell, so the main thread — the
 * surface holding the full context — was the one place that never mentioned
 * that anything had gone wrong. The Bell stays (it is the at-a-glance count
 * when scrolled away, and clicking a row there still spawns a subthread); this
 * puts the same information where the operator is actually reading.
 *
 * One alert renders as one row. Two or more merge into a single event timeline
 * — see `groupAlerts` for why simultaneity is the merge condition.
 *
 * Alerts are a live projection with no timestamp, so this block sits at the
 * live end of the thread rather than interleaved into history. That is also
 * where it belongs semantically: an alert is current state, not something that
 * was said at a point in time.
 */
export const MainThreadAlerts = ({ alerts, onDiscuss, pending = false }: MainThreadAlertsProps) => {
  const nodes = groupAlerts(alerts)
  if (nodes.length === 0) return null

  return (
    <div className="flex flex-col gap-2" data-testid="main-thread-alerts">
      {nodes.map((node) =>
        node.kind === 'run' ? (
          <AlertEventTimeline
            key="alert-run"
            alerts={node.alerts}
            onDiscuss={onDiscuss}
            pending={pending}
          />
        ) : (
          <section
            key={node.alert.arcId}
            aria-label="Alert"
            data-testid="main-thread-alert"
            data-arc-id={node.alert.arcId}
            className="rounded-md border border-l-2 border-border border-l-error bg-muted/20 px-3 py-2"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[12px] text-foreground">{node.alert.goal}</p>
                <p className="font-mono text-[11px] text-muted-foreground">{node.alert.reason}</p>
              </div>
              <button
                type="button"
                disabled={pending}
                aria-label={`Discuss: ${node.alert.goal}`}
                onClick={() => onDiscuss(node.alert.arcId)}
                className="shrink-0 rounded-sm border border-border px-2 py-0.5 font-mono text-[10px] text-foreground hover:bg-primary/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Discuss
              </button>
            </div>
          </section>
        ),
      )}
    </div>
  )
}
