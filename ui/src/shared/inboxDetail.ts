/**
 * Pure helpers for the inbox detail panel.
 *
 * Keeps the catalog lookup, action-op binding table, trace-event payload
 * summary, and origin-node styling decisions out of the React component so
 * they can be unit-tested without a render.
 */
import type {
  ActionDescriptor,
  FailureActionCatalog,
  FailureReasonCatalogEntry,
  TraceEvent,
} from './schemas'

/**
 * The fallback code emitted by the orchestrator when no failure code is
 * known. Mirrors `UNKNOWN_FAILURE_CODE` on the orchestrator side; declared
 * inline so the UI stays a standalone package.
 */
export const UNKNOWN_FAILURE_CODE = 'unknown'

/**
 * Resolve a code to its catalog entry. Falls back to the `unknown` entry
 * when the code is absent or not present in the catalog. Returns null when
 * the catalog itself has no `unknown` entry (defensive: the orchestrator's
 * built-in seed always carries one).
 */
export const resolveFailureReason = (
  code: string | null | undefined,
  catalog: readonly FailureReasonCatalogEntry[],
): FailureReasonCatalogEntry | null => {
  const fallback =
    catalog.find((e) => e.code === UNKNOWN_FAILURE_CODE) ?? null
  if (!code) return fallback
  return catalog.find((e) => e.code === code) ?? fallback
}

/**
 * Map a catalog action id to the existing UI action op (the verb the daemon's
 * `/actions/:op/:id` route handles). Returns null when the catalog action has
 * no UI binding — the renderer then falls back to a disabled button labelled
 * with the action's `cliHint`.
 */
export const CATALOG_ACTION_OP_BINDING: Record<string, string> = {
  restart: 'restart',
  purge: 'purge',
  dismiss: 'dismiss',
  investigate: 'investigate',
  'diagnose-failure': 'diagnose-failure',
  unblock: 'unblock',
  'prune-worktree': 'prune-worktree',
  'restart-daemon': 'restart-daemon',
}

export const opForCatalogAction = (
  action: FailureActionCatalog,
): string | null => {
  return CATALOG_ACTION_OP_BINDING[action.id] ?? null
}

/**
 * Substitute `<id>` placeholders in an action's cliHint with the task id.
 * Mirrors `substituteTaskId` on the orchestrator side; inlined here so the
 * disabled-button label can show the operator-ready CLI.
 */
export const substituteTaskId = (hint: string, taskId: string): string =>
  hint.replace(/<id>/g, taskId)

/**
 * Render a catalog action as the ActionDescriptor shape the rest of the inbox
 * UI already speaks. Bound actions keep their op + label as-is; unbound
 * actions are flagged via `op: ''` (the renderer disables the button and
 * shows the CLI hint instead).
 */
export interface CatalogActionDescriptor {
  /** The catalog action id, used as the React key. */
  id: string
  /** The button label. Unbound actions wrap the label in `(CLI only: ...)`. */
  label: string
  /**
   * The op the renderer hands to `invokeAction`. Empty string for unbound
   * actions — the button is disabled and never fires.
   */
  op: string
  /**
   * Whether the button should be disabled. Always true for unbound actions.
   */
  disabled: boolean
  /**
   * The raw catalog entry, preserved so callers can read `cliHint`/`label`
   * if they need the underlying text.
   */
  raw: FailureActionCatalog
}

export const catalogActionsForDetail = (
  actions: readonly FailureActionCatalog[],
  taskId: string,
): CatalogActionDescriptor[] =>
  actions.map((a) => {
    const op = opForCatalogAction(a)
    if (op !== null) {
      return { id: a.id, label: a.label, op, disabled: false, raw: a }
    }
    const cli = a.cliHint ? substituteTaskId(a.cliHint, taskId) : 'no CLI hint'
    return {
      id: a.id,
      label: `${a.label} (CLI only: ${cli})`,
      op: '',
      disabled: true,
      raw: a,
    }
  })

/**
 * Wrap a catalog descriptor as an ActionDescriptor (the existing UI shape).
 * Useful when the renderer wants to fall through to the same action machinery
 * as the existing ActionBar (e.g. `needsConfirm` semantics).
 */
export const toActionDescriptor = (
  c: CatalogActionDescriptor,
): ActionDescriptor => ({
  id: c.id,
  label: c.label,
  op: c.op,
  needsConfirm: c.id === 'purge',
})

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
  if (severity === 'error') return 'text-[#ff4f4f]'
  if (severity === 'warn') return 'text-[#ff944d]'
  return 'text-iron/70'
}

/** Kinds the UI labels distinctly in the Origins tree badge. */
export const originKindLabel = (kind: string): string => {
  if (kind === 'proposal') return 'PROPOSAL'
  if (kind === 'prd') return 'PRD'
  if (kind === 'fix') return 'FIX'
  return 'TASK'
}
