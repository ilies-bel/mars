/**
 * "Token spend rose — here is what I think is causing it."
 *
 * Built on `usage_snapshots`, which the daemon already samples. Two equal
 * windows are compared: the recent one against the one immediately before it.
 * A single window has no meaning — spend is only interesting relative to the
 * operator's own baseline, not to an absolute number nobody could calibrate.
 */

import type { DbClient } from '../db.js'

export interface TokenSpendTrend {
  /** Percent change from the earlier window to the recent one, rounded. */
  changePct: number
  windowDays: number
  recentTokens: number
  priorTokens: number
}

export interface DetectTokenSpendTrendOptions {
  windowDays?: number
  /** Minimum rise worth speaking about. Below this, silence. */
  thresholdPct?: number
  /**
   * Minimum tokens in the earlier window before a ratio means anything.
   * Without this, 100 tokens becoming 400 reads as "up 300%" and Mars
   * announces noise on a quiet week.
   */
  minimumPriorTokens?: number
  now?: () => number
}

const DEFAULTS = {
  windowDays: 14,
  thresholdPct: 25,
  minimumPriorTokens: 250_000,
} as const

const sumWindow = async (
  c: DbClient,
  fromMs: number,
  toMs: number,
): Promise<number> => {
  const result = await c.execute({
    sql: `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
            FROM usage_snapshots
           WHERE captured_at >= to_timestamp(? / 1000.0)
             AND captured_at <  to_timestamp(? / 1000.0)`,
    args: [fromMs, toMs],
  })
  const total = (result.rows[0] as { total?: unknown } | undefined)?.total
  return Number(total ?? 0)
}

/**
 * Returns the trend when it is both real and large enough to act on, else
 * `null`. A *fall* in spend returns `null` too: it is good news, and good
 * news that interrupts is still an interruption.
 */
export const detectTokenSpendTrend = async (
  c: DbClient,
  options: DetectTokenSpendTrendOptions = {},
): Promise<TokenSpendTrend | null> => {
  const windowDays = options.windowDays ?? DEFAULTS.windowDays
  const thresholdPct = options.thresholdPct ?? DEFAULTS.thresholdPct
  const minimumPriorTokens = options.minimumPriorTokens ?? DEFAULTS.minimumPriorTokens
  const now = (options.now ?? Date.now)()
  const windowMs = windowDays * 24 * 60 * 60 * 1000

  const recentTokens = await sumWindow(c, now - windowMs, now)
  const priorTokens = await sumWindow(c, now - 2 * windowMs, now - windowMs)

  if (priorTokens < minimumPriorTokens) return null
  const changePct = Math.round(((recentTokens - priorTokens) / priorTokens) * 100)
  if (changePct < thresholdPct) return null

  return { changePct, windowDays, recentTokens, priorTokens }
}
