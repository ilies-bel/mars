/**
 * Notice persistence layer — the `notices` table in the Mars database.
 *
 * A Notice (ADR-0079) is an entity-less informational bell message: unlike an
 * Alert, which derives from arc state and clears when its backing entity
 * resolves, a Notice has no backing entity, so it clears only when the operator
 * acknowledges it.
 *
 * Schema ownership: the `notices` table (and its index) is created by
 * `ensureSchema` in core/lib/pg-schema.ts — this module carries no DDL. The
 * `resolveStateClient` function (not its result) is stored so the DB client is
 * resolved lazily and tests can reset it via `vi.resetModules()`.
 */

import { randomUUID } from 'node:crypto'
import { resolveStateClient } from '../store/state-client'
import type { ActionQueueKind } from './action-queue'
import {
  getRecipePreloadedResponses,
  lookupRecipe,
  type PreloadedResponse,
} from './action-queue-recipes'

const stateClient = resolveStateClient

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initNoticeStore = async (): Promise<void> => {
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(stateClient())
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface NoticeRow {
  id: string
  kind: ActionQueueKind
  payload: Record<string, unknown>
  body: string
  source: string | null
  failureSignature: string | null
  count: number
  createdAt: string
  updatedAt: string
  acknowledgedAt: string | null
  preloadedResponses: Array<PreloadedResponse & { entityId: string }>
}

/** Public Notice view retained for the Bell and HTTP surfaces. */
export type Notice = NoticeRow

/** Snake_case shape as stored in the `notices` table. */
interface StoredNoticeRow {
  id: string
  kind: ActionQueueKind
  payload: string
  body: string
  source: string | null
  failure_signature: string | null
  count: number
  created_at: string
  updated_at: string
  acknowledged_at: string | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const now = (): string => new Date().toISOString()

/** Resolve the recipe's compact response chips for a Notice's daemon action. */
const preloadedResponsesFor = (
  kind: ActionQueueKind,
  payload: Record<string, unknown>,
): Array<PreloadedResponse & { entityId: string }> => {
  const entityId =
    (typeof payload['entityId'] === 'string' && payload['entityId']) ||
    (typeof payload['taskId'] === 'string' && payload['taskId']) ||
    (typeof payload['proposalId'] === 'string' && payload['proposalId']) ||
    kind
  return getRecipePreloadedResponses(lookupRecipe(kind), {
    kind,
    entityId,
    payload,
    context: {},
    title: typeof payload['title'] === 'string' ? payload['title'] : '',
    body: typeof payload['body'] === 'string' ? payload['body'] : '',
    raisedAt: typeof payload['raisedAt'] === 'string' ? payload['raisedAt'] : '',
  }).map((response) => ({ ...response, entityId }))
}

/**
 * Reuse the same id scheme the action queue uses (`randomUUID().slice(0, 8)`)
 * so Notice ids read the same length as action-queue ids in the operator's
 * bell surface.
 */
const generateNoticeId = (): string => randomUUID().slice(0, 8)

const rowToNotice = (row: Record<string, unknown>): Notice => {
  const r = row as unknown as StoredNoticeRow
  let payload: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(r.payload)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>
    }
  } catch {
    // A malformed legacy row should remain visible in the Bell; its recipe sees
    // an empty payload rather than making the entire notice projection fail.
  }
  return {
    id: r.id,
    kind: r.kind,
    payload,
    body: r.body,
    source: r.source ?? null,
    failureSignature: r.failure_signature ?? null,
    count: r.count ?? 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    acknowledgedAt: r.acknowledged_at ?? null,
    preloadedResponses: preloadedResponsesFor(r.kind, payload),
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Mint a Notice and mirror its recipe-rendered copy into the most recently
 * active chat feed. Both surfaces receive the same deterministic text; no LLM
 * work is involved in this path.
 */
export const createNotice = async (
  kind: ActionQueueKind,
  payload: Record<string, unknown>,
  source: string,
): Promise<Notice> => {
  const c = stateClient()
  const id = generateNoticeId()
  const ts = now()
  const failureSignature =
    (typeof payload['failureSignature'] === 'string' && payload['failureSignature']) ||
    (typeof payload['signature'] === 'string' && payload['signature']) ||
    null
  const notice: Notice = {
    id,
    kind,
    payload,
    body: '',
    source,
    failureSignature,
    count: 1,
    createdAt: ts,
    updatedAt: ts,
    acknowledgedAt: null,
    preloadedResponses: preloadedResponsesFor(kind, payload),
  }
  const { noticeToChatMessage, upsertNoticeChatMessage } = await import('./chat-store.js')
  const message = noticeToChatMessage(notice)
  notice.body = message.body
  const result = await c.execute({
    sql: `INSERT INTO notices
            (id, kind, payload, body, source, failure_signature, count, created_at, updated_at, acknowledged_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, now(), NULL)
          ON CONFLICT (failure_signature) WHERE acknowledged_at IS NULL
          DO UPDATE SET count = notices.count + 1, updated_at = now()
          RETURNING *`,
    args: [id, kind, JSON.stringify(payload), message.body, source, failureSignature, ts],
  })
  const saved = rowToNotice(result.rows[0] as Record<string, unknown>)
  const updatedMessage = noticeToChatMessage(saved)
  saved.body = updatedMessage.body
  await c.execute({
    sql: `UPDATE notices SET body = ? WHERE id = ?`,
    args: [saved.body, saved.id],
  })
  await upsertNoticeChatMessage(saved.id, saved.body)
  return saved
}

/** List every open (unacknowledged) Notice, newest-first. */
export const listOpenNotices = async (): Promise<Notice[]> => {
  const c = stateClient()
  const result = await c.execute(
    `SELECT * FROM notices
      WHERE acknowledged_at IS NULL
      ORDER BY created_at DESC, id DESC`,
  )
  return (result.rows as unknown as Record<string, unknown>[]).map(rowToNotice)
}

/**
 * Acknowledge a Notice, removing it from the open list. Idempotent — returns
 * `false` when the notice does not exist or was already acknowledged.
 */
export const ackNotice = async (id: string): Promise<boolean> => {
  const c = stateClient()
  const result = await c.execute({
    sql: `UPDATE notices SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`,
    args: [now(), id],
  })
  return ((result as unknown as { rowsAffected?: number }).rowsAffected ?? 0) > 0
}
