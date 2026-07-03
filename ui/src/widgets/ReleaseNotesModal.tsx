/**
 * Release Notes modal — centered dialog listing landed arcs, opened via
 * `#/release-notes`. Mirrors the accessibility vocabulary of TaskDetailDrawer
 * and ProposalDetailDrawer: same header shape, same 180 ms exit animation,
 * same Escape-to-close behaviour.
 *
 * Each row shows the arc title, a human-friendly `landedAt` date, and a
 * subtle "+N recovery" badge when the arc required at least one recovery task.
 * Clicking a row expands its detail inline: the full prompt and, when present,
 * the structured spec (files, verifyCmd, doneCriteria).
 *
 * On open, the modal:
 *   1. Captures `lastViewedAt` from the cursor query to determine unseen entries.
 *   2. POSTs the cursor to mark all current entries as viewed.
 *   3. Renders a "new since you were away" divider just above the oldest unseen
 *      entry (in the newest-first list) and scrolls it into view.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchReleaseNotes, getReleaseNotesCursor, postReleaseNotesViewed } from '@/shared/api'
import type { ReleaseNoteEntry } from '@/shared/schemas'
import { relativeTime } from '@/shared/time'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { computeUnseen } from '@/shared/useReleaseNotesAutoOpen'

interface ReleaseNotesModalProps {
  /** Clears the `#/release-notes` hash so the modal closes. */
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
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            {spec.taskType}
          </p>
        </div>
      ) : null}
    </div>
  )
}

// ── Main modal ─────────────────────────────────────────────────────────────

export const ReleaseNotesModal = ({ onClose }: ReleaseNotesModalProps) => {
  const dialogRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)
  // Id of the currently-expanded entry row, or null when all are collapsed.
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const projectId = useFocusedProjectId()
  const qc = useQueryClient()

  const { data, isPending, isError } = useQuery({
    queryKey: ['release-notes', projectId],
    queryFn: () => fetchReleaseNotes(projectId ?? undefined),
  })

  const { data: cursorData } = useQuery({
    queryKey: ['release-notes-cursor', projectId],
    queryFn: () => getReleaseNotesCursor(projectId ?? undefined),
  })

  // Capture firstUnseenIndex the moment both queries are first available.
  // Frozen in a ref so the divider reflects state AT modal-open time, not
  // after the cursor POST updates the query and the view re-renders.
  const capturedRef = useRef<{ value: number | null } | null>(null)
  if (capturedRef.current === null && data !== undefined && cursorData !== undefined) {
    capturedRef.current = {
      value: computeUnseen(data, cursorData.lastViewedAt).firstUnseenIndex,
    }
  }
  const firstUnseenIndex = capturedRef.current?.value ?? null

  // Mark viewed (once) and scroll to oldest-unseen (once) when data+cursor land.
  const hasMarkedViewed = useRef(false)

  useEffect(() => {
    if (hasMarkedViewed.current) return
    if (data === undefined || cursorData === undefined) return

    hasMarkedViewed.current = true

    // Mark the release notes as viewed (both auto-open and manual open).
    void postReleaseNotesViewed(projectId ?? undefined).then(() => {
      void qc.invalidateQueries({ queryKey: ['release-notes-cursor', projectId] })
    })
  }, [data, cursorData, projectId, qc])

  // Ref for the oldest-unseen list item — scrolled into view once captured.
  const oldestUnseenRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (firstUnseenIndex === null) return
    oldestUnseenRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstUnseenIndex])

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

  // On open: save the previously focused element and move focus into the modal.
  // On close (cleanup): restore focus to where it was.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
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
        const container = dialogRef.current
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
      {/* Scrim — full-viewport backdrop at z-40 (below the dialog's z-50) */}
      <div
        data-testid="release-notes-overlay"
        aria-hidden="true"
        data-closing={closing ? 'true' : undefined}
        className="modal-scrim fixed inset-0 z-40 bg-fg/40"
        onClick={handleClose}
      />
      {/* Centering wrapper at z-50 */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <aside
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Release Notes"
          data-testid="release-notes-drawer"
          data-closing={closing ? 'true' : undefined}
          tabIndex={-1}
          className="modal-panel flex w-full max-w-[560px] max-h-[85vh] flex-col rounded-lg border border-iron/40 bg-bg shadow-2xl outline-none"
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
                {data.map((entry, i) => {
                  const isExpanded = expandedId === entry.originId
                  const isOldestUnseen = firstUnseenIndex !== null && i === firstUnseenIndex
                  // Show the "new since you were away" divider just above the
                  // oldest unseen entry (between index firstUnseenIndex-1 and
                  // firstUnseenIndex in the newest-first list).
                  const showDividerAbove =
                    firstUnseenIndex !== null &&
                    i === firstUnseenIndex &&
                    firstUnseenIndex > 0
                  return (
                    <Fragment key={entry.originId}>
                      {showDividerAbove ? (
                        <li
                          role="separator"
                          data-testid="unseen-divider"
                          className="flex items-center gap-2 px-4 py-1.5"
                        >
                          <span className="h-px flex-1 bg-accent/40" aria-hidden="true" />
                          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent">
                            new since you were away
                          </span>
                          <span className="h-px flex-1 bg-accent/40" aria-hidden="true" />
                        </li>
                      ) : null}
                      <li
                        ref={isOldestUnseen ? oldestUnseenRef : null}
                        data-testid="release-note-row"
                        data-oldest-unseen={isOldestUnseen ? 'true' : undefined}
                      >
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
                    </Fragment>
                  )
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}
