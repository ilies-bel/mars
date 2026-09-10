import { useEffect } from 'react'
import { isEditableTarget } from './isEditableTarget'

/** Returns true when the current hash indicates a drawer or modal is layered on the page. */
const isOverlayHash = (hash: string): boolean => {
  if (hash === '#/release-notes' || hash === '#/shortcuts') return true
  if (hash.startsWith('#/task/')) return true
  if (hash.startsWith('#/proposal/')) return true
  if (hash.startsWith('#/proposal-node/')) return true
  return false
}

/**
 * Every navigation shortcut, in one table.
 *
 * The handler and the help overlay both read it, so a key cannot do one thing
 * and be described as another — which is exactly what happened before: `t`
 * navigated to Chat while the overlay said "Go to Needs You" and the footer
 * said "action queue", and a `1-9` row was advertised for an attribute no
 * component rendered.
 *
 * Letters mirror the sidebar's own names where the initial is free, so the
 * mapping is learnable from the nav rather than memorised from this file.
 * There are no other single-key bindings in the app, and the handler stands
 * down inside inputs, so a bare letter is safe here.
 */
export const NAV_SHORTCUTS: ReadonlyArray<{ key: string; hash: string; desc: string }> = [
  { key: 't', hash: '#/triage', desc: 'Needs You' },
  { key: 'd', hash: '#/proposals', desc: 'Drafts' },
  { key: 'c', hash: '#/chat', desc: 'Chat' },
  { key: 'b', hash: '#/progress', desc: 'Progress board' },
  { key: 'e', hash: '#/events', desc: 'Events' },
  { key: 'k', hash: '#/kpi', desc: 'KPI' },
  { key: 's', hash: '#/studio', desc: 'Scores' },
  { key: 'r', hash: '#/reflections', desc: 'Reflections' },
  { key: 'o', hash: '#/control', desc: 'Control Room' },
  { key: 'w', hash: '#/steward', desc: 'Steward' },
]

/**
 * Registers global keyboard shortcuts for the operator keyboard-first workflow.
 *
 * - the letters in {@link NAV_SHORTCUTS} jump to that page
 * - `?` opens the keyboard shortcuts help overlay (#/shortcuts)
 *
 * Shortcuts are silenced when:
 *   - focus is inside an input, textarea, select, or contenteditable element
 *   - the event is part of an IME composition sequence (isComposing)
 *   - a drawer or modal overlay is currently open (hash-based detection)
 *   - a modifier key (Ctrl, Meta, Alt) is held
 *
 * There is no 1-9 handler. It looked for `[data-task-index="<n>"]`, an
 * attribute that appears nowhere in the app — only inside this hook's own test
 * file, which set it by hand and then proved the hook could find it. Even
 * working it would have been unusable: no card carries a visible position
 * number, so "jump to task 5" is a guess. Restoring it means rendering the
 * digit on the card first.
 */
export const useGlobalKeyboardShortcuts = (): void => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.isComposing) return
      if (isEditableTarget(e.target)) return
      if (isOverlayHash(window.location.hash)) return

      if (e.key === '?') {
        e.preventDefault()
        window.location.hash = '#/shortcuts'
        return
      }
      const nav = NAV_SHORTCUTS.find((s) => s.key === e.key)
      if (nav) {
        e.preventDefault()
        window.location.hash = nav.hash
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
}
