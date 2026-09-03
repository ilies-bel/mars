import { useCallback, useEffect, useRef, useState } from 'react'
import { BellIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { countNeedsYou, sortItems } from '@/entities/actionQueue/clusterRows'
import { dismissActionQueueItem } from '@/shared/api'
import { startThreadFromAlert } from '@/entities/alerts/api'
import { hasResolvableTask } from '@/shared/schemas'

/**
 * Navigate to a chat thread by writing the `#/chat?thread=<id>` hash. Setting
 * `window.location.hash` fires a native `hashchange`, which the app router (and
 * ChatPage's hashchange sync) pick up to render the thread. Used after pulling
 * an item into a conversation.
 */
const navigateToThread = (threadId: string): void => {
  if (typeof window === 'undefined') return
  window.location.hash = `#/chat?thread=${encodeURIComponent(threadId)}`
}

/**
 * Kinds whose action-queue rows are informational notices the operator
 * acknowledges by reading. Mirrors NOTICE_KINDS in
 * orchestrator/src/core/lib/action-queue-kinds.ts — kept as a local literal
 * so the browser bundle never imports orchestrator node-only modules.
 */
const NOTICE_KINDS = new Set([
  'spend-control-notice',
  'scheduling-decision',
  'requeue-warning',
  'arc-superseded-on-main',
  'mockup-ready',
])

/**
 * Top-bar Bell surface (ADR-0080). Shows a single ranked list of all open
 * action-queue items — condition-class Alerts and notice-class Notices together,
 * sorted by the same ranking the Needs You page uses (priority then recency).
 *
 * - Condition-class Alerts: clear only when the underlying condition resolves.
 *   No ack button. Alerts backed by a resolvable task expose an
 *   open-into-conversation button.
 * - Notice-class Notices: stored rows the operator acknowledges by reading.
 *   Have an Acknowledge button that calls dismissActionQueueItem and
 *   invalidates the 'action-queue' query key.
 *
 * Badge: countNeedsYou(items), hidden when 0, capped at '99+'.
 */
export const BellMenu = () => {
  const { items } = useActionQueue()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const filtered = items.filter((item) => item.kind !== 'draft-proposal')
  const sorted = sortItems(filtered)
  const count = countNeedsYou(filtered)
  const badgeLabel = count > 99 ? '99+' : String(count)

  const handleAck = useCallback(
    (id: string) => {
      void dismissActionQueueItem(id).then(() => {
        queryClient.invalidateQueries({ queryKey: ['action-queue'] })
      })
    },
    [queryClient],
  )

  // startThreadFromAlert is a module-level import; setOpen is a stable state
  // setter — neither changes across renders, so deps are empty.
  const discussItem = useCallback((entityId: string) => {
    void startThreadFromAlert(entityId).then(({ threadId }) => {
      navigateToThread(threadId)
      setOpen(false)
    })
  }, [])

  // Close on outside-click and Escape while open.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Bell"
        aria-expanded={open}
        className="relative rounded px-2 py-1 text-primary transition-transform duration-150 ease-out hover:scale-105 hover:text-foreground"
      >
        <BellIcon size={14} aria-hidden="true" />
        {count > 0 && (
          <span
            aria-label={`${badgeLabel} items need attention`}
            className="absolute -right-1 -top-1 flex h-4 min-w-[18px] items-center justify-center rounded-full animate-badge-pulse px-1.5 text-micro font-medium text-white"
          >
            {badgeLabel}
          </span>
        )}
      </button>

      {open && (
        <div className="mars-card absolute right-0 top-full z-50 mt-1 w-72 rounded bg-background p-2 text-label">
          <section>
            <h2 className="px-1 pb-1 font-mono text-micro uppercase tracking-wide text-primary">
              Needs You
            </h2>
            {sorted.length === 0 ? (
              <p className="px-1 py-1 text-primary">Nothing needs you</p>
            ) : (
              <ul>
                {sorted.map((item) => {
                  const isNotice = NOTICE_KINDS.has(item.kind)
                  return (
                    <li
                      key={item.id}
                      className="flex items-start gap-2 rounded px-1 py-1 hover:bg-primary/10"
                    >
                      {isNotice ? (
                        <span className="mt-0.5 shrink-0 font-mono text-micro uppercase text-muted-dark">
                          Notice
                        </span>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-destructive"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-foreground">{item.title}</p>
                        {isNotice ? (
                          <button
                            type="button"
                            onClick={() => handleAck(item.id)}
                            className="text-micro text-primary underline hover:text-foreground"
                          >
                            Acknowledge
                          </button>
                        ) : (
                          hasResolvableTask(item) && (
                            <button
                              type="button"
                              onClick={() => discussItem(item.entityId)}
                              className="text-micro text-primary underline hover:text-foreground"
                            >
                              Discuss
                            </button>
                          )
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
