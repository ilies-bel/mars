/**
 * relevance-store — round-trip persistence tests.
 *
 * Covered acceptance criteria:
 *   1. `scoreAndPersistAllClosed` reads a closed thread, scores it, and
 *      persists the expected `relevance_score` and `relevance_scored_at`.
 *   2. Open (non-closed) threads are NOT scored.
 *   3. Archived threads are NOT scored.
 *   4. `scoreAndPersistAllClosed` with task_ref segments produces a higher
 *      score than the same thread without them (taskCount signal).
 *   5. Re-running `scoreAndPersistAllClosed` overwrites the previous score
 *      (idempotent overwrite, not accumulate).
 *
 * System boundary: real PGlite DB (openDb) with the full canonical schema.
 * No mocks — all writes exercise the actual SQL paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDb, type DbClient } from '../lib/db.js'
import { scoreSubjectRelevance } from './relevance-scorer.js'
import {
  persistRelevanceScore,
  readSubjectScoringInputs,
  scoreAndPersistAllClosed,
} from './relevance-store.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

interface SubjectOpts {
  closedAt?: number | null
  archivedAt?: number | null
  origin?: string | null
  alertResolved?: number
}

/**
 * Insert a minimal Subject row. Returns the thread id.
 * `closedAt` defaults to null (open thread) unless supplied.
 */
async function insertSubject(client: DbClient, opts: SubjectOpts = {}): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO chat_threads
            (id, title, status, created_at, updated_at, closed_at, archived_at,
             origin, alert_resolved)
          VALUES (?, 'Test Subject', 'idle', ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      now,
      now,
      opts.closedAt ?? null,
      opts.archivedAt ?? null,
      opts.origin ?? null,
      opts.alertResolved ?? 0,
    ],
  })
  return id
}

/**
 * Insert a message with segments into a thread. `segments` is stored as JSON.
 */
async function insertMessage(
  client: DbClient,
  threadId: string,
  segments: unknown[],
): Promise<void> {
  const now = Date.now()
  await client.execute({
    sql: `INSERT INTO chat_messages
            (id, thread_id, role, content, segments, created_at)
          VALUES (?, ?, 'assistant', '', ?, ?)`,
    args: [randomUUID(), threadId, JSON.stringify(segments), now],
  })
}

/** Read the persisted relevance score and timestamp for a thread. */
async function getStoredScore(
  client: DbClient,
  threadId: string,
): Promise<{ score: number | null; scoredAt: number | null }> {
  const r = await client.execute({
    sql: `SELECT relevance_score, relevance_scored_at FROM chat_threads WHERE id = ?`,
    args: [threadId],
  })
  if (r.rows.length === 0) return { score: null, scoredAt: null }
  const row = r.rows[0] as Record<string, unknown>
  return {
    score: row.relevance_score == null ? null : Number(row.relevance_score),
    scoredAt: row.relevance_scored_at == null ? null : Number(row.relevance_scored_at),
  }
}

// ── Suite setup ───────────────────────────────────────────────────────────────

describe('relevance-store', () => {
  let client: DbClient

  beforeEach(async () => {
    client = openDb(`pglite://relevance-store-test-${randomUUID()}`)
    // Trigger schema bootstrap.
    await client.execute('SELECT 1')
  })

  afterEach(async () => {
    await client.close()
  })

  // ── Round-trip ────────────────────────────────────────────────────────────

  it('persists the expected relevance_score for a closed thread (round-trip)', async () => {
    const closedAtMs = Date.now() - 2 * 86_400_000 // 2 days ago
    const nowMs = Date.now()

    const threadId = await insertSubject(client, { closedAt: closedAtMs })

    const count = await scoreAndPersistAllClosed(client, nowMs)
    expect(count).toBe(1)

    const { score, scoredAt } = await getStoredScore(client, threadId)

    const expectedScore = scoreSubjectRelevance({
      closedAtMs,
      nowMs,
      taskCount: 0,
      resolvedAlert: false,
      producedTokens: 0,
    })

    expect(score).not.toBeNull()
    // REAL (4-byte float) stores ~7 significant digits; toBeCloseTo(n, 5)
    // (threshold 5e-6) accommodates the precision loss while remaining meaningful.
    expect(score!).toBeCloseTo(expectedScore, 5)
    expect(scoredAt).toBe(nowMs)
  })

  // ── Open threads are excluded ─────────────────────────────────────────────

  it('does not score open (non-closed) threads', async () => {
    const openId = await insertSubject(client) // closed_at = NULL
    const closedId = await insertSubject(client, { closedAt: Date.now() - 86_400_000 })

    const count = await scoreAndPersistAllClosed(client, Date.now())
    expect(count).toBe(1)

    const openScore = await getStoredScore(client, openId)
    expect(openScore.score).toBeNull()

    const closedScore = await getStoredScore(client, closedId)
    expect(closedScore.score).not.toBeNull()
  })

  // ── Archived threads are excluded ─────────────────────────────────────────

  it('does not score archived threads', async () => {
    const now = Date.now()
    const archivedId = await insertSubject(client, {
      closedAt: now - 86_400_000,
      archivedAt: now - 1000,
    })

    const count = await scoreAndPersistAllClosed(client, now)
    expect(count).toBe(0)

    const stored = await getStoredScore(client, archivedId)
    expect(stored.score).toBeNull()
  })

  // ── task_ref segments raise the score ─────────────────────────────────────

  it('produces a higher score for a thread with task_ref segments', async () => {
    const closedAtMs = Date.now() - 7 * 86_400_000 // 1 week ago
    const nowMs = Date.now()

    const noTasksId = await insertSubject(client, { closedAt: closedAtMs })
    const withTasksId = await insertSubject(client, { closedAt: closedAtMs })

    // Insert 5 task_ref segments into the second thread only.
    const taskSegments = Array.from({ length: 5 }, (_, i) => ({
      type: 'task_ref',
      taskId: `task-${i}`,
    }))
    await insertMessage(client, withTasksId, taskSegments)

    await scoreAndPersistAllClosed(client, nowMs)

    const noTasksScore = await getStoredScore(client, noTasksId)
    const withTasksScore = await getStoredScore(client, withTasksId)

    expect(withTasksScore.score!).toBeGreaterThan(noTasksScore.score!)
  })

  // ── Idempotent overwrite ───────────────────────────────────────────────────

  it('overwrites the previous score on a second call', async () => {
    const closedAtMs = Date.now() - 86_400_000
    const threadId = await insertSubject(client, { closedAt: closedAtMs })

    const nowMs1 = Date.now()
    await scoreAndPersistAllClosed(client, nowMs1)
    const first = await getStoredScore(client, threadId)

    const nowMs2 = nowMs1 + 3 * 86_400_000 // 3 days later
    await scoreAndPersistAllClosed(client, nowMs2)
    const second = await getStoredScore(client, threadId)

    // Score should be lower on the second pass (Subject is older).
    expect(second.score!).toBeLessThan(first.score!)
    expect(second.scoredAt).toBe(nowMs2)
  })

  // ── persistRelevanceScore directly ────────────────────────────────────────

  it('persistRelevanceScore writes exactly the supplied values', async () => {
    const threadId = await insertSubject(client, { closedAt: Date.now() })
    const score = 0.42
    const ts = 1_700_000_000_000

    await persistRelevanceScore(client, threadId, score, ts)

    const stored = await getStoredScore(client, threadId)
    expect(stored.score).toBeCloseTo(score, 10)
    expect(stored.scoredAt).toBe(ts)
  })

  // ── readSubjectScoringInputs ───────────────────────────────────────────────

  it('readSubjectScoringInputs returns one entry per closed non-archived thread', async () => {
    const closedAtMs = Date.now() - 86_400_000
    const closedId = await insertSubject(client, { closedAt: closedAtMs })
    await insertSubject(client) // open — excluded
    await insertSubject(client, { closedAt: closedAtMs, archivedAt: Date.now() }) // archived — excluded

    const inputs = await readSubjectScoringInputs(client)
    // Only the one closed non-archived thread (plus possibly the main sentinel — but
    // the sentinel is never closed, so it will not appear).
    const ids = inputs.map((i) => i.threadId)
    expect(ids).toContain(closedId)
    // Verify the closed-at timestamp is preserved correctly.
    const entry = inputs.find((i) => i.threadId === closedId)!
    expect(entry.closedAtMs).toBe(closedAtMs)
    expect(entry.taskCount).toBe(0)
    expect(entry.resolvedAlert).toBe(false)
    expect(entry.producedTokens).toBe(0)
  })
})
