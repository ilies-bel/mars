/**
 * Compile-time pin for the {@link MergeResult} discriminated union.
 *
 * `merged: false` used to mean two different things — "did not merge, and here
 * is the handled reason" and "did not merge, reason unknown". Task
 * mars-abca7a1a spent 24 minutes rebasing and verifying before the merge worker
 * rejected its reasonless negative with `merge:unknown-outcome`, and the trace
 * recorded nothing else to act on.
 *
 * `reason` is now mandatory on the negative arm, so a path that cannot say why
 * it did not merge fails to COMPILE instead of reaching that runtime guard.
 * The `@ts-expect-error` directives below are the regression test for exactly
 * that: `tsc` reports an *unused* `@ts-expect-error` as an error, so widening
 * either arm back stops this file compiling and fails the required `typecheck`
 * gate. A plain runtime assertion could not catch it — by the time a test runs,
 * the types have already been erased.
 *
 * The runtime half of the net — the worker failing closed on a reasonless
 * `{ merged: false }` that reaches it from untyped code — stays covered by
 * `daemon/__tests__/merge-worker.test.ts` ("fail-closed, Fix 2").
 */
import { describe, it, expect } from 'vitest'
import type { MergeResult } from '../merge'

/** Fields both arms share, so each case below varies only the discriminant. */
const base = {
  conflictResolved: false,
  aborted: false,
  output: '',
  supervisorConversation: [],
  vegaSessionId: null,
  retriesAttempted: 0,
}

describe('MergeResult — every negative outcome names its reason', () => {
  it('rejects a merged:false that names no reason', () => {
    // @ts-expect-error -- `reason` is mandatory on the `merged: false` arm. An
    // "unused '@ts-expect-error' directive" error here means the union was
    // widened back and an unreasoned negative compiles again.
    const reasonless: MergeResult = { ...base, merged: false }

    expect(reasonless.reason).toBeUndefined()
  })

  it('accepts a merged:false that names one', () => {
    const reasoned: MergeResult = {
      ...base,
      merged: false,
      aborted: true,
      reason: 'integration-advanced',
    }

    expect(reasoned.reason).toBe('integration-advanced')
  })

  it('rejects a landed merge that claims a failure reason', () => {
    // @ts-expect-error -- the `merged: true` arm pins `reason?: undefined`, so a
    // success cannot smuggle in a failure reason and read as both at once.
    const contradictory: MergeResult = { ...base, merged: true, reason: 'vega-timeout' }

    expect(contradictory.merged).toBe(true)
  })
})
