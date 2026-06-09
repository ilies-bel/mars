/**
 * Release Notes drawer — right-side panel listing landed arcs, opened via
 * `#/release-notes`. Mirrors the styling vocabulary of TaskDetailDrawer and
 * ProposalDetailDrawer: same header shape, same scrim, same 180 ms exit
 * animation, same Escape-to-close behaviour.
 *
 * Each row shows the arc title, a human-friendly `landedAt` date, and a
 * subtle "+N recovery" badge when the arc required at least one recovery task.
 * Clicking a row expands its detail inline: the full prompt and, when present,
 * the structured spec (files, verifyCmd, doneCriteria).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchReleaseNotes } from '@/shared/api'
import type { ReleaseNoteEntry } from '@/shared/schemas'
import { relativeTime } from '@/shared/time'
import { useFocusedProjectId } from '@/shared/useFocusedProject'

interface ReleaseNotesDrawerProps {
  /** Clears the `#/release-notes` hash so the drawer closes. */
  onClose: () => void
}

// ── Section label shared across the detail expand panel ───────────────────

const SECTION_LABEL = 'font-mono text-[11px] uppercase tracking-[0.1em] text-muted'

/** Renders a bullet list; omits itself when the array is empty. */
const StringList = ({ items }: { items: readonly string[] }) =>
  items.length > 0 ? (
    <ul className="flex flex-col gap-0.5">
      {items.map((s) => (
        <li key={s} className="break-all font-mono text-[11px] text-iron">
          {s}
        </li>
      ))}
    </ul>
  ) : null

// ── Expanded detail panel for a single arc entry ──────────────────────────

interface EntryDetailProps {
  entry: ReleaseNoteEntry
}

const EntryDetail = ({ entry }: EntryDetailProps) => {
  const { spec } = entry.detail
  return (
    <div
      data-testid="release-note-detail"
      className="flex flex-col gap-3 border-t border-iron/20 bg-bg px-4 py-3"
    >
      {/* Prompt */}
      <div>
        <p className={`mb-1 ${SECTION_LABEL}`}>Prompt</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-fg">
          {entry.detail.prompt}
        </pre>
      </div>

      {/* Spec — only when present */}
      {spec !== null ? (
        <div data-testid="release-note-spec" className="flex flex-col gap-2">
          <p className={SECTION_LABEL}>Spec</p>
          {spec.files.length > 0 ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Files
              </p>
              <StringList items={spec.files} />
            </div>
          ) : null}
          {spec.verifyCmd !== null ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Verify
              </p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-fg">
                {spec.verifyCmd}
              </p>
            </div>
          ) : null}
          {spec.doneCriteria.length > 0 ? (
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                Done
              </p>
              <StringList items={spec.doneCriteria} />
            </div>
          ) : null}
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-iron/60">
            {spec.taskType}
          </p>
        </div>
      ) : null}
    </div>
  )
}

// ── Main drawer ────────────────────────────────────────────────────────────

export const ReleaseNotesDrawer = ({ onClose }: ReleaseNotesDrawerProps) => {
  const drawerRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)
  // Id of the currently-expanded entry row, or null when all are collapsed.
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const projectId = useFocusedProjectId()

  const { data, isPending, isError } = useQuery({
    queryKey: ['release-notes', projectId],
    queryFn: () => fetchReleaseNotes(projectId ?? undefined),
  })

  /**
   * Initiates the exit animation (180 ms) then calls the onClose prop.
   * All close triggers (button, scrim, Escape) funnel through here.
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

  const toggleExpand = (originId: string) => {
    setExpandedId((prev) => (prev === originId ? null : originId))
  }

  return (
    <>
      {/* Scrim — sits at z-40 (below the drawer's z-50) */}
      <div
        data-testid="release-notes-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="drawer-scrim fixed inset-0 z-40 hidden bg-fg/40 xl:block"
        onClick={handleClose}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Release Notes"
        data-testid="release-notes-drawer"
        data-closing={closing ? 'true' : undefined}
        tabIndex={-1}
        className="drawer-panel fixed inset-0 z-50 flex w-full flex-col border-iron/40 bg-bg outline-none xl:inset-y-0 xl:left-auto xl:right-0 xl:w-[min(560px,100vw)] xl:border-l xl:shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-iron/40 px-4 py-3">
          <h2 className="font-mono text-sm uppercase tracking-wide text-iron">
            Release Notes
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close release notes"
            data-testid="release-notes-close"
            className="rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
          >
            Close
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {isPending ? (
            <p
              data-testid="release-notes-loading"
              className="px-4 py-6 font-mono text-xs text-iron"
            >
              Loading…
            </p>
          ) : isError ? (
            <p
              data-testid="release-notes-error"
              className="px-4 py-6 font-mono text-xs text-error"
            >
              Failed to load release notes.
            </p>
          ) : data === undefined || data.length === 0 ? (
            <p
              data-testid="release-notes-empty"
              className="px-4 py-6 font-mono text-xs text-iron"
            >
              No work has landed yet.
            </p>
          ) : (
            <ul data-testid="release-notes-list">
              {data.map((entry) => {
                const isExpanded = expandedId === entry.originId
                return (
                  <li key={entry.originId} data-testid="release-note-row">
                    <button
                      type="button"
                      onClick={() => toggleExpand(entry.originId)}
                      aria-expanded={isExpanded}
                      className="flex w-full items-start gap-2 border-b border-iron/20 px-4 py-3 text-left hover:bg-iron/5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium text-fg">
                          {entry.title}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[11px] text-iron">
                            {relativeTime(entry.landedAt)}
                          </span>
                          {entry.detail.recoveryCount > 0 ? (
                            <span
                              data-testid="recovery-badge"
                              className="rounded border border-iron/30 px-1 font-mono text-[10px] text-muted"
                            >
                              +{entry.detail.recoveryCount} recovery
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span
                        className="mt-1 shrink-0 font-mono text-[10px] text-muted"
                        aria-hidden="true"
                      >
                        {isExpanded ? '▾' : '▸'}
                      </span>
                    </button>
                    {isExpanded ? <EntryDetail entry={entry} /> : null}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  )
}
