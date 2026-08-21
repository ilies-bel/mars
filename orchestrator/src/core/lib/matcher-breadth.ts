/**
 * Matcher breadth — "how many past recorded failures would this matcher key
 * have fired on?"
 *
 * Self-improvement loops (learned recipes, self-heal rules, …) mint a
 * matcher key from one observed failure and then apply it to every future
 * occurrence. A key that is accidentally over-narrow — worded so specifically
 * that it only ever matches the single failure that minted it — looks
 * identical to a well-formed rule until someone counts how many past
 * failures it *would* have matched. `exact === 1` on a key that has been live
 * for a while is the tell.
 *
 * This module answers that question directly against `tasks.failure_signature`
 * history:
 * - `exact`  — rows whose raw signature equals the key verbatim.
 * - `family` — rows whose signature falls in the same family as the key, per
 *   {@link failureSignatureFamilySql} (same gate, same error class, looser on
 *   the step-name granularity that tends to vary wording-to-wording).
 *
 * A key seen once (exact 1) but whose family has three members (family 3)
 * means two other failures were worded differently but are the same
 * underlying problem — evidence the key should have been minted at the
 * family level, not the exact-string level.
 */

import { resolveStateClient } from '../store/state-client.js'
import { failureSignatureFamily, failureSignatureFamilySql } from './failure-signature.js'

/** Breadth of a matcher key: how many past failures it would have fired on. */
export interface MatcherBreadth {
  /** Count of past failures whose raw `failure_signature` equals the key. */
  exact: number
  /** Count of past failures whose signature falls in the key's family. */
  family: number
  /** The lookback window, in days, this count was computed over. */
  windowDays: number
}

/** Default lookback window for breadth queries, in days. */
export const DEFAULT_BREADTH_WINDOW_DAYS = 30

export interface MatcherBreadthOptions {
  /** Lookback window, in days. Defaults to {@link DEFAULT_BREADTH_WINDOW_DAYS}. */
  windowDays?: number
}

const emptyBreadth = (windowDays: number): MatcherBreadth => ({
  exact: 0,
  family: 0,
  windowDays,
})

/**
 * Batch form of {@link wouldHaveFiredOn}: runs a single query over the whole
 * failure history and computes breadth for every key in `signatures`, rather
 * than issuing one query per key.
 *
 * Returns a `Map` covering every input key (duplicates collapse), each keyed
 * by the exact signature string passed in.
 */
export const wouldHaveFiredOnMany = async (
  signatures: readonly string[],
  opts: MatcherBreadthOptions = {},
): Promise<Map<string, MatcherBreadth>> => {
  const windowDays = opts.windowDays ?? DEFAULT_BREADTH_WINDOW_DAYS
  const result = new Map<string, MatcherBreadth>()
  for (const signature of signatures) {
    result.set(signature, emptyBreadth(windowDays))
  }
  if (result.size === 0) return result

  const client = resolveStateClient()
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const familySql = failureSignatureFamilySql('failure_signature')
  const rows = await client.execute({
    sql: `SELECT failure_signature AS sig, ${familySql} AS family
            FROM tasks
           WHERE failure_signature IS NOT NULL
             AND updated_at >= ?`,
    args: [cutoff],
  })

  const exactCounts = new Map<string, number>()
  const familyCounts = new Map<string, number>()
  for (const row of rows.rows as unknown as { sig: string; family: string }[]) {
    exactCounts.set(row.sig, (exactCounts.get(row.sig) ?? 0) + 1)
    familyCounts.set(row.family, (familyCounts.get(row.family) ?? 0) + 1)
  }

  for (const signature of result.keys()) {
    const family = failureSignatureFamily(signature)
    result.set(signature, {
      exact: exactCounts.get(signature) ?? 0,
      family: familyCounts.get(family) ?? 0,
      windowDays,
    })
  }

  return result
}

/**
 * How many past recorded failures a matcher key would have fired on, both at
 * the exact-string level and the widened family level. See the module
 * doc-comment for how to read the result.
 */
export const wouldHaveFiredOn = async (
  signature: string,
  opts: MatcherBreadthOptions = {},
): Promise<MatcherBreadth> => {
  const result = await wouldHaveFiredOnMany([signature], opts)
  return result.get(signature) ?? emptyBreadth(opts.windowDays ?? DEFAULT_BREADTH_WINDOW_DAYS)
}
