/**
 * Persistence layer for Subject relevance scores.
 *
 * Reads scoring inputs from the database, calls the pure scorer, and persists
 * the results back to `chat_threads`. Other slices consume the stored scores
 * without knowing how they were computed.
 *
 * Schema: `chat_threads.relevance_score REAL` and
 * `chat_threads.relevance_scored_at BIGINT` — both default NULL and populated
 * by `scoreAndPersistAllClosed`.
 */

import type { DbClient } from '../lib/db.js'
import { scoreSubjectRelevance, type SubjectRelevanceInput } from './relevance-scorer.js'

/**
 * Read scoring inputs for every closed, non-archived Subject.
 *
 * Scans `chat_messages.segments` for `task_ref` entries (to count tasks
 * queued) and `result` entries (to sum produced tokens), mirroring the
 * approach used by `readClosedSubjectFacts` and `listSubjectBoundaries`.
 *
 * `nowMs` in each returned element is set to `Date.now()` at the time this
 * function runs; callers that want a consistent timestamp across all inputs
 * should override it when calling `scoreSubjectRelevance`.
 */
export async function readSubjectScoringInputs(
  client: DbClient,
): Promise<Array<{ threadId: string } & SubjectRelevanceInput>> {
  const nowMs = Date.now()

  const threadsResult = await client.execute({
    sql: `SELECT id, closed_at, origin, alert_resolved
            FROM chat_threads
           WHERE closed_at IS NOT NULL
             AND archived_at IS NULL`,
    args: [],
  })

  if (threadsResult.rows.length === 0) return []

  // Build a map keyed by thread id to accumulate per-thread counters.
  const threadMap = new Map<
    string,
    { closedAtMs: number; resolvedAlert: boolean; taskCount: number; producedTokens: number }
  >()

  for (const r of threadsResult.rows as unknown as Array<{
    id: string
    closed_at: number
    origin: string | null
    alert_resolved: number
  }>) {
    threadMap.set(r.id, {
      closedAtMs: Number(r.closed_at),
      resolvedAlert: r.origin === 'alert' && Boolean(Number(r.alert_resolved ?? 0)),
      taskCount: 0,
      producedTokens: 0,
    })
  }

  // One round-trip for all messages belonging to eligible threads. JOIN
  // avoids a dynamic IN clause.
  const msgsResult = await client.execute({
    sql: `SELECT m.thread_id, m.segments
            FROM chat_messages m
            JOIN chat_threads t ON t.id = m.thread_id
           WHERE t.closed_at IS NOT NULL
             AND t.archived_at IS NULL`,
    args: [],
  })

  for (const r of msgsResult.rows as unknown as Array<{
    thread_id: string
    segments: string | null
  }>) {
    const entry = threadMap.get(r.thread_id)
    if (entry === undefined) continue
    if (typeof r.segments !== 'string') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(r.segments)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue

    for (const segment of parsed) {
      if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) continue
      const seg = segment as Record<string, unknown>
      if (seg.type === 'task_ref' && typeof seg.taskId === 'string') {
        entry.taskCount++
      }
      if (seg.type === 'result') {
        entry.producedTokens +=
          Math.max(0, typeof seg.inputTokens === 'number' ? seg.inputTokens : 0) +
          Math.max(0, typeof seg.outputTokens === 'number' ? seg.outputTokens : 0)
      }
    }
  }

  return [...threadMap.entries()].map(([threadId, entry]) => ({
    threadId,
    nowMs,
    ...entry,
  }))
}

/**
 * Write a computed relevance score back to `chat_threads`.
 *
 * Both columns are updated atomically. A second call with the same `threadId`
 * overwrites the previous score.
 */
export async function persistRelevanceScore(
  client: DbClient,
  threadId: string,
  score: number,
  scoredAtMs: number,
): Promise<void> {
  await client.execute({
    sql: `UPDATE chat_threads
             SET relevance_score = ?, relevance_scored_at = ?
           WHERE id = ?`,
    args: [score, scoredAtMs, threadId],
  })
}

/**
 * Score every closed, non-archived Subject and persist the results.
 *
 * Uses a single `nowMs` snapshot so all scores in one pass are comparable.
 * When `nowMs` is omitted, `Date.now()` is captured once at the start of the
 * call.
 *
 * @returns The number of Subjects scored.
 */
export async function scoreAndPersistAllClosed(
  client: DbClient,
  nowMs: number = Date.now(),
): Promise<number> {
  const inputs = await readSubjectScoringInputs(client)
  for (const input of inputs) {
    // Override the nowMs captured inside readSubjectScoringInputs with the
    // caller-supplied snapshot so all scores use a consistent reference time.
    const score = scoreSubjectRelevance({ ...input, nowMs })
    await persistRelevanceScore(client, input.threadId, score, nowMs)
  }
  return inputs.length
}
