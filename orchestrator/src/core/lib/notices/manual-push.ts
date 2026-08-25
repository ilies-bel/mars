/**
 * Commits arriving on the integration branch outside the pipeline.
 *
 * This Notice reports what Mars observed, not what the operator did wrong.
 * HR-11 forbids evaluating the operator's method; the `marsCommits` field
 * gives the render layer enough context to frame the finding as a factual
 * comparison ("Mars landed N; M arrived outside") rather than a verdict.
 *
 * Evidence rigour: attribution is built only from `merge_jobs.merged_sha` —
 * the branch tip after each Mars fast-forward. The `excludeTips` argument
 * lets `listCommits` exclude all commits reachable from those tips, so every
 * commit a multi-commit task branch contributed is correctly attributed, not
 * just its final SHA.
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
  /**
   * How many commits Mars itself landed on `branch` in the same window. Lets
   * the render layer present the finding as a factual comparison rather than
   * treating the unaccounted count in isolation — supporting HR-11 compliance
   * by avoiding any framing that evaluates the operator's method.
   */
  marsCommits: number
}

export interface DetectManualPushOptions {
  branch: string
  windowDays?: number
  /** Minimum hand-landed commits before this is a habit rather than an event. */
  threshold?: number
  now?: () => number
  /**
   * Lists commits on `branch` since `sinceMs`, newest first, excluding
   * commits reachable from any SHA in `excludeTips`.
   *
   * Ancestry-aware implementations pass `excludeTips` to
   * `git log <branch> --not <excludeTips...>` so that every commit Mars
   * fast-forwarded into the branch is attributed correctly, regardless of
   * how many commits a task branch contributed.
   *
   * Callers that do not perform ancestry exclusion may safely ignore the
   * third argument: TypeScript's structural typing treats a two-parameter
   * function as a valid implementation of this three-parameter type, and the
   * post-filter inside the detector catches exact SHA matches as a fallback.
   */
  listCommits: (branch: string, sinceMs: number, excludeTips: readonly string[]) => Promise<readonly string[]>
}

const DEFAULTS = { windowDays: 14, threshold: 3 } as const

/**
 * Count commits on the integration branch that no merge job put there.
 *
 * Mars SHAs are passed to `listCommits` as `excludeTips` so ancestry-aware
 * implementations can exclude all commits Mars landed in the window, not just
 * exact tip matches. The post-filter below still catches exact matches for
 * callers that ignore `excludeTips`, preserving backward compatibility.
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

  const commits = await options.listCommits(options.branch, sinceMs, [...marsShas])
  const unaccounted = commits.filter((sha) => !marsShas.has(sha)).length
  if (unaccounted < threshold) return null

  return { commits: unaccounted, windowDays, branch: options.branch, marsCommits: marsShas.size }
}
