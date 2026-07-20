import { useEffect } from 'react'

/** Returns true when the event target is a text-entry field. */
const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

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
 *   - a drawer or modal overlay is currently open (hash-based detection)
 *   - a modifier key (Ctrl, Meta, Alt) is held
 */
export const useGlobalKeyboardShortcuts = (): void => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isEditableTarget(e.target)) return
      if (isOverlayHash(window.location.hash)) return

      if (e.key === 't') {
        e.preventDefault()
        window.location.hash = '#/chat'
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        window.location.hash = '#/shortcuts'
        return
      }
      const digit = parseInt(e.key, 10)
      if (digit >= 1 && digit <= 9) {
        e.preventDefault()
        const card = document.querySelector<HTMLElement>(`[data-task-index="${digit - 1}"]`)
        card?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])
}
