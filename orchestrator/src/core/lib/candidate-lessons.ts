/**
 * Candidate-lesson store — under-corroborated inductions (ADR-0099).
 *
 * A single-arc deep-reflect suggestion that has not yet crossed the
 * corroboration floor (the skill-forge >=3-distinct-arc pattern) is not
 * thrown away: it accumulates here keyed by a fingerprint derived from its
 * root cause. Re-inducing the same lesson from a NEW arc grows
 * `observationCount` and appends the arc id; re-inducing it from an arc
 * already recorded is a no-op on the count and arc list (a repeat within the
 * same arc is not independent corroboration).
 *
 * All read/write goes through the shared state client (PGlite in tests,
 * embedded PG in production), the same seam `learned-recipes.ts` uses.
 */

import { resolveStateClient } from '../store/state-client.js'
import type { DbClient } from './db.js'

/** One candidate lesson: an induction still accumulating corroboration. */
export interface CandidateLesson {
  /** Stable fingerprint derived from the lesson's root cause. */
  fingerprint: string
  /** Short imperative title for the lesson. */
  title: string
  /** Full lesson body / rationale. */
  body: string
  /** Distinct arc ids that have induced this lesson, in first-seen order. */
  arcIds: string[]
  /** Number of distinct arcs that have induced this lesson. */
  observationCount: number
  /** ISO-8601 timestamp of the first observation. */
  firstSeenAt: string
  /** ISO-8601 timestamp of the most recent observation. */
  lastSeenAt: string
}

type CandidateLessonRow = {
  fingerprint: string
  title: string
  body: string
  arc_ids: string
  observation_count: number | string
  first_seen_at: string
  last_seen_at: string
}

const rowToCandidateLesson = (row: unknown): CandidateLesson => {
  const r = row as CandidateLessonRow
  return {
    fingerprint: r.fingerprint,
    title: r.title,
    body: r.body,
    arcIds: JSON.parse(r.arc_ids) as string[],
    observationCount: Number(r.observation_count),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  }
}

const fetchByFingerprint = async (
  client: DbClient,
  fingerprint: string,
): Promise<CandidateLesson | null> => {
  const result = await client.execute({
    sql: `SELECT fingerprint, title, body, arc_ids, observation_count, first_seen_at, last_seen_at
          FROM candidate_lessons WHERE fingerprint = ?`,
    args: [fingerprint],
  })
  if (result.rows.length === 0) return null
  return rowToCandidateLesson(result.rows[0])
}

/**
 * Record an observation of a candidate lesson. Upserts by fingerprint:
 * - no existing row → inserted with `observationCount: 1` and `arcIds: [arcId]`.
 * - existing row, `arcId` not yet recorded → `observationCount` incremented,
 *   `arcId` appended.
 * - existing row, `arcId` already recorded → `observationCount` and `arcIds`
 *   unchanged (title/body/`lastSeenAt` still refresh to the latest observation).
 */
export async function recordCandidateLesson(params: {
  fingerprint: string
  title: string
  body: string
  arcId: string
}): Promise<CandidateLesson> {
  const client = resolveStateClient()
  const now = new Date().toISOString()
  const existing = await fetchByFingerprint(client, params.fingerprint)

  if (existing === null) {
    await client.execute({
      sql: `INSERT INTO candidate_lessons
              (fingerprint, title, body, arc_ids, observation_count, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)`,
      args: [
        params.fingerprint,
        params.title,
        params.body,
        JSON.stringify([params.arcId]),
        now,
        now,
      ],
    })
    return {
      fingerprint: params.fingerprint,
      title: params.title,
      body: params.body,
      arcIds: [params.arcId],
      observationCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    }
  }

  const alreadyObserved = existing.arcIds.includes(params.arcId)
  const arcIds = alreadyObserved ? existing.arcIds : [...existing.arcIds, params.arcId]
  const observationCount = alreadyObserved
    ? existing.observationCount
    : existing.observationCount + 1

  await client.execute({
    sql: `UPDATE candidate_lessons
          SET title = ?, body = ?, arc_ids = ?, observation_count = ?, last_seen_at = ?
          WHERE fingerprint = ?`,
    args: [params.title, params.body, JSON.stringify(arcIds), observationCount, now, params.fingerprint],
  })

  return {
    fingerprint: params.fingerprint,
    title: params.title,
    body: params.body,
    arcIds,
    observationCount,
    firstSeenAt: existing.firstSeenAt,
    lastSeenAt: now,
  }
}

/**
 * List candidate lessons, most-observed first (`observationCount` desc).
 */
export async function listCandidateLessons(limit = 50): Promise<CandidateLesson[]> {
  const client = resolveStateClient()
  const result = await client.execute({
    sql: `SELECT fingerprint, title, body, arc_ids, observation_count, first_seen_at, last_seen_at
          FROM candidate_lessons
          ORDER BY observation_count DESC
          LIMIT ?`,
    args: [limit],
  })
  return result.rows.map(rowToCandidateLesson)
}
