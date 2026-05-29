import { useCallback, useEffect, useRef, useState } from 'react'
import type { DraftFeature, ProgressTask } from '@/shared/schemas'

interface ProposalDetailDrawerProps {
  /** Proposal sourced from the existing `/api/todo` drafts fetch. */
  proposal: DraftFeature
  /** Clears the `#/proposal/<id>` hash so the drawer closes. */
  onClose: () => void
  /**
   * Task list already loaded by the Progress tab. Used to show child tasks
   * when the proposal status is `sliced`. No new HTTP request is made.
   */
  tasks?: ProgressTask[]
}

/**
 * Status-badge colour pairs for the proposal lifecycle. The class shape
 * mirrors the task `StatusChip` legend (rounded, mono, uppercase) so the two
 * drawers read as one visual family. Unknown statuses fall back to the neutral
 * iron treatment rather than rendering nothing.
 */
const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-iron/10 text-iron',
  'prd-ready': 'bg-amber/15 text-ochre',
  sliced: 'bg-amber/15 text-ochre',
  dismissed: 'bg-iron/10 text-iron line-through',
}

const badgeClass = (status: string): string =>
  STATUS_BADGE[status] ?? 'bg-iron/10 text-iron'

/**
 * Slice 1 of the Proposal drawer: renders the proposal-specific header —
 * title, a status badge matching the Progress status legend, and the source
 * label (reflection / human / planner). Read-only; mutation surfaces and the
 * body sections land in later slices.
 */
export const ProposalDetailDrawer = ({
  proposal,
  onClose,
  tasks = [],
}: ProposalDetailDrawerProps) => {
  const childTasks = proposal.status === 'sliced'
    ? tasks.filter((t) => t.parentProposalId === proposal.id)
    : []
  const drawerRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)

  /**
   * Initiates the exit animation (180 ms) then calls the onClose prop.
   * All close triggers (button, scrim, Escape) funnel through here so the
   * transition always plays before the parent unmounts the drawer.
   */
  const handleClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose(), 180)
  }, [onClose])

  // On open: save the previously focused element and move focus into the drawer.
  // On close (cleanup): restore focus to where it was.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    drawerRef.current?.focus()
    return () => {
      prev?.focus?.()
    }
  }, [])

  // Escape-to-close + Tab focus trap.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
        return
      }
      if (e.key === 'Tab') {
        const container = drawerRef.current
        if (!container) return
        const focusable = [
          ...container.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ]
        if (focusable.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusable[0]!
        const last = focusable[focusable.length - 1]!
        if (e.shiftKey) {
          if (document.activeElement === first || document.activeElement === container) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClose])

  return (
    <>
      {/* Scrim — sits at z-40 (below the drawer's z-50) so clicks outside dismiss the panel */}
      <div
        data-testid="proposal-detail-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 bg-fg/40"
        onClick={handleClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Proposal detail"
        data-testid="proposal-detail-drawer"
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        className="drawer-panel fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] flex-col border-l border-iron/40 bg-bg shadow-2xl outline-none"
      >
      <header className="flex items-start justify-between gap-3 border-b border-iron/40 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-2">
          <h2
            data-testid="proposal-detail-title"
            className="break-words font-mono text-sm text-fg"
          >
            {proposal.title}
          </h2>
          <div className="flex items-center gap-2">
            <span
              data-testid="proposal-detail-status"
              aria-label={`status ${proposal.status}`}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${badgeClass(
                proposal.status,
              )}`}
            >
              {proposal.status}
            </span>
            <span
              data-testid="proposal-detail-source"
              className="font-mono text-[9px] uppercase tracking-wide text-iron/80"
            >
              {proposal.source}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close proposal detail"
          data-testid="proposal-detail-close"
          className="shrink-0 rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
        >
          Close
        </button>
      </header>
      {childTasks.length > 0 ? (
        <section
          data-testid="sliced-tasks"
          className="flex flex-col gap-2 overflow-y-auto border-b border-iron/40 px-4 py-3"
        >
          <h3 className="font-mono text-[10px] uppercase tracking-wide text-iron/80">
            Sliced tasks
          </h3>
          <ul className="flex flex-col gap-1.5">
            {childTasks.map((task) => (
              <li key={task.id}>
                <a
                  href={`#/task/${encodeURIComponent(task.id)}`}
                  className="flex items-center gap-2 rounded border border-iron/20 px-2 py-1.5 font-mono text-xs transition-colors hover:bg-iron/5"
                >
                  <span className="shrink-0 text-iron">{task.id}</span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badgeClass(task.status)}`}
                  >
                    {task.status}
                  </span>
                  <span className="min-w-0 truncate text-fg">
                    {task.prompt.split('\n')[0]?.slice(0, 80) ?? ''}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
    </>
  )
}
