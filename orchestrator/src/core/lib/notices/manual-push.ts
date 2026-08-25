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
  /**
   * Returns all SHAs reachable from `to` but not from `from`
   * (`git rev-list from..to`). When provided, the detector walks consecutive
   * pairs of merge-tip SHAs and attributes every intermediate commit to Mars,
   * not just the recorded tip SHA. Without this callback the detector falls
   * back to exact tip-SHA matching, which misattributes the non-tip commits
   * of a multi-commit task branch as unaccounted.
   */
  listCommitRange?: (from: string, to: string) => Promise<readonly string[]>
}

const DEFAULTS = { windowDays: 14, threshold: 3 } as const

/**
 * Count commits on the integration branch that no merge job put there.
 *
 * When `listCommitRange` is provided the detector walks consecutive pairs of
 * merge-tip SHAs (oldest-commit → first-tip, first-tip → second-tip, …) and
 * marks every SHA in each range as Mars-attributed. This correctly handles
 * multi-commit task branches where only the tip is recorded in `merge_jobs`.
 *
 * Without `listCommitRange` the detector falls back to exact tip-SHA matching
 * via the `marsShas` Set, preserving backward compatibility.
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
           WHERE status = 'done'
             AND merged_sha IS NOT NULL
             AND finished_at >= to_timestamp(? / 1000.0)
           ORDER BY finished_at ASC`,
    args: [sinceMs],
  })
  const orderedMarsShAs = (landed.rows as unknown as { merged_sha: string }[]).map(
    (row) => row.merged_sha,
  )
  const marsShas = new Set(orderedMarsShAs)
  // No evidence is not evidence of wrongdoing.
  if (marsShas.size === 0) return null

  const commits = await options.listCommits(options.branch, sinceMs, orderedMarsShAs)

  let unaccounted: number
  if (options.listCommitRange !== undefined && commits.length > 0) {
    // Walk consecutive pairs of merge tips to attribute every commit in a
    // multi-commit task branch, not just the recorded tip SHA.
    // The oldest commit from `listCommits` (last element, newest-first) is the
    // implicit lower bound before the first Mars merge in the window.
    const accounted = new Set(marsShas)
    const oldestCommit = commits[commits.length - 1]
    // froms[i] is the lower bound for orderedMarsShAs[i]:
    //   froms[0] = oldest commit in window
    //   froms[i] = orderedMarsShAs[i - 1] for i > 0
    const froms = [oldestCommit, ...orderedMarsShAs.slice(0, -1)]
    for (let i = 0; i < orderedMarsShAs.length; i++) {
      const range = await options.listCommitRange(froms[i], orderedMarsShAs[i])
      for (const sha of range) accounted.add(sha)
    }
    unaccounted = commits.filter((sha) => !accounted.has(sha)).length
  } else {
    unaccounted = commits.filter((sha) => !marsShas.has(sha)).length
  }

  if (unaccounted < threshold) return null
  return { commits: unaccounted, windowDays, branch: options.branch, marsCommits: marsShas.size }
}
