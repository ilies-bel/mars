/**
 * Memory-packet store — domain-scoped memory fragments injected into coder
 * prompts (PRD 6544c0a0, slice 1).
 *
 * Each row captures a short observation or heuristic tied to a domain key
 * (workflow kind, subsystem tag, etc.), a salience score 0–1, and an optional
 * origin arc id. Rows are soft-deleted via `retired_at` so the history is
 * preserved while listing filters them out.
 *
 * Storage: the `memory_packets` table in `.mars/mars.db` via the same
 * state-client seam as the other stores (ADR-0034).
 */

import { randomBytes } from 'node:crypto'
import { resolveStateClient } from './state-client'

export type MemoryPacket = {
  id: string
  domain: string
  text: string
  salience: number
  originArcId: string | null
  createdAt: string
  retiredAt: string | null
}

let initialised = false

export const initMemoryPackets = async (): Promise<void> => {
  if (initialised) return
  const c = resolveStateClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS memory_packets (
      id            TEXT PRIMARY KEY,
      domain        TEXT NOT NULL,
      text          TEXT NOT NULL,
      salience      REAL NOT NULL CHECK(salience BETWEEN 0 AND 1),
      origin_arc_id TEXT,
      created_at    TEXT NOT NULL,
      retired_at    TEXT
    )
  `)
  await c.execute(`
    CREATE INDEX IF NOT EXISTS idx_memory_packets_domain_salience
      ON memory_packets(domain, retired_at, salience DESC)
  `)
  initialised = true
}

/** Test-only: forget the init latch so a fresh temp DB re-runs the DDL. */
export const __resetMemoryPacketsForTests = (): void => {
  initialised = false
}

const rowToPacket = (row: Record<string, unknown>): MemoryPacket => ({
  id: row.id as string,
  domain: row.domain as string,
  text: row.text as string,
  salience: Number(row.salience),
  originArcId:
    row.origin_arc_id === null || row.origin_arc_id === undefined
      ? null
      : (row.origin_arc_id as string),
  createdAt: row.created_at as string,
  retiredAt:
    row.retired_at === null || row.retired_at === undefined
      ? null
      : (row.retired_at as string),
})

/**
 * Insert a new memory packet.
 *
 * `salience` must be in [0, 1] — enforced by the DB CHECK constraint and by
 * the caller's responsibility to pass a valid value.
 */
export const insertMemoryPacket = async (input: {
  domain: string
  text: string
  salience: number
  originArcId?: string | null
}): Promise<MemoryPacket> => {
  await initMemoryPackets()
  const c = resolveStateClient()
  const id = `mp-${randomBytes(8).toString('hex')}`
  const createdAt = new Date().toISOString()
  const originArcId = input.originArcId ?? null
  await c.execute({
    sql: `INSERT INTO memory_packets (id, domain, text, salience, origin_arc_id, created_at, retired_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    args: [id, input.domain, input.text, input.salience, originArcId, createdAt],
  })
  return {
    id,
    domain: input.domain,
    text: input.text,
    salience: input.salience,
    originArcId,
    createdAt,
    retiredAt: null,
  }
}

/**
 * List active (non-retired) memory packets for a domain, ordered by salience
 * descending then created_at descending. Optionally filter by minimum salience
 * and cap the result to `limit` rows (default 100).
 */
export const listMemoryPackets = async (opts: {
  domain: string
  minSalience?: number
  limit?: number
}): Promise<MemoryPacket[]> => {
  await initMemoryPackets()
  const c = resolveStateClient()
  const minSalience = opts.minSalience ?? 0
  const limit = opts.limit ?? 100
  const r = await c.execute({
    sql: `SELECT id, domain, text, salience, origin_arc_id, created_at, retired_at
          FROM memory_packets
          WHERE domain = ?
            AND retired_at IS NULL
            AND salience >= ?
          ORDER BY salience DESC, created_at DESC
          LIMIT ?`,
    args: [opts.domain, minSalience, limit],
  })
  return r.rows.map((row) => rowToPacket(row as unknown as Record<string, unknown>))
}

/**
 * Soft-delete a memory packet by setting its `retired_at` timestamp.
 *
 * Returns `true` when the packet was found and retired, `false` when the id
 * does not exist or was already retired.
 */
export const retireMemoryPacket = async (id: string): Promise<boolean> => {
  await initMemoryPackets()
  const c = resolveStateClient()
  const retiredAt = new Date().toISOString()
  const r = await c.execute({
    sql: `UPDATE memory_packets SET retired_at = ? WHERE id = ? AND retired_at IS NULL`,
    args: [retiredAt, id],
  })
  return (r.rowsAffected ?? 0) > 0
}
