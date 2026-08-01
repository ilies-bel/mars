import { useCallback, useEffect, useRef, useState } from 'react'
import { BellIcon } from 'lucide-react'
import { useAlerts, useStartThreadFromAlert } from '@/entities/alerts'

/**
 * Navigate to a chat thread by writing the `#/chat?thread=<id>` hash. Setting
 * `window.location.hash` fires a native `hashchange`, which the app router (and
 * ChatPage's hashchange sync) pick up to render the thread. Used after pulling
 * an Alert into a conversation.
 */
const navigateToThread = (threadId: string): void => {
  if (typeof window === 'undefined') return
  window.location.hash = `#/chat?thread=${encodeURIComponent(threadId)}`
}

/**
 * Top-bar Bell surface (ADR-0080 foundation).
 *
 * A single bell for Alerts — the arc-rooted read aggregate (ADR-0054): each shows its goal
 *    (what the arc was trying to do) over the plain-English reason it failed.
 *    Read-only — an Alert clears only when the underlying entity mutates
 *    (ADR-0048), so there is no ack.
 * The badge count is open Alerts, capped at "9+". Clicking toggles a
 * minimal popover; outside-click and Escape close it. Styling reuses NavBar's
 * tokens (bg-background / border-primary/30 / text-foreground / text-primary).
 */
export const BellMenu = () => {
  const { alerts } = useAlerts()
  const { mutate: startThread, isPending } = useStartThreadFromAlert()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Pull an Alert into a conversation, navigate to it, and close the popover.
  // Picking an Alert does NOT clear it from the Bell (ADR-0048) — it clears only
  // when its arc resolves, so the alert list is left untouched here.
  const discussAlert = useCallback(
    (arcId: string) => {
      startThread(arcId, {
        onSuccess: ({ threadId }) => {
          navigateToThread(threadId)
          setOpen(false)
        },
      })
    },
    [startThread],
  )

  const total = alerts.length
  const badge = total === 0 ? null : total > 9 ? '9+' : String(total)

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
        aria-label={total > 0 ? `Bell, ${total} items` : 'Bell'}
        aria-expanded={open}
        className="relative rounded px-2 py-1 text-primary hover:text-foreground"
      >
        <BellIcon size={14} aria-hidden="true" />
        {badge !== null && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 rounded-full bg-primary/60 px-1 font-mono text-[9px] leading-none text-foreground"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded border border-primary/30 bg-background p-2 text-[11px] shadow-lg">
          <section>
            <h2 className="px-1 pb-1 font-mono text-[9px] uppercase tracking-wide text-primary">
              Alerts
            </h2>
            {alerts.length === 0 ? (
              <p className="px-1 py-1 text-primary">No alerts</p>
            ) : (
              <ul>
                {alerts.map((alert) => (
                  <li key={alert.arcId}>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => discussAlert(alert.arcId)}
                      aria-label={`Discuss: ${alert.goal}`}
                      className="block w-full rounded px-1 py-1 text-left hover:bg-primary/10 disabled:opacity-50"
                    >
                      <p className="text-foreground">{alert.goal}</p>
                      <p className="text-primary">{alert.reason}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
