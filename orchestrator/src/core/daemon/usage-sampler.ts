/**
 * Usage snapshot sampler — daemon periodic sweep.
 *
 * Starts a `setInterval` loop that fires every `MARS_USAGE_SAMPLE_SEC`
 * seconds (default 60) and inserts one row into `usage_snapshots`. The row
 * records the token totals computed by `summarizeUsage` over the current
 * window's Claude events. This gives the scheduler a data source without yet
 * gating anything on it.
 *
 * The returned interval handle should be `.unref()`-ed by the caller so the
 * timer never keeps the daemon process alive after shutdown, and should be
 * passed to `clearInterval` in the shutdown handler.
 */

import type { DbClient } from '../lib/db.js'
import { insertUsageSnapshot } from '../lib/usage-snapshot-store.js'
import { getAccumulatedTotals } from './usage-accumulator.js'

/**
 * Start the periodic usage sampler. Returns the interval handle for the
 * caller to `.unref()` and `clearInterval()` at shutdown.
 *
 * @param client - DB client to write snapshots into.
 * @param log    - Daemon log function (used on error only).
 */
export function startUsageSampler(
  client: DbClient,
  log: (line: string) => void,
  onSnapshotInserted?: () => void | Promise<void>,
): ReturnType<typeof setInterval> {
  const intervalSec = Number(process.env.MARS_USAGE_SAMPLE_SEC ?? 60)
  const intervalMs = Math.max(1, intervalSec) * 1000

  const sample = async (): Promise<void> => {
    try {
      // Read cumulative token totals from the in-memory accumulator. The
      // accumulator is fed by recordUsageEvent() from runWorkerWithSpan, which
      // knows each Worker's Provider and therefore WHERE usage rides that
      // provider's stream (assistant turns for Claude, one terminal
      // `turn.completed` for Codex).
      const totals = getAccumulatedTotals()
      await insertUsageSnapshot(
        {
          capturedAt: new Date().toISOString(),
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          windowKind: 'rolling',
          rawJson: {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheCreateTokens: totals.cacheCreateTokens,
            cacheReadTokens: totals.cacheReadTokens,
          },
        },
        client,
      )
      await onSnapshotInserted?.()
    } catch (err) {
      log(`[usage-sampler] errored: ${(err as Error).message}`)
    }
  }

  const handle = setInterval(() => {
    void sample()
  }, intervalMs)
  return handle
}
