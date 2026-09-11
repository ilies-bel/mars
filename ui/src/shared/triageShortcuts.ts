/**
 * Row-level keyboard shortcuts active on the Needs You (Triage) page.
 *
 * Exported from one place so the keyboard handler in TriagePage and the
 * ShortcutsOverlay both read the same table — a binding cannot do one thing
 * and be described as another.
 */
export const TRIAGE_SHORTCUTS: ReadonlyArray<{ key: string; desc: string }> = [
  { key: '/', desc: 'Focus queue search' },
  { key: 'j / ↓', desc: 'Select next row' },
  { key: 'k / ↑', desc: 'Select previous row' },
  { key: 'Enter', desc: 'Open selected row drawer' },
  { key: '→ / ←', desc: 'Expand / collapse group' },
  { key: 'Space', desc: 'Run primary action on selected row' },
]
