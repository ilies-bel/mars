/**
 * Shared helpers for alert verb buttons — used by both AlertCard and FocusVerbsRow
 * so the two entry points share one dispatch implementation.
 */

import { invokeAction } from '@/shared/api'
import { PROCESS_LEVEL_OPS } from './QueueThreadDetail'
import type { AlertVerb } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Button styling — shared between AlertCard and FocusVerbsRow
// ---------------------------------------------------------------------------

export const verbButtonClass = (style: AlertVerb['style']): string => {
  const base =
    'rounded px-3 py-1 font-mono text-[11px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  if (style === 'primary')
    return `${base} border-highlight/60 bg-highlight/10 text-highlight hover:bg-highlight/20`
  if (style === 'destructive')
    return `${base} border-error/40 bg-error/10 text-error hover:bg-error/20`
  if (style === 'snooze')
    return `${base} border-primary/30 text-primary/70 hover:bg-primary/20`
  return `${base} border-primary/30 text-primary hover:bg-primary/20`
}

// ---------------------------------------------------------------------------
// Shared verb dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a single alert verb to the API.
 *
 * `itemId`   — the opaque action-queue row id (e.g. "abc123")
 * `entityId` — the entity the item refers to (e.g. a task id)
 * `op`       — the verb op code (e.g. "restart", "purge")
 *
 * Process-level ops (restart-daemon etc.) are dispatched without an entityId.
 */
export const dispatchAlertVerb = async (
  _itemId: string,
  entityId: string,
  op: string,
): Promise<void> => {
  await invokeAction(op, PROCESS_LEVEL_OPS.has(op) ? undefined : entityId)
}
