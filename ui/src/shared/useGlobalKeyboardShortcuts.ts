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
 * Registers global keyboard shortcuts for the operator keyboard-first workflow.
 *
 * - 1-9  focus the nth visible task card on the Board (via [data-task-index])
 * - t     navigate to #/chat (triage — the chat page hosts the action queue)
 * - ?     open the keyboard shortcuts help overlay (#/shortcuts)
 *
 * Shortcuts are silenced when:
 *   - focus is inside an input, textarea, select, or contenteditable element
 *   - the event is part of an IME composition sequence (isComposing)
 *   - a drawer or modal overlay is currently open (hash-based detection)
 *   - a modifier key (Ctrl, Meta, Alt) is held
 */
export const useGlobalKeyboardShortcuts = (): void => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.isComposing) return
      if (isEditableTarget(e.target)) return
      if (isOverlayHash(window.location.hash)) return

      if (e.key === 't') {
        e.preventDefault()
        // Both labels for this key said the action queue — the footer's
        // "action queue" and the overlay's "Go to Needs You" are the same
        // page. Only the handler disagreed, and it won.
        window.location.hash = '#/triage'
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        window.location.hash = '#/shortcuts'
        return
      }
      // There is no 1-9 handler any more.
      //
      // It looked for `[data-task-index="<n>"]`, an attribute that appears
      // nowhere in the app — only inside this hook's own test file, which set
      // it by hand and then proved the hook could find it. So the shortcut had
      // never once worked, while the footer and the overlay both advertised
      // it. Even working, it would have been unusable: no card carries a
      // visible position number, so "jump to task 5" is a guess. Restoring it
      // means rendering the digit on the card first.
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
}
