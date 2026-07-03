/**
 * ShortcutsOverlay — centered dialog listing keyboard shortcuts, opened via
 * `#/shortcuts`. Mirrors the accessibility vocabulary of ReleaseNotesModal:
 * same header shape, same 180 ms exit animation, same Escape-to-close and
 * Tab focus-trap behaviour.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface ShortcutsOverlayProps {
  /** Clears the `#/shortcuts` hash so the overlay closes. */
  onClose: () => void
}

const SHORTCUTS: ReadonlyArray<{ key: string; desc: string }> = [
  { key: '1-9', desc: 'Jump to task by position on the board' },
  { key: 't', desc: 'Go to action queue (triage)' },
  { key: '?', desc: 'Open this shortcuts overlay' },
  { key: 'Esc', desc: 'Close any open overlay or drawer' },
]

export const ShortcutsOverlay = ({ onClose }: ShortcutsOverlayProps) => {
  const dialogRef = useRef<HTMLElement>(null)
  const [closing, setClosing] = useState(false)
  // Synchronous guard — prevents double-scheduling the close timer.
  const closingRef = useRef(false)

  /**
   * Initiates the 180 ms exit animation then calls onClose.
   * All close triggers (button, scrim click, Escape) funnel through here.
   */
  const handleClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    setTimeout(() => onClose(), 180)
  }, [onClose])

  // On open: save the previously focused element and move focus into the dialog.
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

  return (
    <>
      {/* Scrim — full-viewport backdrop at z-40 (below the dialog's z-50) */}
      <div
        data-testid="shortcuts-overlay-scrim"
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
          aria-label="Keyboard shortcuts"
          data-testid="shortcuts-overlay"
          data-closing={closing ? 'true' : undefined}
          tabIndex={-1}
          className="modal-panel flex w-full max-w-sm flex-col rounded-lg border border-iron/40 bg-bg shadow-2xl outline-none"
        >
          <header className="flex items-center justify-between border-b border-iron/40 px-4 py-3">
            <h2 className="font-mono text-sm uppercase tracking-wide text-iron">
              Keyboard Shortcuts
            </h2>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close shortcuts"
              data-testid="shortcuts-close"
              className="rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
            >
              Close
            </button>
          </header>
          <table className="w-full border-collapse" role="table">
            <tbody>
              {SHORTCUTS.map(({ key, desc }) => (
                <tr key={key} className="border-b border-iron/20 last:border-b-0">
                  <td className="w-16 px-4 py-2.5">
                    <kbd className="font-mono text-[11px] font-semibold text-flame">{key}</kbd>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-fg">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </aside>
      </div>
    </>
  )
}
