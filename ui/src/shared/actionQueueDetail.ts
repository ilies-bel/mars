/**
 * Pure helpers for the actionQueue detail panel: trace-event payload summary
 * and severity styling, kept out of the React component so they can be
 * unit-tested without a render.
 *
 * The former failure-reason catalog helpers (lookup, action-op binding,
 * CLI-hint rendering) were removed with the code-keyed catalog (ADR-0042):
 * failed-task rows now render their reason and recovery menu directly from the
 * row's `body` and `actions` fields, derived daemon-side from the single
 * signature-keyed Failure kind record.
 */
import type { TraceEvent } from './schemas'

/**
 * Build a one-line summary of a trace event payload. Defers to the kind so
 * the Traces section reads more like a timeline than a JSON dump.
 */
export const summarizeTraceEvent = (event: TraceEvent): string => {
  const p = event.payload
  if (event.kind === 'step_started' || event.kind === 'step_ended') {
    const name = typeof p.stepName === 'string' ? p.stepName : '(unknown step)'
    const outcome = typeof p.outcome === 'string' ? ` (${p.outcome})` : ''
    return `${name}${outcome}`
  }
  if (event.kind === 'tool_invoked') {
    const tool = typeof p.tool === 'string' ? p.tool : '(tool)'
    const exit = typeof p.exitCode === 'number' ? ` (exit ${p.exitCode})` : ''
    return `${tool}${exit}`
  }
  if (event.kind === 'task_failed') {
    const reason =
      typeof p.failureReasonCode === 'string'
        ? p.failureReasonCode
        : typeof p.failureReason === 'string'
          ? p.failureReason
          : null
    return reason ?? 'task failed'
  }
  if (event.kind === 'task_blocked') {
    const blockedBy =
      typeof p.blockerTaskId === 'string'
        ? p.blockerTaskId
        : Array.isArray(p.blockedBy)
          ? (p.blockedBy as unknown[]).filter((s) => typeof s === 'string').join(', ')
          : null
    return blockedBy ? `blocked by ${blockedBy}` : 'blocked'
  }
  if (event.kind === 'recovery_spawned') {
    const recoveryId =
      typeof p.recoveryTaskId === 'string' ? p.recoveryTaskId : null
    return recoveryId ? `recovery ${recoveryId}` : 'recovery spawned'
  }
  if (event.kind === 'origin_created') {
    return typeof p.source === 'string' ? `origin (${p.source})` : 'origin'
  }
  // Unknown kind — fall back to the kind name itself.
  return event.kind
}

/**
 * Severity-to-tailwind color token used for the dot/badge next to each
 * trace event. Sticks to the existing palette (`iron`/`fg` + warn/err
 * accents from elsewhere in the codebase).
 */
export const severityColor = (severity: TraceEvent['severity']): string => {
  if (severity === 'error') return 'text-error'
  if (severity === 'warn') return 'text-warn'
  return 'text-iron/70'
}

/** Kinds the UI labels distinctly in the Origins tree badge. */
export const originKindLabel = (kind: string): string => {
  if (kind === 'proposal') return 'PROPOSAL'
  if (kind === 'prd') return 'PRD'
  if (kind === 'fix') return 'FIX'
  return 'TASK'
}
