import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge, taught this project's custom theme scales.
 *
 * Out of the box, tailwind-merge resolves conflicts by class *group*, and it
 * puts every `text-*` utility it does not recognise into a single group. Our
 * font sizes (`text-micro`, `text-body`, `text-heading`, …) and our semantic
 * colours (`text-error`, `text-muted-dark`, `text-status-failed`, …) are all
 * custom theme keys, so tailwind-merge could not tell a size from a colour and
 * treated them as mutually exclusive.
 *
 * The consequence was silent and easy to miss: any `cn()` call that combined a
 * size with a colour lost the size. `cn('text-micro', 'text-warn')` rendered as
 * `text-warn` alone, and the element quietly inherited its parent's font size —
 * which is exactly how an 11px chip shipped at 13px.
 *
 * Declaring both scales below restores the intended behaviour: sizes conflict
 * only with sizes, colours only with colours.
 */
const FONT_SIZES = [
  'micro',
  'label',
  'body',
  'title',
  'section',
  'heading',
  'display',
  'metric',
] as const

const COLORS = [
  // semantic surface / ink
  'bg', 'surface', 'panel', 'fg', 'muted', 'muted-2', 'border', 'highlight',
  'bg-dark', 'surface-dark', 'fg-dark', 'muted-dark', 'border-dark',
  'accent-on-dark',
  // state
  'error', 'warn', 'warn-on-dark', 'success',
  // brand palette
  'flame', 'amber', 'iron', 'ochre', 'basalt', 'rust', 'dune', 'ice', 'teal',
  'dust', 'night', 'trace-mars',
  // task status
  'status-queued', 'status-running', 'status-verifying', 'status-blocked',
  'status-failed', 'status-dropped', 'status-done',
] as const

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...FONT_SIZES] }],
      'text-color': [{ text: [...COLORS] }],
      'bg-color': [{ bg: [...COLORS] }],
      'border-color': [{ border: [...COLORS] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
