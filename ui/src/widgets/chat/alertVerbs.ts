/**
 * Shared helpers for alert verb buttons — used by both AlertCard and FocusVerbsRow
 * so the two entry points share one dispatch implementation.
 */

import type { QueryClient } from '@tanstack/react-query'
import { invokeAction, createChatThread } from '@/shared/api'
import { startThreadFromAlert } from '@/entities/alerts/api'
import { PROCESS_LEVEL_OPS } from './QueueThreadDetail'
import type { AlertVerb, ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Button styling — shared between AlertCard and FocusVerbsRow
// ---------------------------------------------------------------------------

export const verbButtonClass = (style: AlertVerb['style']): string => {
  const base =
    'rounded px-3 py-1 font-mono text-label border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
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

// ---------------------------------------------------------------------------
// Shared thread resolution — used by ChatPage (chip pick) and TriagePage
// (per-row "Chat →" control) so both entry points open the same thread for
// the same row instead of drifting.
// ---------------------------------------------------------------------------

/**
 * Resolve the chat thread id an action-queue row should open, creating one
 * if needed.
 *
 * Task-failure rows are backed by a daemon-derived Alert: `startThreadFromAlert`
 * dedups by arc, so a repeat click reuses the existing thread rather than
 * creating a new one. Per CLAUDE.md/ADR-0057, `'failed'` is the actual
 * condition kind the action-queue endpoint emits for a failed task; `'arc-failed'`
 * is the daemon's internal Alert-domain kind for the same condition (kept here
 * too so a row sourced directly from the Alert/Bell surface still resolves).
 * The Alert is keyed by the arc's origin id, which is the row's own `entityId`
 * for an origin task but `fixForTaskId` for a recovery/fix task's row — passing
 * `entityId` alone for a recovery-task row would look up the wrong (or a
 * nonexistent) arc and 404.
 *
 * Every other kind gets a fresh thread seeded with the row's own summary/title
 * and kind so it isn't blank and untitled; the caller's `chat-threads` query is
 * invalidated so a freshly created thread shows up in the sidebar immediately.
 */
export const resolveThreadForItem = async (
  item: ActionQueueItem,
  projectId: string | undefined,
  qc: QueryClient,
): Promise<string> => {
  if (item.kind === 'arc-failed' || item.kind === 'failed') {
    const result = await startThreadFromAlert(item.fixForTaskId ?? item.entityId)
    return result.threadId
  }
  const thread = await createChatThread({
    projectId,
    title: item.humanSummary || item.title,
    origin: item.kind,
  })
  void qc.invalidateQueries({ queryKey: ['chat-threads'] })
  return thread.id
}
