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
 *
 * Every line is a natural-language clause an operator can scan at a glance:
 * non-zero exits, failures, and blocks all read as short sentences rather than
 * raw telemetry fragments.
 */
export const summarizeTraceEvent = (event: TraceEvent): string => {
  const p = event.payload

  if (event.kind === 'step_started') {
    return typeof p.stepName === 'string' ? p.stepName : '(unknown step)'
  }

  if (event.kind === 'step_ended') {
    const name = typeof p.stepName === 'string' ? p.stepName : '(unknown step)'
    const raw = typeof p.outcome === 'string' ? p.outcome : null
    const outcome = raw === 'failure' ? 'failed' : raw === 'completed' ? 'completed' : (raw ?? 'ended')
    return `${name} step ${outcome}`
  }

  if (event.kind === 'tool_invoked') {
    const rawTool = typeof p.tool === 'string' ? p.tool : '(tool)'
    // Use the basename when the tool is a full path (e.g. /usr/bin/git → git).
    const tool = rawTool.includes('/') ? (rawTool.split('/').pop() || rawTool) : rawTool
    const exitCode = typeof p.exitCode === 'number' ? p.exitCode : null
    if (exitCode !== null && exitCode !== 0) {
      const phase = typeof event.phase === 'string' ? event.phase : null
      return phase
        ? `${tool} exited ${exitCode} during the ${phase} step`
        : `${tool} exited ${exitCode}`
    }
    return `ran ${tool}`
  }

  if (event.kind === 'task_failed') {
    // Prefer human-readable prose; only fall through to the machine code when
    // no prose is available, and humanize even then.
    if (typeof p.failureReason === 'string') return p.failureReason
    if (typeof p.failureReasonCode === 'string') {
      const code = p.failureReasonCode
      const colonIdx = code.indexOf(':')
      if (colonIdx !== -1) {
        // 'verify:typecheck' → 'typecheck (verify step)'
        return `${code.slice(colonIdx + 1)} (${code.slice(0, colonIdx)} step)`
      }
      // 'tool_timeout' → 'tool timeout'
      return code.replace(/[_-]/g, ' ')
    }
    return 'task failed'
  }

  if (event.kind === 'task_blocked') {
    const blockedBy =
      typeof p.blockerTaskId === 'string'
        ? p.blockerTaskId
        : Array.isArray(p.blockedBy)
          ? (p.blockedBy as unknown[]).filter((s) => typeof s === 'string').join(', ')
          : null
    return blockedBy ? `waiting on ${blockedBy}` : 'blocked'
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

/**
 * Short display label for an action-queue row kind. Used in both the sidebar
 * row kind badge and the detail panel header badge so the label is authoritative
 * in one place for all four kinds (including `arc-failed`).
 */
export const kindBadgeLabel = (kind: string): string => {
  if (kind === 'arc-failed') return 'arc failed'
  if (kind === 'failed-task') return 'failed'
  if (kind === 'stale-worktree') return 'stale wt'
  if (kind === 'draft-proposal') return 'draft'
  return kind
}
