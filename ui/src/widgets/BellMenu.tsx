import { useEffect, useRef, useState } from 'react'
import { BellIcon } from 'lucide-react'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useNotices } from '@/entities/notices'

/**
 * Top-bar Bell surface (ADR-0080 foundation).
 *
 * A single bell that folds together two kinds of "needs a look" state:
 *  - Alerts — entity-backed rows from the action queue (title only, read-only
 *    for now; the arc-rooted `viewAlerts()` source lands in slice 2).
 *  - Notices — entity-less bell messages (ADR-0079) the operator clears by
 *    acknowledging.
 *
 * The badge count is Alerts + open Notices, capped at "9+". Clicking toggles a
 * minimal popover; outside-click and Escape close it. Styling reuses NavBar's
 * tokens (bg-bg / border-iron/30 / text-fg / text-iron).
 */
export const BellMenu = () => {
  const { items: alerts } = useActionQueue()
  const { notices, ack } = useNotices()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const total = alerts.length + notices.length
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
        className="relative rounded px-2 py-1 text-iron hover:text-fg"
      >
        <BellIcon size={14} aria-hidden="true" />
        {badge !== null && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 rounded-full bg-iron/60 px-1 font-mono text-[9px] leading-none text-fg"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded border border-iron/30 bg-bg p-2 text-[11px] shadow-lg">
          <section>
            <h2 className="px-1 pb-1 font-mono text-[9px] uppercase tracking-wide text-iron">
              Alerts
            </h2>
            {alerts.length === 0 ? (
              <p className="px-1 py-1 text-iron">No alerts</p>
            ) : (
              <ul>
                {alerts.map((alert) => (
                  <li key={alert.id} className="px-1 py-1 text-fg">
                    {alert.title}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="my-2 h-px bg-iron/30" aria-hidden="true" />

          <section>
            <h2 className="px-1 pb-1 font-mono text-[9px] uppercase tracking-wide text-iron">
              Notices
            </h2>
            {notices.length === 0 ? (
              <p className="px-1 py-1 text-iron">No notices</p>
            ) : (
              <ul>
                {notices.map((notice) => (
                  <li
                    key={notice.id}
                    className="flex items-start justify-between gap-2 px-1 py-1"
                  >
                    <span className="text-fg">{notice.body}</span>
                    <button
                      type="button"
                      onClick={() => ack(notice.id)}
                      className="shrink-0 rounded border border-iron/30 px-1.5 py-0.5 text-[10px] text-iron hover:text-fg"
                    >
                      Ok, got it
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
