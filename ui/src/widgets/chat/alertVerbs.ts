/**
 * Shared helpers for alert verb buttons — used by both AlertCard and FocusVerbsRow
 * so the two entry points share one dispatch implementation.
 */

import type { QueryClient } from '@tanstack/react-query'
import { invokeAction, startThreadForQueueItem } from '@/shared/api'
import { startThreadFromAlert } from '@/entities/alerts/api'
import { buildQueueItemSeed } from './queueItemSeed'
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
 * For `'arc-failed'` rows (from the Bell/Alert surface) the Alert aggregate
 * exists and is keyed by the arc id, so `startThreadFromAlert` deduplicates by
 * arc: a repeat click reuses the existing thread rather than creating a new one.
 *
 * For `'failed'` rows (from the action-queue surface) an Alert may or may not
 * exist. A `failed` row whose arc still has `done` or `blocked` siblings has NO
 * Alert (the arc is not wholly terminal), so `startThreadFromAlert` returns 404.
 * In that case — and whenever the arc id cannot be resolved from the row payload
 * — we fall through to `startThreadForQueueItem`, which deduplicates on the row
 * id and seeds the thread with a proactive opener stating the problem and the
 * available moves. Non-404 errors (e.g. 500) propagate so the caller can surface
 * them.
 *
 * Every other kind goes through `startThreadForQueueItem` directly. It previously
 * called the generic `createChatThread`, which knew nothing about the row: each
 * click minted a NEW thread for the same alert, and that thread opened empty —
 * so the operator landed in a blank conversation about a problem it never
 * stated, and clicking twice left two of them.
 *
 * The caller's `chat-threads` query is invalidated so a freshly created thread
 * shows up in the sidebar immediately.
 */
export const resolveThreadForItem = async (
  item: ActionQueueItem,
  projectId: string | undefined,
  qc: QueryClient,
): Promise<string> => {
  if (item.kind === 'arc-failed' || item.kind === 'failed') {
    try {
      const result = await startThreadFromAlert(item.fixForTaskId ?? item.entityId)
      return result.threadId
    } catch (err) {
      // No Alert exists for this arc (e.g. the arc is not wholly terminal — some
      // sibling tasks are still done/blocked) — fall through to the generic
      // per-row path. Re-throw anything that is not a plain 404.
      if (!(err instanceof Error && /→ 404/.test(err.message))) throw err
    }
  }
  const thread = await startThreadForQueueItem(
    item.id,
    item.humanSummary || item.title,
    buildQueueItemSeed(item),
    projectId,
  )
  void qc.invalidateQueries({ queryKey: ['chat-threads'] })
  return thread.id
}
