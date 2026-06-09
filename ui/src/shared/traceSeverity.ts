import type { TraceEvent } from './schemas'

/**
 * Returns Tailwind utility classes for a trace-event list row.
 * Each severity level gets a distinct left-border accent and text tint so
 * operators can spot errors at a glance without leaving the action queue.
 *
 * All class tokens (`error`, `warn`, `iron`) are design-system colors already
 * used elsewhere in `ui/src` — no raw hex codes.
 */
export function traceEventRowClass(severity: TraceEvent['severity']): string {
  if (severity === 'error') return 'border-l-2 border-error pl-1.5 text-error'
  if (severity === 'warn') return 'border-l-2 border-warn pl-1.5 text-warn'
  return 'border-l-2 border-iron/30 pl-1.5 text-iron/70'
}
