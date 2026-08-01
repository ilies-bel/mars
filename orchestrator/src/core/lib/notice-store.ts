/**
 * Template-authored Notices. A Notice is rendered deterministically and handed
 * to the durable conversation delivery path; it is not a Bell projection.
 */

import { resolveStateClient } from '../store/state-client'
import type { ActionQueueKind } from './action-queue'
import {
  humanSummary,
} from './action-queue-recipes'
import { postConversationNotice, type ConversationPriority } from './conversation-delivery'

const stateClient = resolveStateClient

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initNoticeStore = async (): Promise<void> => {
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(stateClient())
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Notice {
  id: string
  kind: ActionQueueKind
  payload: Record<string, unknown>
  body: string
  source: string | null
  createdAt: string
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
  const delivery = await postConversationNotice({ body, priority })
  return {
    id: delivery.id,
    kind,
    payload,
    body,
    source,
    createdAt: new Date().toISOString(),
  }
}
