/**
 * stale-queued-watchdog tests (ADR-0057 update).
 *
 * `runStaleQueuedSweep` is now a no-op stub: `stale-queued` rows are derived
 * on read from `tasks WHERE status='queued' AND age > threshold` by the
 * derivation layer.  This suite verifies the stub's no-op contract and that
 * exported constants still exist.
 */

import { describe, expect, it } from 'vitest'
import {
  runStaleQueuedSweep,
  DEFAULT_STALE_QUEUED_MS,
} from '../stale-queued-watchdog.js'

describe('runStaleQueuedSweep (ADR-0057 — derived kind)', () => {
  it('is a no-op that always returns { alerted: [] }', async () => {
    const result = await runStaleQueuedSweep({
      activeWorkerCount: 0,
      implementCap: 2,
      queueDepth: 5,
      dispatchDecisionSummary: [],
    })
    expect(result).toEqual({ alerted: [] })
  })

  it('DEFAULT_STALE_QUEUED_MS is 10 minutes', () => {
    expect(DEFAULT_STALE_QUEUED_MS).toBe(10 * 60_000)
  })
})
