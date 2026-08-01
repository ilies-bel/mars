import { useState } from 'react'
import type { Alert } from '@/entities/alerts'
import { countByKind, runHeadline } from './alertRuns'

/** Icon per alert kind, matching AlertCard's vocabulary. */
const KIND_ICON: Record<string, string> = {
  'arc-failed': '⛓️',
  'stale-worktree': '🗑️',
  other: '•',
}

/** Human label per alert kind for the summary line. */
const KIND_LABEL: Record<string, string> = {
  'arc-failed': 'failed',
  'stale-worktree': 'stale worktree',
  other: 'other',
}

export interface AlertEventTimelineProps {
  alerts: Alert[]
  /** Spawn a subthread scoped to one alert. */
  onDiscuss: (arcId: string) => void
  /** True while a spawn is in flight, to stop double-submits. */
  pending?: boolean
}

/**
 * The merged artifact for two or more simultaneous alerts.
 *
 * This exists so that an operator returning to the session reads ONE thing.
 * Rendering N alert cards is the failure mode it replaces: each card is
 * individually reasonable and collectively they are a wall that has to be
 * scrolled before the conversation underneath is reachable.
 *
 * The shape is a timeline, not a list: a headline that says how much happened,
 * a one-line breakdown by kind, then a compact row per event. Rows are collapsed
 * to goal + reason by default — `technical` is the detail an operator asks for
 * deliberately, and putting it inline would rebuild the wall this replaces.
 *
 * Each row still spawns its own subthread, because the merge is a presentation
 * decision: the alerts remain separate pieces of work with separate objectives,
 * and collapsing them into one subthread would lose that.
 */
export const AlertEventTimeline = ({ alerts, onDiscuss, pending = false }: AlertEventTimelineProps) => {
  const [expanded, setExpanded] = useState<string | null>(null)
  const breakdown = countByKind(alerts)

  return (
    <section
      aria-label="Alert event timeline"
      data-testid="alert-event-timeline"
      className="rounded-md border border-l-2 border-border border-l-error bg-muted/20"
    >
      <header className="border-b border-border px-3 py-2">
        <p className="font-mono text-[12px] text-foreground" data-testid="alert-timeline-headline">
          {runHeadline(alerts)}
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {breakdown
            .map(({ kind, count }) => `${count} ${KIND_LABEL[kind] ?? kind}`)
            .join(' · ')}
        </p>
      </header>

      <ul>
        {alerts.map((alert) => {
          const open = expanded === alert.arcId
          return (
            <li
              key={alert.arcId}
              data-testid="alert-timeline-row"
              data-arc-id={alert.arcId}
              className="border-b border-border last:border-b-0 px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden="true" className="pt-0.5 text-[11px]">
                  {KIND_ICON[alert.kind ?? 'other'] ?? KIND_ICON.other}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[12px] text-foreground">{alert.goal}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{alert.reason}</p>
                  {open && alert.technical && (
                    <pre
                      data-testid="alert-timeline-technical"
                      className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-background px-2 py-1 font-mono text-[10px] text-muted-foreground"
                    >
                      {alert.technical}
                    </pre>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {alert.technical && (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`Details: ${alert.goal}`}
                      onClick={() => setExpanded(open ? null : alert.arcId)}
                      className="rounded-sm px-1 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {open ? 'Hide' : 'Details'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Discuss: ${alert.goal}`}
                    onClick={() => onDiscuss(alert.arcId)}
                    className="rounded-sm border border-border px-2 py-0.5 font-mono text-[10px] text-foreground hover:bg-primary/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    Discuss
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
