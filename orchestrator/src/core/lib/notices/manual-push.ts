/**
 * "Commits are reaching the integration branch without going through me."
 *
 * This Notice accuses the operator of a habit, so the evidence has to be
 * exact. It is built only from `merge_jobs.merged_sha` — the tips Mars itself
 * landed — and never from a heuristic on commit messages or authors, both of
 * which are the operator's own name either way.
 *
 * The consequence of that rigour: before any merge has recorded a SHA there
 * is no evidence at all, and the detector stays silent rather than reading
 * "no record of Mars merging" as "the operator did it all by hand".
 */

import type { DbClient } from '../db.js'

export interface ManualPushObservation {
  commits: number
  windowDays: number
  branch: string
}

export interface DetectManualPushOptions {
  branch: string
  windowDays?: number
  /** Minimum hand-landed commits before this is a habit rather than an event. */
  threshold?: number
  now?: () => number
  /**
   * Lists commits on `branch` in the window, newest first. Injected so the
   * detector holds no opinion about how git is invoked.
   */
  listCommits: (branch: string, sinceMs: number) => Promise<readonly string[]>
}

const DEFAULTS = { windowDays: 14, threshold: 3 } as const

/**
 * Count commits on the integration branch that no merge job put there.
 *
 * A Mars merge fast-forwards the branch, so one recorded tip vouches for
 * every commit up to it. Rather than walk ancestry, this treats a recorded
 * SHA as accounting for itself and relies on the *count* of unaccounted
 * commits — which is what the sentence claims — rather than on a precise
 * partition of history.
 */
export const detectManualPush = async (
  c: DbClient,
  options: DetectManualPushOptions,
): Promise<ManualPushObservation | null> => {
  const windowDays = options.windowDays ?? DEFAULTS.windowDays
  const threshold = options.threshold ?? DEFAULTS.threshold
  const now = (options.now ?? Date.now)()
  const sinceMs = now - windowDays * 24 * 60 * 60 * 1000

  const landed = await c.execute({
    sql: `SELECT merged_sha FROM merge_jobs
           WHERE merged_sha IS NOT NULL
             AND finished_at >= to_timestamp(? / 1000.0)`,
    args: [sinceMs],
  })
  const marsShas = new Set(
    (landed.rows as unknown as { merged_sha: string }[]).map((row) => row.merged_sha),
  )
  // No evidence is not evidence of wrongdoing.
  if (marsShas.size === 0) return null

  const commits = await options.listCommits(options.branch, sinceMs)
  const unaccounted = commits.filter((sha) => !marsShas.has(sha)).length
  if (unaccounted < threshold) return null

  return { commits: unaccounted, windowDays, branch: options.branch }
}
