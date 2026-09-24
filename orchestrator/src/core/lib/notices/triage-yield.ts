/**
 * "Triage is drowning — the action rate has collapsed."
 *
 * Same shape as the token-spend detector: two equal windows, the recent one
 * judged against the operator's own prior window rather than an absolute rate
 * nobody calibrated. Silent on a quiet month and on a rate that rose.
 */

import type { DbClient } from '../db.js'
import { computeActionRate } from '../proposal-yield.js'

export interface TriageYieldDrop {
  recentRatePct: number
  priorRatePct: number
  /** Percentage points lost from the prior window to the recent one. */
  dropPct: number
  recentCreated: number
  priorCreated: number
  windowDays: number
  /** Source with the most proposals created in the recent window. */
  topSource: string | null
}

export interface DetectTriageYieldDropOptions {
  windowDays?: number
  /** Minimum fall, in percentage points, worth speaking about. */
  thresholdDropPct?: number
  /** Recent-window volume floor; a low-volume month cannot trip the alarm. */
  minimumRecentCreated?: number
  now?: () => number
}

const DEFAULTS = {
  windowDays: 30,
  thresholdDropPct: 20,
  minimumRecentCreated: 60,
} as const

export const detectTriageYieldDrop = async (
  c: DbClient,
  options: DetectTriageYieldDropOptions = {},
): Promise<TriageYieldDrop | null> => {
  const windowDays = options.windowDays ?? DEFAULTS.windowDays
  const thresholdDropPct = options.thresholdDropPct ?? DEFAULTS.thresholdDropPct
  const minimumRecentCreated = options.minimumRecentCreated ?? DEFAULTS.minimumRecentCreated
  const now = (options.now ?? Date.now)()
  const windowMs = windowDays * 24 * 60 * 60 * 1000

  const recent = await computeActionRate(c, { fromMs: now - windowMs, toMs: now })
  if (recent.created < minimumRecentCreated) return null
  const prior = await computeActionRate(c, { fromMs: now - 2 * windowMs, toMs: now - windowMs })

  const dropPct = prior.ratePct - recent.ratePct
  if (dropPct < thresholdDropPct) return null

  // proposals.created_at is bigint epoch-ms, so compare it directly.
  const top = await c.execute({
    sql: `SELECT source, COUNT(*) AS n
            FROM proposals
           WHERE created_at >= ? AND created_at < ?
           GROUP BY source
           ORDER BY 2 DESC, source ASC
           LIMIT 1`,
    args: [now - windowMs, now],
  })
  const topSource = (top.rows[0] as { source?: unknown } | undefined)?.source

  return {
    recentRatePct: recent.ratePct,
    priorRatePct: prior.ratePct,
    dropPct,
    recentCreated: recent.created,
    priorCreated: prior.created,
    windowDays,
    topSource: topSource == null ? null : String(topSource),
  }
}
