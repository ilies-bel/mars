/**
 * Returns true when the given event target is a text-entry field (input,
 * textarea, select, or contenteditable element).
 *
 * Used by global and view-level keyboard handlers to suppress shortcuts while
 * the user is typing in a form control.
 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}
