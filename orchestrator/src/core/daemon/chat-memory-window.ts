import type { DbClient } from '../lib/db.js'
import { resolveStateClient } from '../store/state-client.js'
import type { ConversationMemoryFacts } from '../workers/providers.js'

export type MemoryCutReason = 'capacity' | 'retention-lapse'

export interface MainMemoryWindow {
  startsAfterSeq: number
  lastUsedAt: number | null
  cutAt: number | null
  reason: MemoryCutReason | null
}

export interface MemoryCut {
  startsAfterSeq: number
  reason: MemoryCutReason
}

const mainSessionKey = 'main'

const clientFor = (client: DbClient | undefined): DbClient => client ?? resolveStateClient()

/** Read the durable boundary for the reusable Main-session prefix. */
export const readMainMemoryWindow = async (client?: DbClient): Promise<MainMemoryWindow> => {
  const db = clientFor(client)
  await db.execute({
    sql: `INSERT INTO chat_memory_windows (session_key, starts_after_seq)
          VALUES (?, 0) ON CONFLICT (session_key) DO NOTHING`,
    args: [mainSessionKey],
  })
  const result = await db.execute({
    sql: `SELECT starts_after_seq, last_used_at, cut_at, reason
            FROM chat_memory_windows WHERE session_key = ?`,
    args: [mainSessionKey],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) throw new Error('Main memory window was not created')
  return {
    startsAfterSeq: Number(row.starts_after_seq),
    lastUsedAt: typeof row.last_used_at === 'number' ? row.last_used_at : null,
    cutAt: typeof row.cut_at === 'number' ? row.cut_at : null,
    reason: row.reason === 'capacity' || row.reason === 'retention-lapse' ? row.reason : null,
  }
}

/**
 * Select, without changing state, the next safe Main-session boundary.
 * A window is only cut on capacity pressure or immediately before the first
 * post-retention request; merely becoming idle has no observable effect.
 */
export const selectMemoryCut = async (
  client: DbClient | undefined,
  memory: ConversationMemoryFacts,
  now = Date.now(),
): Promise<MemoryCut | null> => {
  const db = clientFor(client)
  const window = await readMainMemoryWindow(db)
  const prefix = await db.execute({
    sql: `SELECT seq, content FROM chat_messages
            WHERE (context_scope = 'main' OR kind = 'situation')
              AND seq > ?
            ORDER BY seq ASC`,
    args: [window.startsAfterSeq],
  })
  const messages = prefix.rows.map((row) => ({
    seq: Number(row.seq),
    tokens: Math.ceil(String(row.content).length / 4),
  }))
  const prefixTokens = messages.reduce((total, message) => total + message.tokens, 0)
  const retentionLapsed = window.lastUsedAt !== null && now - window.lastUsedAt >= memory.retentionMs
  if (prefixTokens <= memory.contextWindowTokens && !retentionLapsed) return null

  const active = await db.execute(`SELECT MIN(m.seq) AS first_seq
    FROM chat_threads t
    JOIN chat_messages m ON m.thread_id = t.id
   WHERE t.closed_at IS NULL`)
  const firstActiveSeq = typeof active.rows[0]?.first_seq === 'number'
    ? active.rows[0].first_seq
    : null

  const closed = await db.execute({
    sql: `SELECT MIN(m.seq) AS first_seq, MAX(m.seq) AS last_seq
            FROM chat_threads t
            JOIN chat_messages m ON m.thread_id = t.id
           WHERE t.closed_at IS NOT NULL
           GROUP BY t.id
          HAVING MAX(m.seq) > ?
           ORDER BY MIN(m.seq) ASC, t.id ASC`,
    args: [window.startsAfterSeq],
  })
  const candidates = closed.rows
    .map((row) => ({ lastSeq: Number(row.last_seq) }))
    .filter((candidate) => firstActiveSeq === null || candidate.lastSeq < firstActiveSeq)

  if (prefixTokens > memory.contextWindowTokens) {
    for (const candidate of candidates) {
      const remaining = messages
        .filter((message) => message.seq > candidate.lastSeq)
        .reduce((total, message) => total + message.tokens, 0)
      if (remaining <= memory.contextWindowTokens) {
        return { startsAfterSeq: candidate.lastSeq, reason: 'capacity' }
      }
    }
    return null
  }

  const oldestFinished = candidates[0]
  return oldestFinished
    ? { startsAfterSeq: oldestFinished.lastSeq, reason: 'retention-lapse' }
    : null
}

/** Persist a selected Main-session cut. It has no provider side effect. */
export const advanceMainMemoryWindow = async (
  client: DbClient | undefined,
  cut: MemoryCut,
  now = Date.now(),
): Promise<void> => {
  const db = clientFor(client)
  await readMainMemoryWindow(db)
  await db.execute({
    sql: `UPDATE chat_memory_windows
            SET starts_after_seq = ?, cut_at = ?, reason = ?
          WHERE session_key = ? AND starts_after_seq < ?`,
    args: [cut.startsAfterSeq, now, cut.reason, mainSessionKey, cut.startsAfterSeq],
  })
}

/** Record a sent provider request; selection and idle time never touch this. */
export const markMainMemoryWindowUsed = async (
  client: DbClient | undefined,
  now = Date.now(),
): Promise<void> => {
  const db = clientFor(client)
  await readMainMemoryWindow(db)
  await db.execute({
    sql: `UPDATE chat_memory_windows SET last_used_at = ? WHERE session_key = ?`,
    args: [now, mainSessionKey],
  })
}
