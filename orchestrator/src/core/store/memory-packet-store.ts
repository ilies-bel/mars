/**
 * Memory-packet store — domain-scoped memory fragments injected into coder
 * prompts (PRD 6544c0a0, slice 1).
 *
 * Each row captures a short observation or heuristic tied to a domain key
 * (workflow kind, subsystem tag, etc.), a salience score 0–1, and an optional
 * origin arc id. Rows are soft-deleted via `retired_at` so the history is
 * preserved while listing filters them out.
 *
 * Storage: the `memory_packets` table via the same state-client seam as the
 * other stores (ADR-0034). Schema ownership: `ensureSchema` in
 * core/lib/pg-schema.ts (migration 0002) — this module carries no DDL.
 */

import { randomBytes } from 'node:crypto'
import { resolveStateClient } from './state-client'
import type { Task } from '../queue'

/** Idempotent PostgreSQL schema bootstrap retained for existing callers. */
export const initMemoryPackets = async (): Promise<void> => {
  const { ensureSchema } = await import('../lib/pg-schema.js')
  await ensureSchema(resolveStateClient())
}

/** The store has no additional cache; retained as a test seam. */
export const __resetMemoryPacketsForTests = (): void => {}

export type MemoryPacket = {
  id: string
  domain: string
  text: string
  salience: number
  originArcId: string | null
  createdAt: string
  retiredAt: string | null
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
  const c = resolveStateClient()
  const retiredAt = new Date().toISOString()
  const r = await c.execute({
    sql: `UPDATE memory_packets SET retired_at = ? WHERE id = ? AND retired_at IS NULL`,
    args: [retiredAt, id],
  })
  return (r.rowsAffected ?? 0) > 0
}

/**
 * Extract candidate domain strings for a task: the workflow name followed by
 * all tags. Null workflow and empty strings are filtered out.
 */
export const resolveTaskDomains = (task: Pick<Task, 'workflow' | 'tags'>): string[] =>
  [task.workflow, ...task.tags].filter(
    (d): d is string => typeof d === 'string' && d.length > 0,
  )

/**
 * Fetch lesson texts for a set of candidate domains, applying salience
 * filtering, deduplication by packet id, and a top-N cap.
 *
 * Controlled by env vars:
 *   MARS_MEMORY_TOPK      — maximum number of lessons returned (default 6)
 *   MARS_MEMORY_SALIENCE  — minimum salience threshold (default 0.7)
 */
export const fetchLessonsForTask = async (domains: string[]): Promise<string[]> => {
  if (domains.length === 0) return []
  const limit = Number(process.env.MARS_MEMORY_TOPK ?? 6)
  const minSalience = Number(process.env.MARS_MEMORY_SALIENCE ?? 0.7)

  const seen = new Set<string>()
  const packets: MemoryPacket[] = []

  for (const domain of domains) {
    const results = await listMemoryPackets({ domain, minSalience, limit })
    for (const packet of results) {
      if (!seen.has(packet.id)) {
        seen.add(packet.id)
        packets.push(packet)
      }
    }
  }

  // Sort collected packets by salience desc, then created_at desc, and cap.
  packets.sort(
    (a, b) =>
      b.salience - a.salience || b.createdAt.localeCompare(a.createdAt),
  )
  return packets.slice(0, limit).map((p) => p.text)
}
