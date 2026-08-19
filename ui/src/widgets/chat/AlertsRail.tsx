/**
 * AlertsRail — what needs the operator, pinned at the top of the Chat sidebar.
 *
 * This slot used to hold the main thread ("everything, in one place"). That
 * framing did not survive contact: the one conversation that contained
 * everything was the one nobody could act on, while the things that actually
 * needed a decision lived on a separate page. The rail now leads with those,
 * and each one opens its own thread.
 *
 * Rows are the same open action-queue items the Needs-you page ranked, in the
 * same priority-then-recency order, so the two surfaces cannot disagree about
 * what is urgent. Draft proposals are excluded for the same reason they are
 * excluded from `countNeedsYou`: a backlog of shaped ideas is not an alert.
 *
 * Pinned outside the scroll region, so a pile of threads below can never push
 * the alerts out of view.
 */

import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { sortItems } from '@/entities/actionQueue/clusterRows'
import { useDaemonHealth } from '@/entities/daemon/useDaemonHealth'
import { relativeTime } from '@/shared/time'
import { deriveCause } from '@/shared/alertCause'
import type { ActionQueueItem } from '@/shared/schemas'

interface AlertsRailProps {
  /** Open (or reuse) the thread for this alert and show it. */
  onOpen: (item: ActionQueueItem) => void
  /** The alert whose thread the reading pane is currently showing, if any. */
  openItemId?: string | null
  /** True while a thread is being resolved, so the row can show it is working. */
  pendingItemId?: string | null
}

/** How many alerts the rail shows before it starts scrolling internally. */
const MAX_VISIBLE = 8

const priorityDot = (priority: ActionQueueItem['priority']): string => {
  if (priority === 'high') return 'bg-error'
  if (priority === 'low') return 'bg-muted-foreground'
  return 'bg-warning'
}

export const AlertsRail = ({ onOpen, openItemId, pendingItemId }: AlertsRailProps) => {
  const { items } = useActionQueue()
  const { isDown } = useDaemonHealth()

  const alerts = sortItems(items.filter((item) => item.kind !== 'draft-proposal'))

  return (
    <section
      data-testid="alerts-rail"
      aria-label="Alerts needing you"
      className="border-b border-primary/30 px-2 pb-2 pt-2"
    >
      <p className="flex items-center gap-1.5 px-1 pb-1 font-mono text-micro uppercase tracking-wide text-primary/50">
        Action Queue
        {alerts.length > 0 && (
          <span className="rounded-full bg-primary/20 px-1.5 font-mono text-micro leading-none text-primary">
            {alerts.length}
          </span>
        )}
      </p>

      {isDown ? (
        // Never render "all clear" over a daemon we cannot reach: an empty
        // alert list and an unreadable one look identical here.
        <p className="px-1 py-2 font-mono text-micro text-error" data-testid="alerts-rail-unreachable">
          Can't reach the daemon — alerts unknown
        </p>
      ) : alerts.length === 0 ? (
        <p className="px-1 py-2 font-mono text-micro text-primary/40" data-testid="alerts-rail-empty">
          Nothing needs you
        </p>
      ) : (
        <div
          className="flex flex-col gap-0.5 overflow-y-auto"
          style={{ maxHeight: `${MAX_VISIBLE * 2.75}rem` }}
        >
          {alerts.map((item) => {
            const isOpen = item.id === openItemId
            const isPending = item.id === pendingItemId
            // Every row of the same kind used to share one canned sentence
            // (`humanSummary`), so four failed tasks were indistinguishable
            // at a glance. `arcGoal` — the task's own prompt excerpt — is
            // what actually differs row to row; prefer it, same as
            // TriagePage and AlertCard already do.
            const goal = item.arcGoal ?? null
            const headline = goal ? goal.split('\n')[0]?.trim() || goal : item.humanSummary || item.title
            const cause = goal ? deriveCause(item.humanDetail) : undefined
            return (
              <button
                key={item.id}
                type="button"
                data-testid="alerts-rail-item"
                data-item-id={item.id}
                aria-current={isOpen ? 'true' : undefined}
                disabled={isPending}
                onClick={() => onOpen(item)}
                className={[
                  'flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors',
                  isOpen
                    ? 'border-l-2 border-l-highlight bg-card text-foreground'
                    : 'text-primary hover:bg-primary/10 hover:text-foreground',
                  isPending ? 'opacity-60' : '',
                ].join(' ')}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 flex-none rounded-full ${priorityDot(item.priority)}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-label">{headline}</span>
                  <span className="flex-none font-mono text-micro text-muted-foreground">
                    {isPending ? '…' : relativeTime(item.at)}
                  </span>
                </span>
                <span className="truncate pl-[12px] font-mono text-micro text-muted-foreground">
                  {cause ?? `${item.kind}${item.entityId ? ` · ${item.entityId}` : ''}`}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
