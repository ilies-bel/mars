/**
 * Template-authored Notices. A Notice is rendered deterministically and handed
 * to the durable conversation delivery path; it is not a Bell projection.
 *
 * Also contains DB-backed helpers for the health-pass notice route:
 * silenceFinding / unsilenceFinding write to health_silences; these are the
 * persistence layer behind `mars notice silence <finding-key>`.
 */

import { resolveStateClient } from '../store/state-client'
import type { ActionQueueKind } from './action-queue-kinds'
import {
  getRecipePreloadedResponses,
  humanSummary,
  lookupRecipe,
} from './action-queue-recipes'
import { postConversationNotice, type ConversationPriority } from './conversation-delivery'

const stateClient = resolveStateClient

// ── Types ────────────────────────────────────────────────────────────────────

export interface Notice {
  id: string
  kind: ActionQueueKind
  payload: Record<string, unknown>
  body: string
  source: string | null
  createdAt: string
}

// ── Health-notice silence helpers ────────────────────────────────────────────

/**
 * Permanently silence a health finding by its findingKey.
 *
 * Writes a row to health_silences. Idempotent: a second call for the same key
 * is a no-op (ON CONFLICT DO NOTHING). The CLI `mars notice silence` calls
 * this; the scheduled health pass reads the same table via isSilenced().
 */
export const silenceFinding = async (findingKey: string): Promise<void> => {
  const client = stateClient()
  await client.batch([
    {
      sql: `INSERT INTO health_silences (finding_key, silenced_at)
            VALUES (?, ?) ON CONFLICT (finding_key) DO NOTHING`,
      args: [findingKey, new Date().toISOString()],
    },
  ])
}

/**
 * Remove a permanent silence for a health finding.
 *
 * Deletes the row from health_silences if present. No-op when absent. The CLI
 * `mars notice unsilence` calls this so future passes can re-file the notice.
 */
export const unsilenceFinding = async (findingKey: string): Promise<void> => {
  const client = stateClient()
  await client.batch([
    {
      sql: `DELETE FROM health_silences WHERE finding_key = ?`,
      args: [findingKey],
    },
  ])
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render and post a Notice to the conversation without invoking a provider.
 */
export const createNotice = async (
  kind: ActionQueueKind,
  payload: Record<string, unknown>,
  source: string,
  priority: ConversationPriority = 'routine',
): Promise<Notice> => {
  const body = humanSummary(kind, payload)
  const entityId = String(payload['entityId'] ?? payload['taskId'] ?? payload['proposalId'] ?? kind)
  const context = payload['context']
  const responses = getRecipePreloadedResponses(lookupRecipe(kind), {
    kind,
    entityId,
    payload,
    context: typeof context === 'object' && context !== null && !Array.isArray(context)
      ? context as Record<string, unknown>
      : {},
    title: typeof payload['title'] === 'string' ? payload['title'] : '',
    body: typeof payload['body'] === 'string' ? payload['body'] : '',
    raisedAt: typeof payload['raisedAt'] === 'string' ? payload['raisedAt'] : '',
  })
  const delivery = await postConversationNotice({
    body,
    priority,
    segments: [
      { type: 'text', text: body },
      ...(responses.length > 0 ? [{ type: 'preloaded_responses', responses }] : []),
    ],
    backingEntityId: entityId,
  })
  return {
    id: delivery.id,
    kind,
    payload,
    body,
    source,
    createdAt: new Date().toISOString(),
  }
}
