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

const stateClient = resolveStateClient

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initNoticeStore = async (): Promise<void> => {
  const { ensureSchema } = await import('./pg-schema.js')
  await ensureSchema(stateClient())
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Notice {
  id: string
  body: string
  source: string | null
  createdAt: string
  acknowledgedAt: string | null
}

/** Snake_case shape as stored in the `notices` table. */
interface NoticeRow {
  id: string
  body: string
  source: string | null
  created_at: string
  acknowledged_at: string | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const now = (): string => new Date().toISOString()

/**
 * Reuse the same id scheme the action queue uses (`randomUUID().slice(0, 8)`)
 * so Notice ids read the same length as action-queue ids in the operator's
 * bell surface.
 */
const generateNoticeId = (): string => randomUUID().slice(0, 8)

const rowToNotice = (row: Record<string, unknown>): Notice => {
  const r = row as unknown as NoticeRow
  return {
    id: r.id,
    body: r.body,
    source: r.source ?? null,
    createdAt: r.created_at,
    acknowledgedAt: r.acknowledged_at ?? null,
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Create a new Notice. Returns the stored row. */
export const createNotice = async (body: string, source: string): Promise<Notice> => {
  const c = stateClient()
  const id = generateNoticeId()
  const ts = now()
  await c.execute({
    sql: `INSERT INTO notices (id, body, source, created_at, acknowledged_at)
          VALUES (?, ?, ?, ?, NULL)`,
    args: [id, body, source, ts],
  })
  return {
    id,
    body,
    source,
    createdAt: ts,
    acknowledgedAt: null,
  }
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
