/**
 * eviction-sweep — unit tests.
 *
 * Covered acceptance criteria:
 *   1. A closed Subject with old `closed_at` (low relevance score) is archived
 *      after `runEvictionSweep`.
 *   2. A closed Subject with recent `closed_at` and high relevance score is NOT
 *      archived after `runEvictionSweep`.
 *
 * System boundary: real PGlite DB (openDb) with the full canonical schema.
 * No mocks — all writes exercise the actual SQL paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb, type DbClient } from '../lib/db.js'
import { runEvictionSweep } from './eviction-sweep.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

interface SubjectOpts {
  closedAt?: number | null
  archivedAt?: number | null
}

/** Insert a minimal closed Subject row. Returns the thread id. */
async function insertSubject(client: DbClient, opts: SubjectOpts = {}): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO chat_threads
            (id, title, status, created_at, updated_at, closed_at, archived_at)
          VALUES (?, 'Test Subject', 'idle', ?, ?, ?, ?)`,
    args: [id, now, now, opts.closedAt ?? null, opts.archivedAt ?? null],
  })
  return id
}

/** Read the archived_at timestamp for a Subject, or null when not archived. */
async function getArchivedAt(client: DbClient, threadId: string): Promise<number | null> {
  const r = await client.execute({
    sql: `SELECT archived_at FROM chat_threads WHERE id = ?`,
    args: [threadId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as Record<string, unknown>
  return row.archived_at == null ? null : Number(row.archived_at)
}

// ── Suite setup ───────────────────────────────────────────────────────────────

describe('eviction-sweep', () => {
  let client: DbClient

  beforeEach(async () => {
    client = openDb(`pglite://eviction-sweep-test-${randomUUID()}`)
    // Trigger schema bootstrap.
    await client.execute('SELECT 1')
  })

  afterEach(async () => {
    await client.close()
  })

  // ── Stale Subject is evicted ───────────────────────────────────────────────

  it('archives a closed Subject whose relevance score decayed below threshold', async () => {
    // Closed 90 days ago — age-decay produces a score near 0 (well below 0.1).
    const closedAt = Date.now() - 90 * 86_400_000
    const nowMs = Date.now()

    const id = await insertSubject(client, { closedAt })

    const { scored, evicted } = await runEvictionSweep(client, { nowMs, threshold: 0.1 })

    expect(scored).toBeGreaterThanOrEqual(1)
    expect(evicted).toBeGreaterThanOrEqual(1)

    const archivedAt = await getArchivedAt(client, id)
    expect(archivedAt).not.toBeNull()
  })

  // ── Recent high-score Subject is retained ─────────────────────────────────

  it('does not archive a closed Subject with a recent closed_at and high score', async () => {
    // Closed 1 hour ago — ageDecay ≈ exp(−(1/24)/14) ≈ 0.997; score well above 0.1.
    const closedAt = Date.now() - 60 * 60 * 1000
    const nowMs = Date.now()

    const id = await insertSubject(client, { closedAt })

    const { evicted } = await runEvictionSweep(client, { nowMs, threshold: 0.1 })

    expect(evicted).toBe(0)

    const archivedAt = await getArchivedAt(client, id)
    expect(archivedAt).toBeNull()
  })

  // ── Return shape ──────────────────────────────────────────────────────────

  it('returns { scored, evicted } counts for observability', async () => {
    // One stale, one recent.
    const staleClosedAt = Date.now() - 90 * 86_400_000
    const recentClosedAt = Date.now() - 3_600_000
    const nowMs = Date.now()

    await insertSubject(client, { closedAt: staleClosedAt })
    await insertSubject(client, { closedAt: recentClosedAt })

    const result = await runEvictionSweep(client, { nowMs, threshold: 0.1 })

    expect(result.scored).toBe(2)
    expect(result.evicted).toBe(1)
  })
})
