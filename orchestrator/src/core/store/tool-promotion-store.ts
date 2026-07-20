/**
 * ToolPromotionStore — persistence layer for tool-promotion attempts.
 *
 * A promotion attempt tracks the lifecycle of a candidate helper from initial
 * proposal through benchmarking to a final verdict (promoted or retired).
 *
 * The table lives in the single consolidated Mars database. Each attempt
 * references the arc ids that motivated the candidate and carries optional
 * before/after benchmark blobs so comparisons can be replayed offline.
 *
 * Schema ownership: `tool_promotion_attempts` is created by `ensureSchema`
 * in core/lib/pg-schema.ts (migration 0002; the store shape is canonical —
 * the old queue.ts stub is gone). This module carries no DDL.
 *
 * Domain functions accept an explicit `db: DbClient` argument for easy
 * isolation in tests.
 */

import type { DbClient } from '../lib/db.js'
import { resolveStateClient } from './state-client'

/** Idempotent PostgreSQL schema bootstrap retained for command callers. */
export const initToolPromotionAttempts = async (): Promise<void> => {
  const { ensureSchema } = await import('../lib/pg-schema.js')
  await ensureSchema(resolveStateClient())
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolPromotionStatus = 'proposed' | 'benchmarked' | 'promoted' | 'retired'

export interface ToolPromotionAttempt {
  id: string
  helperKey: string
  /** Deserialized arc ids that motivated this promotion candidate. */
  motivatingArcIds: string[]
  status: ToolPromotionStatus
  /** Opaque JSON blob captured before the helper was introduced. */
  benchmarkBefore: string | null
  /** Opaque JSON blob captured after the helper was introduced. */
  benchmarkAfter: string | null
  /** Unix epoch seconds. */
  createdAt: number
  /** Unix epoch seconds; set when a final verdict is recorded. */
  decidedAt: number | null
}

export interface InsertAttemptInput {
  id: string
  helperKey: string
  motivatingArcIds: string[]
  /** Unix epoch seconds. */
  createdAt: number
}

export interface UpdateAttemptStatusPayload {
  benchmarkBefore?: string
  benchmarkAfter?: string
  /** Unix epoch seconds. */
  decidedAt?: number
}

// ── Row mapper ────────────────────────────────────────────────────────────────

const rowToAttempt = (row: Record<string, unknown>): ToolPromotionAttempt => ({
  id: row.id as string,
  helperKey: row.helper_key as string,
  motivatingArcIds: JSON.parse(row.motivating_arc_ids as string) as string[],
  status: row.status as ToolPromotionStatus,
  benchmarkBefore: (row.benchmark_before as string | null) ?? null,
  benchmarkAfter: (row.benchmark_after as string | null) ?? null,
  createdAt: row.created_at as number,
  decidedAt: (row.decided_at as number | null) ?? null,
})

// ── Domain functions ──────────────────────────────────────────────────────────

/**
 * Insert a new promotion attempt with status `'proposed'`.
 * Returns the persisted row.
 */
export const insertAttempt = async (
  db: DbClient,
  input: InsertAttemptInput,
): Promise<ToolPromotionAttempt> => {
  await db.execute({
    sql: `INSERT INTO tool_promotion_attempts
            (id, helper_key, motivating_arc_ids, status, created_at)
          VALUES (?, ?, ?, 'proposed', ?)`,
    args: [
      input.id,
      input.helperKey,
      JSON.stringify(input.motivatingArcIds),
      input.createdAt,
    ],
  })
  const result = await db.execute({
    sql: `SELECT * FROM tool_promotion_attempts WHERE id = ?`,
    args: [input.id],
  })
  return rowToAttempt(result.rows[0] as unknown as Record<string, unknown>)
}

/**
 * Return the attempt with the given id, or `null` if none exists.
 */
export const getAttempt = async (
  db: DbClient,
  id: string,
): Promise<ToolPromotionAttempt | null> => {
  const result = await db.execute({
    sql: `SELECT * FROM tool_promotion_attempts WHERE id = ?`,
    args: [id],
  })
  if (result.rows.length === 0) return null
  return rowToAttempt(result.rows[0] as unknown as Record<string, unknown>)
}

/**
 * Return all attempts with the given status, ordered by `created_at` ascending.
 */
export const listAttemptsByStatus = async (
  db: DbClient,
  status: ToolPromotionStatus,
): Promise<ToolPromotionAttempt[]> => {
  const result = await db.execute({
    sql: `SELECT * FROM tool_promotion_attempts WHERE status = ? ORDER BY created_at ASC`,
    args: [status],
  })
  return result.rows.map((row) =>
    rowToAttempt(row as unknown as Record<string, unknown>),
  )
}

/**
 * Transition an attempt to a new status and optionally record benchmark
 * payloads and a decision timestamp.
 */
export const updateAttemptStatus = async (
  db: DbClient,
  id: string,
  status: ToolPromotionStatus,
  payload: UpdateAttemptStatusPayload = {},
): Promise<void> => {
  const sets: string[] = ['status = ?']
  const args: (string | number)[] = [status]

  if (payload.benchmarkBefore !== undefined) {
    sets.push('benchmark_before = ?')
    args.push(payload.benchmarkBefore)
  }
  if (payload.benchmarkAfter !== undefined) {
    sets.push('benchmark_after = ?')
    args.push(payload.benchmarkAfter)
  }
  if (payload.decidedAt !== undefined) {
    sets.push('decided_at = ?')
    args.push(payload.decidedAt)
  }

  args.push(id)

  await db.execute({
    sql: `UPDATE tool_promotion_attempts SET ${sets.join(', ')} WHERE id = ?`,
    args,
  })
}
